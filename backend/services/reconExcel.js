const ExcelJS = require('exceljs');
const { PAY_LABELS, LINE_VIRGIN, LINE_SEARCHED, LINE_CONFIRMATION, bluelionRates, confirmationRate, ddmmyyyy } = require('./invoiceService');

// same guard as exportRoutes: neutralise spreadsheet formula prefixes
const safe = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};
// client-facing date cells: dd/mm/yyyy Europe/London, not a raw ISO timestamp
const ukDate = (d) => (d ? ddmmyyyy(new Date(d)) : '');
const category = (l) => (l.search_status === 'virgin' ? LINE_VIRGIN : LINE_SEARCHED);
// 'unknown' search_status is neither billable nor summarisable — drop it here so every
// tab built from a lead list reconciles regardless of what the caller passed in.
const knownStatus = (l) => l.search_status === 'virgin' || l.search_status === 'searched';

function sheet(wb, name, columns) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map((c) => ({ header: c[0], key: c[0], width: c[1] }));
  ws.getRow(1).font = { bold: true };
  return ws;
}

// JS mirror of invoiceService.billableFilter — keep the two in sync. Lets the
// Leads tab list EVERY lead of the period (client rule Aug 20: cancelled,
// rejected, part-paid all visible) while pricing only the billable ones.
const isBillable = (l) => l.initial_status === 'accepted' && !l.cancelled
  && l.signature_status !== 'failed' && !l.replaced_by_lead && knownStatus(l);
const statusLabel = (l) => {
  if (l.initial_status === 'rejected') return 'Rejected at intake';
  if (l.cancelled) return 'Cancelled (cooling-off)';
  if (l.signature_status === 'failed') return 'Signature failed';
  return PAY_LABELS[l.payable_status] || l.payable_status;
};

async function buildBlueLionWorkbook(allLeads, statement = null) {
  const rates = bluelionRates();
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'Leads', [
    ['Lead Reference', 20], ['Submission Date', 22], ['Affiliate', 18], ['Search Status', 14],
    ['Payment Status', 28], ['Invoice Category', 34], ['Invoice Value', 13],
  ]);
  const byAff = new Map();
  for (const l of allLeads) {
    const name = l.affiliate_id?.name || 'unknown';
    const id = String(l.affiliate_id?._id ?? l.affiliate_id ?? 'unknown');
    const billable = isBillable(l);
    ws.addRow([safe(l.ref), ukDate(l.submitted_at), safe(name), l.search_status,
      statusLabel(l), billable ? category(l) : '',
      billable ? (l.search_status === 'virgin' ? rates.virgin : rates.searched) : '']);
    if (!billable) continue;
    const a = byAff.get(id) || { name, virgin: 0, searched: 0 };
    a[l.search_status] += 1;
    byAff.set(id, a);
  }
  const sum = sheet(wb, 'Affiliate Summary', [['Affiliate', 24], ['Non Search', 12], ['Previous Search', 15], ['Total', 10]]);
  let tv = 0, ts = 0;
  for (const a of [...byAff.values()].sort((x, y) => x.name.localeCompare(y.name))) {
    sum.addRow([safe(a.name), a.virgin, a.searched, a.virgin + a.searched]);
    tv += a.virgin; ts += a.searched;
  }
  const totalRow = sum.addRow(['TOTAL', tv, ts, tv + ts]);
  totalRow.font = { bold: true };
  if (statement) addStatementTabs(wb, statement.leads, statement.rates, { includeAffiliate: true });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Bank-statement tabs (client spec 2026-08-19): per-day cohort summary, the
// open replacement debt, cohort cancellations, and a date-ordered transaction
// ledger with running balances. `statementLeads` is the party's FULL lead
// history (all time), sorted by submitted_at, with replaces_lead /
// replaced_by_lead refs populated. `rates` = {virgin, searched} at the
// receiving party's prices. ponytail: full-history scan per send — revisit
// with a date floor if lead volume ever makes these workbooks slow/huge.
const H72 = 72 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

function addStatementTabs(wb, statementLeads, rates, { includeAffiliate = false } = {}) {
  const aff = (l) => safe(l.affiliate_id?.name || 'unknown');
  const affCol = includeAffiliate ? [['Affiliate', 18]] : [];
  const affCell = (l) => (includeAffiliate ? [aff(l)] : []);
  const rate = (l) => (l.search_status === 'virgin' ? rates.virgin : rates.searched);
  const isAccepted = (l) => l.initial_status === 'accepted';
  const isSigFail = (l) => l.signature_status === 'failed';
  const dayOf = (l) => ukDate(l.submitted_at);

  // Tab: Daily Supply — one row per supply day; failures attributed to the
  // day their lead was supplied (cohort view), not the day they happened.
  const days = new Map();
  for (const l of statementLeads) {
    const d = days.get(dayOf(l)) || {
      at: new Date(l.submitted_at), supplied: 0, virgin: 0, searched: 0,
      rejects: 0, sigFails: 0, notReplaced: 0, cancels: 0,
    };
    d.supplied += 1;
    if (isAccepted(l) && l.search_status === 'virgin') d.virgin += 1;
    if (isAccepted(l) && l.search_status === 'searched') d.searched += 1;
    if (l.initial_status === 'rejected') d.rejects += 1;
    if (isSigFail(l)) {
      d.sigFails += 1;
      if (l.replacement_status === 'required') d.notReplaced += 1;
    }
    if (l.cancelled) d.cancels += 1;
    days.set(dayOf(l), d);
  }
  const daily = sheet(wb, 'Daily Supply', [
    ['Date', 14], ['Supplied', 10], ['Accepted (Virgin)', 16], ['Accepted (Prev Search)', 20],
    ['Intake Rejects', 14], ['72h Sig Fails', 13], ['Not Replaced', 13], ['14-Day Cancels', 15],
    ['Net Good Leads', 15],
  ]);
  for (const [date, d] of [...days.entries()].sort((a, b) => a[1].at - b[1].at)) {
    daily.addRow([date, d.supplied, d.virgin, d.searched, d.rejects, d.sigFails, d.notReplaced,
      d.cancels, d.virgin + d.searched - d.sigFails - d.cancels]);
  }

  // Tab: 72h Rejects Not Replaced — the outstanding replacement debt.
  const owedTab = sheet(wb, '72h Rejects Not Replaced', [
    ['Lead Reference', 20], ...affCol, ['Supplied On', 14], ['Failed On', 14],
    ['Replace By (72h)', 16], ['Days Overdue', 13],
  ]);
  for (const l of statementLeads) {
    if (l.replacement_status !== 'required') continue;
    if (l.replacement_reason && l.replacement_reason !== 'signature') continue;
    const deadline = l.replacement_requested_at ? new Date(l.replacement_requested_at).getTime() + H72 : null;
    owedTab.addRow([safe(l.ref), ...affCell(l), dayOf(l), ukDate(l.replacement_requested_at),
      deadline ? ukDate(deadline) : '', deadline ? Math.max(0, Math.floor((Date.now() - deadline) / DAY)) : '']);
  }

  // Tab: 14-Day Cancellations
  const canTab = sheet(wb, '14-Day Cancellations', [
    ['Lead Reference', 20], ...affCol, ['Supplied On', 14], ['Cancelled On', 14],
    ['Replaced?', 10], ['Replacement Ref', 20],
  ]);
  for (const l of statementLeads) {
    if (!l.cancelled) continue;
    const replaced = ['supplied', 'closed'].includes(l.replacement_status);
    canTab.addRow([safe(l.ref), ...affCell(l), dayOf(l), ukDate(l.cancelled_at),
      replaced ? 'Yes' : 'No', safe(l.replaced_by_lead?.ref || '')]);
  }

  // Tab: Transactions — every in/out in date order with running balances.
  const events = [];
  for (const l of statementLeads) {
    if (isAccepted(l)) {
      events.push({
        at: new Date(l.submitted_at), ref: l.ref,
        type: l.replaces_lead ? `Replacement supplied (for ${l.replaces_lead.ref || 'unknown'})` : 'Supplied',
        inn: 1, out: 0, value: rate(l), owedDelta: l.replaces_lead ? -1 : 0, lead: l,
      });
    }
    if (isSigFail(l)) {
      events.push({
        at: new Date(l.replacement_requested_at || l.last_updated || l.submitted_at), ref: l.ref,
        type: 'Signature failed', inn: 0, out: 1, value: -rate(l), owedDelta: 1, lead: l,
      });
    }
    if (l.cancelled) {
      events.push({
        at: new Date(l.cancelled_at || l.last_updated), ref: l.ref,
        type: 'Cancelled (cooling-off)', inn: 0, out: 1, value: -rate(l), owedDelta: 1, lead: l,
      });
    }
  }
  events.sort((a, b) => a.at - b.at);
  const tx = sheet(wb, 'Transactions', [
    ['Date', 14], ['Lead Reference', 20], ...affCol, ['Event', 34], ['In', 6], ['Out', 6],
    ['Value £', 10], ['Net Good Leads', 15], ['Replacements Owed', 18],
  ]);
  let net = 0, owed = 0;
  for (const e of events) {
    net += e.inn - e.out;
    owed = Math.max(0, owed + e.owedDelta);
    tx.addRow([ukDate(e.at), safe(e.ref), ...affCell(e.lead), e.type,
      e.inn || '', e.out || '', e.value, net, owed]);
  }
  const closing = tx.addRow(['CLOSING BALANCE', '', ...(includeAffiliate ? [''] : []), '', '', '', '', net, owed]);
  closing.font = { bold: true };
}

// Recon for a confirmation invoice: every row is a lender-confirmed claim at
// the flat confirmation rate — the daily workbook's per-search-status pricing
// would show the wrong figures here.
async function buildConfirmationWorkbook(leads) {
  const rate = confirmationRate();
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'Confirmed Claims', [
    ['Lead Reference', 20], ['Submission Date', 22], ['Confirmed Date', 22], ['Affiliate', 18],
    ['Invoice Category', 34], ['Invoice Value', 13],
  ]);
  const byAff = new Map();
  for (const l of leads) {
    const name = l.affiliate_id?.name || 'unknown';
    ws.addRow([safe(l.ref), ukDate(l.submitted_at), ukDate(l.payable_full_at), safe(name), LINE_CONFIRMATION, rate]);
    byAff.set(name, (byAff.get(name) || 0) + 1);
  }
  const sum = sheet(wb, 'Affiliate Summary', [['Affiliate', 24], ['Confirmed Claims', 16], ['Total £', 12]]);
  let total = 0;
  for (const [name, n] of [...byAff.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    sum.addRow([safe(name), n, n * rate]);
    total += n;
  }
  const totalRow = sum.addRow(['TOTAL', total, total * rate]);
  totalRow.font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function buildAffiliateWorkbook({ affiliate, dayLeads, confirmedLeads, statementLeads = [] }) {
  const rc = affiliate.rate_card || {};
  const wb = new ExcelJS.Workbook();

  const pay = sheet(wb, 'Payable Leads', [
    ['Lead Reference', 20], ['Submission Date', 22], ['Search Status', 14],
    ['Payment Status', 28], ['Invoice Category', 34], ['Value', 10],
  ]);
  for (const l of dayLeads.filter(knownStatus)) {
    pay.addRow([safe(l.ref), ukDate(l.submitted_at), l.search_status,
      PAY_LABELS[l.payable_status] || l.payable_status, category(l),
      l.search_status === 'virgin' ? rc.virgin_rate || 0 : rc.searched_upfront_rate || 0]);
  }

  addStatementTabs(wb, statementLeads, {
    virgin: rc.virgin_rate || 0, searched: rc.searched_upfront_rate || 0,
  });

  const conf = sheet(wb, 'Confirmed After Lender Check', [
    ['Lead Reference', 20], ['Submission Date', 22], ['Payment Status', 28],
  ]);
  for (const l of confirmedLeads) {
    conf.addRow([safe(l.ref), ukDate(l.submitted_at), PAY_LABELS[l.payable_status] || l.payable_status]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildBlueLionWorkbook, buildConfirmationWorkbook, buildAffiliateWorkbook };
