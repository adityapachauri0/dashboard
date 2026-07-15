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
