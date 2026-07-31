const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const { generateApiKey } = require('../services/apiKeys');
const { signToken } = require('../middleware/auth');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

async function seed() {
  const a = generateApiKey();
  const b = generateApiKey();
  const affA = await Affiliate.create({ name: 'A', lead_source: 'aaa', api_key_hash: a.hash, api_key_prefix: a.prefix });
  const affB = await Affiliate.create({ name: 'B', lead_source: 'bbb', api_key_hash: b.hash, api_key_prefix: b.prefix });
  const lead = await Lead.create({ ref: 'KB-2026-000001', affiliate_id: affA._id, submitted_at: new Date('2026-07-05T10:00:00Z'), applicant_name: 'John Smith' });
  return { affA, affB, keyA: a.key, keyB: b.key, lead };
}

test('post outcome stores it with history and defaults client', async () => {
  const { keyA } = await seed();
  const res = await request(createApp())
    .post('/api/v1/outcomes')
    .set('X-API-Key', keyA)
    .send({ keycode: 'KB-2026-000001', outcome: 'Full Pay', amount: 110, reason: '' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ref: 'KB-2026-000001', client: 'bluelion', outcome: 'full_pay', amount: 110, updated: false });
  const lead = await Lead.findOne({ ref: 'KB-2026-000001' });
  assert.strictEqual(lead.client_outcomes.length, 1);
  assert.strictEqual(lead.client_outcomes[0].outcome, 'full_pay');
  assert.strictEqual(lead.client_outcomes[0].amount, 110);
  assert.ok(lead.client_outcomes[0].received_at instanceof Date);
  const h = lead.history.at(-1);
  assert.strictEqual(h.field, 'client_outcome:bluelion');
  assert.strictEqual(h.to, 'full_pay £110');
  // payment lifecycle untouched — separate field by design
  assert.strictEqual(lead.payable_status, 'not_payable');
});

test('re-post updates in place (idempotent per client), history only on change', async () => {
  const { keyA } = await seed();
  const app = createApp();
  const send = (body) => request(app).post('/api/v1/outcomes').set('X-API-Key', keyA).send(body);
  await send({ keycode: 'KB-2026-000001', outcome: 'rejected', reason: 'KYC_AML_STOP' });
  const again = await send({ keycode: 'KB-2026-000001', outcome: 'rejected', reason: 'KYC_AML_STOP' });
  assert.strictEqual(again.body.updated, true);
  const upgraded = await send({ keycode: 'KB-2026-000001', outcome: 'part pay', amount: 39 });
  assert.strictEqual(upgraded.body.outcome, 'part_pay');
  const lead = await Lead.findOne({ ref: 'KB-2026-000001' });
  assert.strictEqual(lead.client_outcomes.length, 1);
  assert.strictEqual(lead.client_outcomes[0].outcome, 'part_pay');
  assert.strictEqual(lead.client_outcomes[0].amount, 39);
  const outcomeHistory = lead.history.filter((h) => h.field === 'client_outcome:bluelion');
  assert.strictEqual(outcomeHistory.length, 2); // initial + upgrade; unchanged re-post skipped
});

test('second client adds a second element', async () => {
  const { keyA } = await seed();
  const app = createApp();
  await request(app).post('/api/v1/outcomes').set('X-API-Key', keyA)
    .send({ keycode: 'KB-2026-000001', outcome: 'full_pay', amount: 110 });
  await request(app).post('/api/v1/outcomes').set('X-API-Key', keyA)
    .send({ keycode: 'KB-2026-000001', client: 'Other Buyer', outcome: 'rejected' });
  const lead = await Lead.findOne({ ref: 'KB-2026-000001' });
  assert.deepStrictEqual(lead.client_outcomes.map((o) => o.client).sort(), ['bluelion', 'other_buyer']);
});

test('scoping and validation: wrong affiliate 404, bad inputs 400, bad key 401', async () => {
  const { keyA, keyB } = await seed();
  const app = createApp();
  const otherAffiliate = await request(app).post('/api/v1/outcomes').set('X-API-Key', keyB)
    .send({ keycode: 'KB-2026-000001', outcome: 'full_pay' });
  assert.strictEqual(otherAffiliate.status, 404);
  const unknownRef = await request(app).post('/api/v1/outcomes').set('X-API-Key', keyA)
    .send({ keycode: 'KB-2026-999999', outcome: 'full_pay' });
  assert.strictEqual(unknownRef.status, 404);
  const missingOutcome = await request(app).post('/api/v1/outcomes').set('X-API-Key', keyA)
    .send({ keycode: 'KB-2026-000001' });
  assert.strictEqual(missingOutcome.status, 400);
  const badAmount = await request(app).post('/api/v1/outcomes').set('X-API-Key', keyA)
    .send({ keycode: 'KB-2026-000001', outcome: 'full_pay', amount: -5 });
  assert.strictEqual(badAmount.status, 400);
  const badDate = await request(app).post('/api/v1/outcomes').set('X-API-Key', keyA)
    .send({ keycode: 'KB-2026-000001', outcome: 'full_pay', occurred_at: 'yesterday-ish' });
  assert.strictEqual(badDate.status, 400);
  const badKey = await request(app).post('/api/v1/outcomes').set('X-API-Key', 'nope')
    .send({ keycode: 'KB-2026-000001', outcome: 'full_pay' });
  assert.strictEqual(badKey.status, 401);
});

test('platform token can post outcomes for any lead; bad or unconfigured token rejected', async () => {
  const { lead } = await seed();
  const app = createApp();
  process.env.WEBHOOK_TOKEN = 'tok-123';
  const ok = await request(app).post('/api/v1/outcomes?token=tok-123')
    .send({ keycode: lead.ref, outcome: 'Part Pay', amount: 30 });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.outcome, 'part_pay');
  const saved = await Lead.findOne({ ref: lead.ref });
  assert.strictEqual(saved.client_outcomes[0].amount, 30);
  assert.strictEqual(saved.history.at(-1).source, 'webhook');
  const bad = await request(app).post('/api/v1/outcomes?token=wrong')
    .send({ keycode: lead.ref, outcome: 'full_pay' });
  assert.strictEqual(bad.status, 401);
  delete process.env.WEBHOOK_TOKEN;
  const unconfigured = await request(app).post('/api/v1/outcomes?token=tok-123')
    .send({ keycode: lead.ref, outcome: 'full_pay' });
  assert.strictEqual(unconfigured.status, 401);
});

test('leads list filters by client_outcome and summary rolls up counts + money', async () => {
  const { affA, keyA } = await seed();
  await Lead.create({ ref: 'KB-2026-000002', affiliate_id: affA._id, submitted_at: new Date('2026-07-05T11:00:00Z') });
  await Lead.create({ ref: 'KB-2026-000003', affiliate_id: affA._id, submitted_at: new Date('2026-07-05T12:00:00Z') });
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const app = createApp();
  const send = (keycode, body) => request(app).post('/api/v1/outcomes').set('X-API-Key', keyA).send({ keycode, ...body });
  await send('KB-2026-000001', { outcome: 'full_pay', amount: 110 });
  await send('KB-2026-000002', { outcome: 'part_pay', amount: 39 });
  await send('KB-2026-000003', { outcome: 'rejected', reason: 'NO_ACCOUNTS_IN_SCOPE' });

  const list = await request(app)
    .get('/api/v1/dashboard/leads?client_outcome=full_pay')
    .set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(list.body.total, 1);
  assert.strictEqual(list.body.rows[0].ref, 'KB-2026-000001');

  const summary = await request(app)
    .get('/api/v1/dashboard/summary?from=2026-07-05&to=2026-07-05')
    .set('Authorization', `Bearer ${signToken(admin)}`);
  const byOutcome = Object.fromEntries(summary.body.client_outcomes.map((o) => [o.outcome, o]));
  assert.deepStrictEqual(byOutcome.full_pay, { outcome: 'full_pay', count: 1, amount: 110 });
  assert.deepStrictEqual(byOutcome.part_pay, { outcome: 'part_pay', count: 1, amount: 39 });
  assert.deepStrictEqual(byOutcome.rejected, { outcome: 'rejected', count: 1, amount: 0 });
});

test('export appends client outcome columns at the end', async () => {
  const { keyA } = await seed();
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const app = createApp();
  await request(app).post('/api/v1/outcomes').set('X-API-Key', keyA)
    .send({ keycode: 'KB-2026-000001', outcome: 'part_pay', amount: 39, reason: 'DUPLICATE_CLIENT' });
  const res = await request(app)
    .get('/api/v1/dashboard/export.csv')
    .set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(res.status, 200);
  const [header, row] = res.text.trim().split('\n');
  assert.ok(header.endsWith('client_outcome,client_outcome_amount,client_outcome_reason'));
  assert.ok(row.includes('part_pay,39,DUPLICATE_CLIENT'));
});
