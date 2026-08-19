const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const ReconSend = require('../models/ReconSend');
const { billableFilter, periodBounds, londonDay, round2, money, VAT_RATE, LOOKBACK_DAYS, dispositionStats } = require('./invoiceService');
const { buildAffiliateWorkbook } = require('./reconExcel');

const ddmmyyyyFromDay = (day) => day.split('-').reverse().join('/');

function reconEmail({ affiliate, day, counts, amounts, dispo }) {
  const dateStr = ddmmyyyyFromDay(day);
  const net = round2(amounts.full + amounts.part);
  const vat = round2(net * VAT_RATE);
  const gross = round2(net + vat);
  const subject = `Daily Lead Reconciliation – ${affiliate.name} – ${dateStr}`;
  const text = `Hi ${affiliate.contact_name || affiliate.name},

Please find below your daily lead reconciliation for leads processed on ${dateStr}.
It confirms the figures currently recorded in our system so that you can prepare and submit your invoice to Kickbyte Media Ltd.

KICKBYTE MEDIA LTD
71-75 Shelton Street, Covent Garden, London, United Kingdom, WC2H 9JQ
VAT Registration No.: 511270734
Company Registration No. 16487857

Lead Summary

Leads supplied on ${dateStr}:
- Total Leads Received: ${dispo.received}
- Rejected at Intake: ${dispo.rejected}
- Awaiting Acceptance: ${dispo.awaiting}
- Accepted: ${dispo.accepted}

Payable in this reconciliation:
- Fully Payable Leads: ${counts.full} × £${money(amounts.fullRate)} = £${money(amounts.full)}
- Part-Payable Leads: ${counts.part} × £${money(amounts.partRate)} = £${money(amounts.part)}

Updates on ${dateStr} (may relate to previously supplied leads):
- Signature Failures: ${dispo.signature_fails}
- Cancellations (14-Day Cooling-Off): ${dispo.cancellations}
- Replacements Supplied: ${dispo.replacements_supplied}

Total Accepted Leads: ${counts.full + counts.part}
Net Amount: £${money(net)}
VAT at 20%: £${money(vat)}
Total Including VAT: £${money(gross)}

Please use the above figures when preparing your invoice to Kickbyte Media Ltd.
A detailed breakdown is included in the attached Excel reconciliation workbook, including:

- All payable leads included in the figures above.
- Any signature replacements currently required.
- Any replacements required because a client cancelled within the 14-day cooling-off period.
- Any replacements already supplied and matched to the original lead.
- Any leads that become fully payable after lender check.

Signature replacements must be supplied within 72 hours of notification.

If you believe any of the figures or replacement requirements are incorrect, please contact us before submitting your invoice.

Kind regards,
Kickbyte Media Ltd (Trading as Click2Leads)
`;
  const html = text
    .split('\n\n')
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return { subject, text, html };
}

async function buildAffiliateRecons(now = new Date()) {
  const affiliates = await Affiliate.find({ active: true }).lean();
  const out = [];

  for (let n = LOOKBACK_DAYS; n >= 1; n -= 1) {
    const day = londonDay(new Date(now.getTime() - n * 24 * 3600 * 1000));
    const bounds = periodBounds(day);

    for (const a of affiliates) {
      if (await ReconSend.findOne({ affiliate_id: a._id, day })) continue;

      const dayLeads = await Lead.find({ ...billableFilter(bounds), affiliate_id: a._id })
        .sort({ submitted_at: 1 }).lean();
      const newObligations = await Lead.countDocuments({
        affiliate_id: a._id, replacement_status: 'required',
        replacement_requested_at: { $gte: bounds.start, $lt: bounds.end },
      });
      const dispo = await dispositionStats(bounds, { affiliate_id: a._id });
      const dispoActivity = Object.values(dispo.counts).some(Boolean);
      if (!dayLeads.length && !newObligations && !dispoActivity) continue;
      if (!a.contact_email) {
        console.warn(`recon: affiliate ${a.name} has activity but no contact_email — skipped`);
        continue;
      }

      // Statement tabs cover the affiliate's FULL history (bank-statement
      // model, client spec 2026-08-19) — replacements, rejects and cancels
      // all appear there regardless of which day's recon this is.
      const statementLeads = await Lead.find({ affiliate_id: a._id }).sort({ submitted_at: 1 })
        .populate('replaces_lead', 'ref').populate('replaced_by_lead', 'ref').lean();
      const confirmedLeads = await Lead.find({
        affiliate_id: a._id, payable_status: 'payable_full',
        last_updated: { $gte: bounds.start, $lt: bounds.end },
      }).lean();

      const rc = a.rate_card || {};
      const counts = {
        full: dayLeads.filter((l) => l.search_status === 'virgin').length,
        part: dayLeads.filter((l) => l.search_status === 'searched').length,
      };
      const amounts = {
        fullRate: rc.virgin_rate || 0, partRate: rc.searched_upfront_rate || 0,
        full: round2(counts.full * (rc.virgin_rate || 0)),
        part: round2(counts.part * (rc.searched_upfront_rate || 0)),
      };
      const { subject, text, html } = reconEmail({ affiliate: a, day, counts, amounts, dispo: dispo.counts });
      const xlsx = await buildAffiliateWorkbook({
        affiliate: a, dayLeads, confirmedLeads, statementLeads,
      });
      out.push({ affiliate_id: a._id, name: a.name, to: a.contact_email, day, subject, text, html, xlsx });
    }
  }
  return out;
}

module.exports = { buildAffiliateRecons };
