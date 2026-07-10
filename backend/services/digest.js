const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const { buildLeadFilter } = require('./leadFilter');

const gbp = (n) => `£${(n || 0).toFixed(2)}`;
const is = (field, val) => ({ $cond: [{ $eq: [`$${field}`, val] }, 1, 0] });
const ADMIN = { role: 'admin' };

// Calendar date string in Europe/London for a given instant (en-CA = YYYY-MM-DD)
const londonDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);

/** Build the daily digest for the day before `now`. Returns { subject, text }. */
async function buildDigest(now = new Date()) {
  const yesterday = londonDay(new Date(now.getTime() - 24 * 3600 * 1000));
  const monthStart = `${yesterday.slice(0, 7)}-01`;
  const yMatch = buildLeadFilter({ from: yesterday, to: yesterday }, ADMIN);
  const mMatch = buildLeadFilter({ from: monthStart, to: yesterday }, ADMIN);

  const [byAff, [month], [attention]] = await Promise.all([
    Lead.aggregate([
      { $match: yMatch },
      {
        $group: {
          _id: '$affiliate_id',
          submitted: { $sum: 1 },
          accepted: { $sum: is('initial_status', 'accepted') },
          rejected: { $sum: is('initial_status', 'rejected') },
          due: { $sum: '$amounts.total_due' },
        },
      },
      { $sort: { submitted: -1 } },
    ]),
    Lead.aggregate([
      { $match: mMatch },
      { $group: { _id: null, submitted: { $sum: 1 }, due: { $sum: '$amounts.total_due' } } },
    ]),
    Lead.aggregate([
      { $match: buildLeadFilter({}, ADMIN) },
      {
        $group: {
          _id: null,
          overdue_signature: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$initial_status', 'accepted'] },
                    { $eq: ['$signature_status', 'pending'] },
                    { $eq: [{ $type: '$signature_deadline' }, 'date'] },
                    { $lt: ['$signature_deadline', '$$NOW'] },
                  ],
                },
                1, 0,
              ],
            },
          },
          needs_replacement: {
            $sum: { $cond: [{ $and: [{ $eq: ['$needs_replacement', true] }, { $not: ['$replaced_by_lead'] }] }, 1, 0] },
          },
          awaiting_confirmation: { $sum: is('payable_status', 'partial_pending_confirmation') },
          possible_duplicates: { $sum: { $cond: [{ $eq: ['$possible_duplicate', true] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const names = new Map(
    (await Affiliate.find({ _id: { $in: byAff.map((r) => r._id) } }).select('name').lean())
      .map((a) => [a._id.toString(), a.name])
  );

  const totals = byAff.reduce(
    (t, r) => ({ submitted: t.submitted + r.submitted, accepted: t.accepted + r.accepted, rejected: t.rejected + r.rejected, due: t.due + r.due }),
    { submitted: 0, accepted: 0, rejected: 0, due: 0 }
  );

  const dayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(`${yesterday}T12:00:00Z`));

  const lines = [];
  lines.push(`PCP Affiliate Dashboard — daily digest for ${dayLabel}`);
  lines.push('');
  if (totals.submitted === 0) {
    lines.push('No leads were submitted yesterday.');
  } else {
    lines.push(`Yesterday: ${totals.submitted} submitted · ${totals.accepted} accepted · ${totals.rejected} rejected · ${gbp(totals.due)} due`);
    lines.push('');
    lines.push('By affiliate:');
    for (const r of byAff) {
      lines.push(`- ${names.get(r._id.toString()) || 'unknown'}: ${r.submitted} submitted, ${r.accepted} accepted, ${gbp(r.due)} due`);
    }
  }
  lines.push('');
  const m = month || { submitted: 0, due: 0 };
  lines.push(`Month to date: ${m.submitted} submitted · ${gbp(m.due)} due`);
  lines.push('');
  const at = attention || {};
  const attnParts = [
    at.overdue_signature > 0 && `- ${at.overdue_signature} signature check${at.overdue_signature === 1 ? '' : 's'} overdue`,
    at.needs_replacement > 0 && `- ${at.needs_replacement} replacement${at.needs_replacement === 1 ? '' : 's'} needed`,
    at.awaiting_confirmation > 0 && `- ${at.awaiting_confirmation} part-paid — awaiting law firm`,
    at.possible_duplicates > 0 && `- ${at.possible_duplicates} possible duplicate${at.possible_duplicates === 1 ? '' : 's'}`,
  ].filter(Boolean);
  if (attnParts.length) {
    lines.push('Needs attention now:');
    lines.push(...attnParts);
  } else {
    lines.push('Nothing needs attention.');
  }
  lines.push('');
  lines.push('Dashboard: https://leads.click2leads.co.uk');

  const subject = totals.submitted === 0
    ? `PCP leads digest — ${dayLabel}: no leads`
    : `PCP leads digest — ${dayLabel}: ${totals.submitted} submitted, ${totals.accepted} accepted, ${gbp(totals.due)} due`;

  return { subject, text: lines.join('\n') };
}

module.exports = { buildDigest };
