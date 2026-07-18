const ExcelJS = require('exceljs');
const { PAY_LABELS, LINE_VIRGIN, LINE_SEARCHED, bluelionRates } = require('./invoiceService');

// same guard as exportRoutes: neutralise spreadsheet formula prefixes
const safe = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};
const iso = (d) => (d ? new Date(d).toISOString() : '');
const category = (l) => (l.search_status === 'virgin' ? LINE_VIRGIN : LINE_SEARCHED);

function sheet(wb, name, columns) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map((c) => ({ header: c[0], key: c[0], width: c[1] }));
  ws.getRow(1).font = { bold: true };
  return ws;
}

async function buildBlueLionWorkbook(leads) {
  const rates = bluelionRates();
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'Leads', [
    ['Lead Reference', 20], ['Submission Date', 22], ['Affiliate', 18], ['Search Status', 14],
    ['Payment Status', 28], ['Invoice Category', 34], ['Invoice Value', 13],
  ]);
  const byAff = new Map();
  for (const l of leads) {
    const name = l.affiliate_id?.name || 'unknown';
    ws.addRow([safe(l.ref), iso(l.submitted_at), safe(name), l.search_status,
      PAY_LABELS[l.payable_status] || l.payable_status, category(l),
      l.search_status === 'virgin' ? rates.virgin : rates.searched]);
    const a = byAff.get(name) || { virgin: 0, searched: 0 };
    a[l.search_status] += 1;
    byAff.set(name, a);
  }
  const sum = sheet(wb, 'Affiliate Summary', [['Affiliate', 24], ['Non Search', 12], ['Previous Search', 15], ['Total', 10]]);
  let tv = 0, ts = 0;
  for (const [name, a] of [...byAff.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    sum.addRow([safe(name), a.virgin, a.searched, a.virgin + a.searched]);
    tv += a.virgin; ts += a.searched;
  }
  const totalRow = sum.addRow(['TOTAL', tv, ts, tv + ts]);
  totalRow.font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const H72 = 72 * 3600 * 1000;

async function buildAffiliateWorkbook({ affiliate, dayLeads, openReplacements, suppliedReplacements, confirmedLeads }) {
  const rc = affiliate.rate_card || {};
  const wb = new ExcelJS.Workbook();

  const pay = sheet(wb, 'Payable Leads', [
    ['Lead Reference', 20], ['Submission Date', 22], ['Search Status', 14],
    ['Payment Status', 28], ['Invoice Category', 34], ['Value', 10],
  ]);
  for (const l of dayLeads) {
    pay.addRow([safe(l.ref), iso(l.submitted_at), l.search_status,
      PAY_LABELS[l.payable_status] || l.payable_status, category(l),
      l.search_status === 'virgin' ? rc.virgin_rate || 0 : rc.searched_upfront_rate || 0]);
  }

  const req = sheet(wb, 'Replacements Required', [
    ['Lead Reference', 20], ['Reason', 14], ['Requested At', 22], ['Replace By (72h)', 22],
  ]);
  for (const l of openReplacements) {
    req.addRow([safe(l.ref), l.replacement_reason || 'signature', iso(l.replacement_requested_at),
      l.replacement_requested_at ? new Date(new Date(l.replacement_requested_at).getTime() + H72).toISOString() : '']);
  }

  const sup = sheet(wb, 'Replacements Supplied', [
    ['Original Lead', 20], ['Replacement Lead', 20], ['Reason', 14], ['Requested At', 22],
  ]);
  for (const l of suppliedReplacements) {
    sup.addRow([safe(l.ref), safe(l.replaced_by_lead?.ref || ''), l.replacement_reason || 'signature', iso(l.replacement_requested_at)]);
  }

  const conf = sheet(wb, 'Confirmed After Lender Check', [
    ['Lead Reference', 20], ['Submission Date', 22], ['Payment Status', 28],
  ]);
  for (const l of confirmedLeads) {
    conf.addRow([safe(l.ref), iso(l.submitted_at), PAY_LABELS[l.payable_status] || l.payable_status]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildBlueLionWorkbook, buildAffiliateWorkbook };
