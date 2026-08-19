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

test('affiliate workbook: statement tabs, affiliate rates, cohort rows, running balances', async () => {
  const day1 = new Date('2026-07-18T10:00:00Z');
  const day2 = new Date('2026-07-20T10:00:00Z');
  const statementLeads = [
    lead({ ref: 'KB-2026-000001', initial_status: 'accepted', submitted_at: day1 }),
    lead({
      ref: 'KB-2026-000002', initial_status: 'accepted', submitted_at: day1,
      signature_status: 'failed', replacement_status: 'required',
      replacement_reason: 'signature', replacement_requested_at: day2,
    }),
    lead({
      ref: 'KB-2026-000003', initial_status: 'accepted', submitted_at: day1,
      cancelled: true, cancelled_at: day2, replacement_status: 'supplied',
      replacement_reason: 'cooling_off', replaced_by_lead: { ref: 'KB-2026-000004' },
    }),
    lead({ ref: 'KB-2026-000004', initial_status: 'accepted', submitted_at: day2, replaces_lead: { ref: 'KB-2026-000003' } }),
    lead({ ref: 'KB-2026-000005', initial_status: 'rejected', submitted_at: day1, search_status: 'unknown' }),
  ];
  const buf = await buildAffiliateWorkbook({
    affiliate: { name: 'Claim3000', rate_card: { virgin_rate: 40, searched_upfront_rate: 15 } },
    dayLeads: [lead(), lead({ ref: 'KB-2026-000002', search_status: 'searched' })],
    confirmedLeads: [lead({ ref: 'KB-2026-000012', payable_status: 'payable_full' })],
    statementLeads,
  });
  const wb = await load(buf);
  for (const name of ['Payable Leads', 'Daily Supply', '72h Rejects Not Replaced',
    '14-Day Cancellations', 'Transactions', 'Confirmed After Lender Check']) {
    assert.ok(wb.getWorksheet(name), `missing tab ${name}`);
  }
  const pay = wb.getWorksheet('Payable Leads');
  assert.strictEqual(pay.getRow(2).getCell(6).value, 40);  // virgin at affiliate rate
  assert.strictEqual(pay.getRow(3).getCell(6).value, 15);  // searched at affiliate rate

  // Daily Supply: day 1 cohort carries its own leads' later failures
  const daily = wb.getWorksheet('Daily Supply');
  assert.deepStrictEqual(daily.getRow(2).values.slice(1),
    ['18/07/2026', 4, 3, 0, 1, 1, 1, 1, 1]); // supplied, virgin, searched, rejects, sig, notRepl, cancels, net
  assert.deepStrictEqual(daily.getRow(3).values.slice(1),
    ['20/07/2026', 1, 1, 0, 0, 0, 0, 0, 1]); // the replacement lead's own day

  // 72h owed tab: open obligation with deadline = failed + 72h
  const owedTab = wb.getWorksheet('72h Rejects Not Replaced');
  assert.strictEqual(owedTab.getRow(2).getCell(1).value, 'KB-2026-000002');
  assert.strictEqual(owedTab.getRow(2).getCell(4).value, '23/07/2026');

  // cancellations tab: replaced + matched to the replacement ref
  const canTab = wb.getWorksheet('14-Day Cancellations');
  assert.strictEqual(canTab.getRow(2).getCell(1).value, 'KB-2026-000003');
  assert.strictEqual(canTab.getRow(2).getCell(4).value, 'Yes');
  assert.strictEqual(canTab.getRow(2).getCell(5).value, 'KB-2026-000004');

  // Transactions: bank-statement running balances at affiliate rates
  const tx = wb.getWorksheet('Transactions');
  const rows = [];
  tx.eachRow((r) => rows.push(r.values.slice(1)));
  const sigRow = rows.find((r) => r[2] === 'Signature failed');
  assert.strictEqual(sigRow[5], -40); // value out at affiliate virgin rate
  const repRow = rows.find((r) => String(r[2]).startsWith('Replacement supplied'));
  assert.strictEqual(repRow[2], 'Replacement supplied (for KB-2026-000003)');
  const closing = rows.at(-1);
  assert.strictEqual(closing[0], 'CLOSING BALANCE');
  assert.strictEqual(closing[6], 2); // net good leads: 3 supplied + 1 replacement - fail - cancel
  assert.strictEqual(closing[7], 1); // replacements still owed
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
    confirmedLeads: [],
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
