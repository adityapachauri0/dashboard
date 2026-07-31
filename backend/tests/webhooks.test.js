const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const WebhookEvent = require('../models/WebhookEvent');
const { signToken } = require('../middleware/auth');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

const rates = { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 };

async function seedLead() {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: rates });
  const lead = await Lead.create({ ref: 'KB-2026-000001', affiliate_id: aff._id, lead_source: 'aaa', applicant_name: 'John', platform_ref: 'PLAT-77' });
  return { aff, lead };
}

test('webhook matches by our ref and applies statuses', async () => {
  await seedLead();
  const res = await request(createApp())
    .post('/api/v1/webhooks/platform')
    .send({ ref: 'KB-2026-000001', status: 'accepted', credit_search: 'virgin' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.matched, true);
  const lead = await Lead.findOne({ ref: 'KB-2026-000001' });
  assert.strictEqual(lead.initial_status, 'accepted');
  assert.strictEqual(lead.payable_status, 'payable');
  assert.strictEqual(lead.amounts.total_due, 40);
  assert.ok(lead.history.every((h) => h.source === 'webhook'));
});

test('webhook matches by platform_ref; unmatched stored for review', async () => {
  await seedLead();
  const app = createApp();
  const byPlat = await request(app).post('/api/v1/webhooks/platform').send({ platform_ref: 'PLAT-77', signature: 'signed' });
  assert.strictEqual(byPlat.body.matched, true);
  const nomatch = await request(app).post('/api/v1/webhooks/platform').send({ platform_ref: 'UNKNOWN-1', status: 'accepted' });
  assert.strictEqual(nomatch.body.matched, false);
  const events = await WebhookEvent.find({ matched_lead: null });
  assert.strictEqual(events.length, 1);
});

test('webhook token enforced when configured', async () => {
  process.env.WEBHOOK_TOKEN = 'sekret';
  const res = await request(createApp()).post('/api/v1/webhooks/platform').send({ ref: 'x' });
  assert.strictEqual(res.status, 401);
  const ok = await request(createApp()).post('/api/v1/webhooks/platform?token=sekret').send({ ref: 'x' });
  assert.strictEqual(ok.status, 200);
  delete process.env.WEBHOOK_TOKEN;
});

test('webhook refuses to run open in production', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.WEBHOOK_TOKEN;
  const res = await request(createApp()).post('/api/v1/webhooks/platform').send({ ref: 'x' });
  assert.strictEqual(res.status, 503);
  delete process.env.NODE_ENV;
});

test('webhook for lead with missing affiliate still returns 200 and matches', async () => {
  const lead = await Lead.create({ ref: 'KB-2026-000042', affiliate_id: new mongoose.Types.ObjectId(), lead_source: 'ghost', applicant_name: 'Ghost' });
  const res = await request(createApp())
    .post('/api/v1/webhooks/platform')
    .send({ ref: 'KB-2026-000042', status: 'accepted', credit_search: 'virgin' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.matched, true);
  const updated = await Lead.findById(lead._id);
  assert.strictEqual(updated.initial_status, 'accepted');
  assert.strictEqual(updated.amounts.total_due, 0); // no rate card -> £0, but no crash
});

test('admin can manually match an unmatched event', async () => {
  const { lead } = await seedLead();
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const app = createApp();
  await request(app).post('/api/v1/webhooks/platform').send({ platform_ref: 'UNKNOWN-9', status: 'rejected', reason: 'no credit file' });
  const event = await WebhookEvent.findOne({ matched_lead: null });
  const res = await request(app)
    .post(`/api/v1/webhooks/${event._id}/match`)
    .set('Authorization', `Bearer ${signToken(admin)}`)
    .send({ ref: 'KB-2026-000001' });
  assert.strictEqual(res.status, 200);
  const updated = await Lead.findById(lead._id);
  assert.strictEqual(updated.initial_status, 'rejected');
  assert.strictEqual(updated.rejection_reason, 'no credit file');
});

test('webhook accepting a replacement lead closes the original obligation', async () => {
  const aff = await Affiliate.create({ name: 'W', lead_source: 'www', rate_card: { virgin_rate: 40 } });
  const original = await Lead.create({
    ref: 'KB-2026-000031', affiliate_id: aff._id, initial_status: 'accepted', signature_status: 'failed',
    needs_replacement: true, replacement_status: 'required', replacement_requested_at: new Date(),
  });
  const repl = await Lead.create({ ref: 'KB-2026-000032', affiliate_id: aff._id, replaces_lead: original._id });
  original.replaced_by_lead = repl._id;
  original.replacement_status = 'supplied';
  await original.save();

  const res = await request(createApp())
    .post(`/api/v1/webhooks/platform?token=${process.env.WEBHOOK_TOKEN || ''}`)
    .send({ ref: 'KB-2026-000032', status: 'accepted' });
  assert.strictEqual(res.status, 200);
  const after = await Lead.findById(original._id);
  assert.strictEqual(after.replacement_status, 'closed');
});

test('webhook rejecting a replacement lead reopens the original obligation', async () => {
  const aff = await Affiliate.create({ name: 'W2', lead_source: 'ww2', rate_card: { virgin_rate: 40 } });
  const original = await Lead.create({
    ref: 'KB-2026-000033', affiliate_id: aff._id, initial_status: 'accepted', signature_status: 'failed',
    needs_replacement: true, replacement_status: 'required', replacement_requested_at: new Date('2026-07-10T10:00:00Z'),
  });
  const repl = await Lead.create({ ref: 'KB-2026-000034', affiliate_id: aff._id, replaces_lead: original._id });
  original.replaced_by_lead = repl._id;
  original.replacement_status = 'supplied';
  await original.save();

  await request(createApp())
    .post(`/api/v1/webhooks/platform?token=${process.env.WEBHOOK_TOKEN || ''}`)
    .send({ ref: 'KB-2026-000034', status: 'rejected', rejection_reason: 'duplicate claim' });
  const after = await Lead.findById(original._id);
  assert.strictEqual(after.replacement_status, 'required');
  assert.strictEqual(after.replaced_by_lead, null);
  assert.strictEqual(after.replacement_requested_at.toISOString(), '2026-07-10T10:00:00.000Z');
});

test('webhook cancellation payloads open a cooling-off obligation', async () => {
  for (const payload of [{ status: 'cancelled' }, { cancellation: 'cooling-off' }, { cancelled: true }]) {
    await clearDB();
    const { lead } = await seedLead();
    const res = await request(createApp())
      .post('/api/v1/webhooks/platform')
      .send({ ref: lead.ref, ...payload });
    assert.strictEqual(res.body.matched, true, JSON.stringify(payload));
    const updated = await Lead.findOne({ ref: lead.ref });
    assert.strictEqual(updated.cancelled, true, JSON.stringify(payload));
    assert.ok(updated.cancelled_at instanceof Date);
    assert.strictEqual(updated.replacement_status, 'required');
    assert.strictEqual(updated.replacement_reason, 'cooling_off');
    assert.strictEqual(updated.payable_status, 'not_payable');
  }
});

// ---- Model B: platform posts create leads keyed by supplier reference ----

test('attempt post with unknown keycode + known brand CREATES the lead (billable when accepted)', async () => {
  const aff = await Affiliate.create({
    name: 'Claim3000', lead_source: 'claim3000', brands: ['claim3000'],
    rate_card: { virgin_rate: 100, searched_upfront_rate: 25, searched_confirmation_rate: 0 },
  });
  const res = await request(createApp()).post('/api/v1/webhooks/platform').send({
    keycode: 'C3K-0001', brand: 'Claim3000', reference: 'BL-991',
    name: 'Jane Doe', email: 'jane@example.com', phone: '07700900001',
    status: 'accepted', search: 'non-searched',
  });
  assert.strictEqual(res.body.created, true);
  const lead = await Lead.findOne({ keycode: 'C3K-0001' });
  assert.ok(lead.ref.startsWith('KB-'));
  assert.strictEqual(lead.affiliate_id.toString(), aff._id.toString());
  assert.strictEqual(lead.applicant_name, 'Jane Doe');
  assert.strictEqual(lead.platform_ref, 'BL-991');
  assert.strictEqual(lead.initial_status, 'accepted');
  assert.strictEqual(lead.search_status, 'virgin');
  assert.strictEqual(lead.amounts.total_due, 100);
});

test('later posts with the same keycode UPDATE the created lead, not duplicate it', async () => {
  await Affiliate.create({ name: 'Claim3000', lead_source: 'claim3000', brands: ['claim3000'],
    rate_card: { virgin_rate: 100, searched_upfront_rate: 25, searched_confirmation_rate: 0 } });
  const app = createApp();
  await request(app).post('/api/v1/webhooks/platform')
    .send({ keycode: 'C3K-0002', brand: 'claim3000', status: 'accepted', search: 'searched' });
  const upd = await request(app).post('/api/v1/webhooks/platform')
    .send({ keycode: 'C3K-0002', brand: 'claim3000', signature: 'failed' });
  assert.strictEqual(upd.body.created, false);
  assert.strictEqual(upd.body.matched, true);
  const leads = await Lead.find({ keycode: 'C3K-0002' });
  assert.strictEqual(leads.length, 1);
  assert.strictEqual(leads[0].signature_status, 'failed');
  assert.strictEqual(leads[0].replacement_status, 'required'); // 72h SLA clock opened
  assert.strictEqual(leads[0].amounts.total_due, 0);
});

test('cancellation post by keycode opens cooling-off obligation', async () => {
  await Affiliate.create({ name: 'Claim3000', lead_source: 'claim3000', brands: ['claim3000'] });
  const app = createApp();
  await request(app).post('/api/v1/webhooks/platform')
    .send({ keycode: 'C3K-0003', brand: 'claim3000', status: 'accepted' });
  await request(app).post('/api/v1/webhooks/platform')
    .send({ keycode: 'C3K-0003', brand: 'claim3000', cancelled: true });
  const lead = await Lead.findOne({ keycode: 'C3K-0003' });
  assert.strictEqual(lead.cancelled, true);
  assert.strictEqual(lead.replacement_status, 'required');
  assert.strictEqual(lead.replacement_reason, 'cooling_off');
});

test('unknown brand cannot create: event stored unmatched', async () => {
  const res = await request(createApp()).post('/api/v1/webhooks/platform')
    .send({ keycode: 'GHOST-1', brand: 'nobody', status: 'accepted' });
  assert.strictEqual(res.body.matched, false);
  assert.strictEqual(res.body.created, false);
  assert.strictEqual(await Lead.countDocuments(), 0);
  assert.strictEqual(await WebhookEvent.countDocuments({ matched_lead: null }), 1);
});

test('outcomes endpoint matches by supplier keycode via platform token', async () => {
  await Affiliate.create({ name: 'Claim3000', lead_source: 'claim3000', brands: ['claim3000'] });
  const app = createApp();
  await request(app).post('/api/v1/webhooks/platform')
    .send({ keycode: 'C3K-0004', brand: 'claim3000', status: 'accepted' });
  process.env.WEBHOOK_TOKEN = 'tok-999';
  const res = await request(app).post('/api/v1/outcomes?token=tok-999')
    .send({ keycode: 'C3K-0004', outcome: 'Full Pay', amount: 110 });
  delete process.env.WEBHOOK_TOKEN;
  assert.strictEqual(res.status, 200);
  const lead = await Lead.findOne({ keycode: 'C3K-0004' });
  assert.strictEqual(lead.client_outcomes[0].outcome, 'full_pay');
  assert.strictEqual(lead.client_outcomes[0].amount, 110);
});

test('ping endpoint: 200 on valid token (GET and POST), 401 bad token, stores nothing', async () => {
  process.env.WEBHOOK_TOKEN = 'ping-tok';
  const app = createApp();
  const get = await request(app).get('/api/v1/webhooks/platform/ping?token=ping-tok');
  assert.strictEqual(get.status, 200);
  assert.strictEqual(get.body.ok, true);
  const post = await request(app).post('/api/v1/webhooks/platform/ping?token=ping-tok').send({ anything: 'ignored' });
  assert.strictEqual(post.status, 200);
  const bad = await request(app).get('/api/v1/webhooks/platform/ping?token=nope');
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(await WebhookEvent.countDocuments(), 0);
  assert.strictEqual(await Lead.countDocuments(), 0);
  delete process.env.WEBHOOK_TOKEN;
});

test('one-endpoint integration: single post carries status + search + commercial outcome', async () => {
  await Affiliate.create({ name: 'Claim3000', lead_source: 'claim3000', brands: ['claim3000'],
    rate_card: { virgin_rate: 100, searched_upfront_rate: 25, searched_confirmation_rate: 0 } });
  const app = createApp();
  const res = await request(app).post('/api/v1/webhooks/platform').send({
    keycode: 'C3K-0100', brand: 'claim3000', status: 'accepted', search: 'non-searched',
    outcome: 'Full Pay', amount: 110,
  });
  assert.strictEqual(res.body.created, true);
  const lead = await Lead.findOne({ keycode: 'C3K-0100' });
  assert.strictEqual(lead.initial_status, 'accepted');
  assert.strictEqual(lead.amounts.total_due, 100);
  assert.strictEqual(lead.client_outcomes[0].outcome, 'full_pay');
  assert.strictEqual(lead.client_outcomes[0].amount, 110);
  // outcome-only follow-up to the same endpoint updates in place
  await request(app).post('/api/v1/webhooks/platform')
    .send({ keycode: 'C3K-0100', brand: 'claim3000', outcome: 'rejected', amount: 0, reason: 'CANCELLED' });
  const after = await Lead.findOne({ keycode: 'C3K-0100' });
  assert.strictEqual(after.client_outcomes.length, 1);
  assert.strictEqual(after.client_outcomes[0].outcome, 'rejected');
  assert.strictEqual(after.client_outcomes[0].reason, 'CANCELLED');
});
