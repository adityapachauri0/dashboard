// Margin protection — the load-bearing invariant of this dashboard.
// BlueLion pays us £110; we pay the supplier £100. The £110 must not be
// reachable from ANY affiliate-scoped route. Admin keeps full visibility.
//
// One test per affiliate-reachable route. If a new one is added, add it here.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const { signToken } = require('../middleware/auth');
const { generateApiKey } = require('../services/apiKeys');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

const CLIENT_PAID = 110;   // what BlueLion pays us — never visible to the supplier
const SUPPLIER_RATE = 100; // what we pay the supplier — they may see this

// the raw body BlueLion posts; webhookRoutes stores it verbatim as lead.payload
const PLATFORM_BODY = {
  leadClientRef: 'SUP-1', brand: 'supplier', outcome: 'full_pay', amount: CLIENT_PAID,
};

async function seed() {
  const key = generateApiKey();
  const aff = await Affiliate.create({
    name: 'Supplier', lead_source: 'supplier', active: true,
    api_key_hash: key.hash, api_key_prefix: key.prefix,
    rate_card: { virgin_rate: SUPPLIER_RATE, searched_upfront_rate: 25, searched_confirmation_rate: 0 },
  });
  const other = await Affiliate.create({
    name: 'Rival', lead_source: 'rival', rate_card: { virgin_rate: 90 },
  });
  const affUser = await User.create({
    email: 's@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: aff._id,
  });
  const admin = await User.create({
    email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin',
  });
  const lead = await Lead.create({
    ref: 'KB-2026-000001', keycode: 'SUP-1', affiliate_id: aff._id, lead_source: 'supplier',
    applicant_name: 'Alpha One', submitted_at: new Date('2026-08-03'),
    initial_status: 'accepted', search_status: 'virgin', signature_status: 'failed',
    payable_status: 'payable', replacement_status: 'required',
    replacement_requested_at: new Date('2026-08-03'), replacement_reason: 'signature',
    payload: PLATFORM_BODY,
    amounts: { upfront_due: SUPPLIER_RATE, confirmation_due: 0, total_due: SUPPLIER_RATE },
    client_outcomes: [
      { client: 'bluelion', outcome: 'full_pay', amount: CLIENT_PAID, received_at: new Date('2026-08-04') },
    ],
  });
  await Lead.create({
    ref: 'KB-2026-000002', affiliate_id: other._id, lead_source: 'rival',
    applicant_name: 'Rival Lead', submitted_at: new Date('2026-08-03'),
    amounts: { upfront_due: 90, confirmation_due: 0, total_due: 90 },
  });
  return { aff, other, affUser, admin, lead, apiKey: key.key };
}

// stats routes default to TODAY; the seeded lead is dated in-month
const RANGE = 'from=2026-08-01&to=2026-08-31';

const leaks = (body) => JSON.stringify(body).includes(String(CLIENT_PAID));

// pull every cell of an xlsx response into one string
async function sheetText(res) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  const out = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => out.push(String(c.value ?? '')))));
  return out.join('|');
}

test('GET /dashboard/leads/:id — detail hides the client amount (raw payload included)', async () => {
  const { affUser, lead } = await seed();
  const res = await request(createApp())
    .get(`/api/v1/dashboard/leads/${lead._id}`)
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.client_outcomes[0].outcome, 'full_pay', 'decision stays visible');
  assert.strictEqual(res.body.client_outcomes[0].amount, undefined, 'outcome amount scrubbed');
  assert.strictEqual(res.body.payload, undefined, 'raw platform payload withheld');
  assert.ok(!leaks(res.body), 'client amount reachable in detail response');
});

test('GET /dashboard/leads — list hides the client amount', async () => {
  const { affUser } = await seed();
  const res = await request(createApp())
    .get('/api/v1/dashboard/leads')
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 1, 'sees only own lead');
  assert.ok(!leaks(res.body), 'client amount reachable in list');
});

test('GET /dashboard/summary — rollup is count-only for a supplier', async () => {
  const { affUser } = await seed();
  const res = await request(createApp())
    .get(`/api/v1/dashboard/summary?${RANGE}`)
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.client_outcomes[0].count, 1, 'decision count stays visible');
  assert.strictEqual(res.body.client_outcomes[0].amount, undefined, 'outcome amount withheld');
  assert.ok(!leaks(res.body), 'client amount reachable in summary');
});

test('GET /dashboard/export.csv — client amount column is blank', async () => {
  const { affUser } = await seed();
  const res = await request(createApp())
    .get('/api/v1/dashboard/export.csv')
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.text.includes('client_outcome_amount'), 'column kept so positions hold');
  assert.ok(res.text.includes('full_pay'), 'decision stays visible');
  assert.ok(!res.text.includes(String(CLIENT_PAID)), 'client amount reachable in CSV');
});

test('GET /dashboard/export.xlsx — client amount cell is blank', async () => {
  const { affUser } = await seed();
  const res = await request(createApp())
    .get('/api/v1/dashboard/export.xlsx')
    .set('Authorization', `Bearer ${signToken(affUser)}`)
    .responseType('blob');
  assert.strictEqual(res.status, 200);
  const text = await sheetText(res);
  assert.ok(text.includes('full_pay'), 'decision stays visible');
  assert.ok(!text.includes(String(CLIENT_PAID)), 'client amount reachable in XLSX export');
});

test('GET /dashboard/statement.xlsx — monthly statement carries no client amount', async () => {
  const { affUser } = await seed();
  const res = await request(createApp())
    .get('/api/v1/dashboard/statement.xlsx?month=2026-08')
    .set('Authorization', `Bearer ${signToken(affUser)}`)
    .responseType('blob');
  assert.strictEqual(res.status, 200);
  const text = await sheetText(res);
  assert.ok(!text.includes(String(CLIENT_PAID)), 'client amount reachable in statement');
});

test('GET /dashboard/replacements — obligation rows carry no client amount', async () => {
  const { affUser } = await seed();
  const res = await request(createApp())
    .get('/api/v1/dashboard/replacements')
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.rows.length, 1, 'sees only own obligation');
  assert.ok(!leaks(res.body), 'client amount reachable in replacements');
});

test('GET /dashboard/affiliate-breakdown — own row only, no client amount', async () => {
  const { affUser } = await seed();
  const res = await request(createApp())
    .get(`/api/v1/dashboard/affiliate-breakdown?${RANGE}`)
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.length, 1, 'cannot see other suppliers');
  assert.strictEqual(res.body[0].name, 'Supplier');
  assert.strictEqual(res.body[0].owed, SUPPLIER_RATE, 'own payable stays visible');
  assert.ok(!leaks(res.body), 'client amount reachable in breakdown');
});

test('GET /dashboard/daily — chart is counts only', async () => {
  const { affUser } = await seed();
  const res = await request(createApp())
    .get(`/api/v1/dashboard/daily?${RANGE}`)
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.status, 200);
  assert.ok(!leaks(res.body), 'client amount reachable in daily chart');
});

test('POST /outcomes — re-posting without an amount does not echo the stored one back', async () => {
  const { apiKey } = await seed();
  const res = await request(createApp())
    .post('/api/v1/outcomes')
    .set('X-API-Key', apiKey)
    .send({ keycode: 'SUP-1', outcome: 'full_pay' }); // no amount — the probe
  assert.strictEqual(res.status, 200);
  assert.ok(!leaks(res.body), 'stored client amount echoed back to the supplier');
  // and the stored value must survive the supplier's amount-less re-post
  const after = await Lead.findOne({ keycode: 'SUP-1' }).lean();
  assert.strictEqual(after.client_outcomes[0].amount, CLIENT_PAID, 'stored amount clobbered');
});

test('admin still sees the client amount everywhere', async () => {
  const { admin, lead } = await seed();
  const app = createApp();
  const token = `Bearer ${signToken(admin)}`;
  const detail = await request(app).get(`/api/v1/dashboard/leads/${lead._id}`).set('Authorization', token);
  assert.strictEqual(detail.body.client_outcomes[0].amount, CLIENT_PAID, 'admin lost outcome amount');
  assert.strictEqual(detail.body.payload.amount, CLIENT_PAID, 'admin lost raw payload');
  const sum = await request(app).get(`/api/v1/dashboard/summary?${RANGE}`).set('Authorization', token);
  assert.strictEqual(sum.body.client_outcomes[0].amount, CLIENT_PAID, 'admin lost summary amount');
  const csv = await request(app).get('/api/v1/dashboard/export.csv').set('Authorization', token);
  assert.ok(csv.text.includes(String(CLIENT_PAID)), 'admin lost CSV amount');
});

// The outbound path: the daily recon email + workbook leave our system entirely,
// so no route guard covers them. They must be built from the affiliate's OWN
// rate card — reconExcel also exports BlueLion builders from the same module.
test('daily reconciliation email and workbook carry no client money', async () => {
  const { buildAffiliateRecons } = require('../services/affiliateRecon');
  const aff = await Affiliate.create({
    name: 'Supplier', lead_source: 'supplier', active: true, contact_email: 's@supplier.test',
    rate_card: { virgin_rate: SUPPLIER_RATE, searched_upfront_rate: 25, searched_confirmation_rate: 0 },
  });
  await Lead.create({
    ref: 'KB-2026-000009', affiliate_id: aff._id, lead_source: 'supplier',
    submitted_at: new Date('2026-07-18T10:00:00Z'), initial_status: 'accepted',
    search_status: 'virgin', signature_status: 'passed', payable_status: 'payable',
    amounts: { upfront_due: SUPPLIER_RATE, confirmation_due: 0, total_due: SUPPLIER_RATE },
    payload: PLATFORM_BODY,
    client_outcomes: [
      { client: 'bluelion', outcome: 'full_pay', amount: CLIENT_PAID, received_at: new Date('2026-07-19') },
    ],
  });
  const recons = await buildAffiliateRecons(new Date('2026-07-19T08:00:00Z'));
  assert.strictEqual(recons.length, 1, 'recon not built');
  const r = recons[0];
  assert.strictEqual(r.to, 's@supplier.test');
  assert.ok(r.text.includes(String(SUPPLIER_RATE)), 'own rate should be in the email');
  assert.ok(!r.text.includes(String(CLIENT_PAID)), 'client amount reachable in recon email');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.xlsx);
  const cells = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value ?? '')))));
  assert.ok(!cells.join('|').includes(String(CLIENT_PAID)), 'client amount reachable in recon workbook');
});
