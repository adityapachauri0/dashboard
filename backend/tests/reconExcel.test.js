const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { buildBlueLionWorkbook, buildAffiliateWorkbook } = require('../services/reconExcel');

const lead = (over = {}) => ({
  ref: 'KB-2026-000001', submitted_at: new Date('2026-07-18T10:00:00Z'),
  affiliate_id: { _id: 'aff-claim3000', name: 'Claim3000', rate_card: { virgin_rate: 40, searched_upfront_rate: 15 } },
  search_status: 'virgin', payable_status: 'payable', ...over,
});

async function load(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

test('bluelion workbook: lead rows, category, affiliate summary with totals', async () => {
  const buf = await buildBlueLionWorkbook([
    lead(), lead({ ref: 'KB-2026-000002', search_status: 'searched', payable_status: 'partial_pending_confirmation' }),
    lead({ ref: 'KB-2026-000003', affiliate_id: { name: 'Acme' } }),
  ]);
  const wb = await load(buf);
  const leads = wb.getWorksheet('Leads');
  assert.strictEqual(leads.rowCount, 4); // header + 3
  assert.strictEqual(leads.getRow(2).getCell(6).value, 'PCP Claim Accepted Not Searched');
  assert.strictEqual(leads.getRow(3).getCell(7).value, 30); // searched at BlueLion rate
  const summary = wb.getWorksheet('Affiliate Summary');
  const rows = [];
  summary.eachRow((r) => rows.push(r.values.slice(1)));
  assert.deepStrictEqual(rows[0], ['Affiliate', 'Non Search', 'Previous Search', 'Total']);
  assert.ok(rows.some((r) => r[0] === 'Claim3000' && r[1] === 1 && r[2] === 1 && r[3] === 2));
  assert.deepStrictEqual(rows.at(-1), ['TOTAL', 2, 1, 3]);
});

test('affiliate workbook: four tabs, affiliate rates, 72h deadline', async () => {
  const requested = new Date('2026-07-18T09:00:00Z');
  const buf = await buildAffiliateWorkbook({
    affiliate: { name: 'Claim3000', rate_card: { virgin_rate: 40, searched_upfront_rate: 15 } },
    dayLeads: [lead(), lead({ ref: 'KB-2026-000002', search_status: 'searched' })],
    openReplacements: [lead({ ref: 'KB-2026-000009', replacement_reason: 'cooling_off', replacement_requested_at: requested })],
    suppliedReplacements: [lead({ ref: 'KB-2026-000010', replaced_by_lead: { ref: 'KB-2026-000011' } })],
    confirmedLeads: [lead({ ref: 'KB-2026-000012', payable_status: 'payable_full' })],
  });
  const wb = await load(buf);
  for (const name of ['Payable Leads', 'Replacements Required', 'Replacements Supplied', 'Confirmed After Lender Check']) {
    assert.ok(wb.getWorksheet(name), `missing tab ${name}`);
  }
  const pay = wb.getWorksheet('Payable Leads');
  assert.strictEqual(pay.getRow(2).getCell(6).value, 40);  // virgin at affiliate rate
  assert.strictEqual(pay.getRow(3).getCell(6).value, 15);  // searched at affiliate rate
  const req = wb.getWorksheet('Replacements Required');
  assert.strictEqual(req.getRow(2).getCell(2).value, 'cooling_off');
  assert.strictEqual(req.getRow(2).getCell(4).value, '21/07/2026'); // dd/mm/yyyy Europe/London
  const sup = wb.getWorksheet('Replacements Supplied');
  assert.strictEqual(sup.getRow(2).getCell(2).value, 'KB-2026-000011');
});

test('bluelion workbook: unknown search_status excluded from Leads and Affiliate Summary', async () => {
  const buf = await buildBlueLionWorkbook([
    lead(),
    lead({ ref: 'KB-2026-000002', search_status: 'unknown' }),
  ]);
  const wb = await load(buf);
  const leads = wb.getWorksheet('Leads');
  assert.strictEqual(leads.rowCount, 2); // header + 1 (unknown excluded)
  const summary = wb.getWorksheet('Affiliate Summary');
  const rows = [];
  summary.eachRow((r) => rows.push(r.values.slice(1)));
  assert.deepStrictEqual(rows.at(-1), ['TOTAL', 1, 0, 1]);
});

test('affiliate workbook: unknown search_status excluded from Payable Leads', async () => {
  const buf = await buildAffiliateWorkbook({
    affiliate: { name: 'Claim3000', rate_card: { virgin_rate: 40, searched_upfront_rate: 15 } },
    dayLeads: [lead(), lead({ ref: 'KB-2026-000002', search_status: 'unknown' })],
    openReplacements: [], suppliedReplacements: [], confirmedLeads: [],
  });
  const wb = await load(buf);
  const pay = wb.getWorksheet('Payable Leads');
  assert.strictEqual(pay.rowCount, 2); // header + 1 (unknown excluded)
});

test('bluelion workbook: affiliate summary grouped by id, not display name', async () => {
  const buf = await buildBlueLionWorkbook([
    lead({ affiliate_id: { _id: 'aff1', name: 'Claim3000' } }),
    lead({ ref: 'KB-2026-000002', affiliate_id: { _id: 'aff2', name: 'Claim3000' } }),
  ]);
  const wb = await load(buf);
  const summary = wb.getWorksheet('Affiliate Summary');
  const rows = [];
  summary.eachRow((r) => rows.push(r.values.slice(1)));
  const claim3000Rows = rows.filter((r) => r[0] === 'Claim3000');
  assert.strictEqual(claim3000Rows.length, 2);
});

test('formula injection neutralised in text cells', async () => {
  const buf = await buildBlueLionWorkbook([lead({ ref: '=HYPERLINK("http://x")', affiliate_id: { name: '+SUM(A1)' } })]);
  const wb = await load(buf);
  const row = wb.getWorksheet('Leads').getRow(2);
  assert.ok(String(row.getCell(1).value).startsWith("'="));
  assert.ok(String(row.getCell(3).value).startsWith("'+"));
});
