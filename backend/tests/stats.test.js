const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const { signToken } = require('../middleware/auth');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

async function seed() {
  const affA = await Affiliate.create({ name: 'A', lead_source: 'aaa' });
  const affB = await Affiliate.create({ name: 'B', lead_source: 'bbb' });
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const affUser = await User.create({ email: 'a@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: affA._id });
  const day = new Date('2026-07-05T10:00:00Z');
  await Lead.create({ ref: 'KB-2026-000001', affiliate_id: affA._id, submitted_at: day, initial_status: 'accepted', search_status: 'virgin', signature_status: 'pending', payable_status: 'payable', amounts: { upfront_due: 40, confirmation_due: 0, total_due: 40 } });
  await Lead.create({ ref: 'KB-2026-000002', affiliate_id: affA._id, submitted_at: day, initial_status: 'rejected' });
  await Lead.create({ ref: 'KB-2026-000003', affiliate_id: affB._id, submitted_at: day, initial_status: 'accepted', search_status: 'searched', signature_status: 'passed', payable_status: 'partial_pending_confirmation', amounts: { upfront_due: 15, confirmation_due: 0, total_due: 15 } });
  await Lead.create({ ref: 'KB-2026-000004', affiliate_id: affB._id, submitted_at: day, initial_status: 'pending' });
  return { admin, affUser };
}

test('summary counts and rates for admin', async () => {
  const { admin } = await seed();
  const res = await request(createApp())
    .get('/api/v1/dashboard/summary?from=2026-07-05&to=2026-07-05')
    .set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.submitted, 4);
  assert.strictEqual(res.body.accepted, 2);
  assert.strictEqual(res.body.rejected, 1);
  assert.strictEqual(res.body.pending, 1);
  assert.strictEqual(res.body.acceptance_rate, 50);
  assert.strictEqual(res.body.awaiting_signature, 1);
  assert.strictEqual(res.body.awaiting_confirmation, 1);
  assert.strictEqual(res.body.total_due, 55);
});

test('summary attention block is all-time: overdue signatures, unresolved replacements, part-paid', async () => {
  const { admin } = await seed();
  const affC = await Affiliate.create({ name: 'C', lead_source: 'ccc' });
  const june = new Date('2026-06-01T10:00:00Z');
  // outside the queried range, deadline in the past → overdue
  await Lead.create({ ref: 'KB-2026-000005', affiliate_id: affC._id, submitted_at: june, initial_status: 'accepted', signature_status: 'pending', signature_deadline: new Date('2026-06-05T17:00:00Z') });
  // deadline in the future → not overdue
  await Lead.create({ ref: 'KB-2026-000006', affiliate_id: affC._id, submitted_at: june, initial_status: 'accepted', signature_status: 'pending', signature_deadline: new Date('2099-01-01T17:00:00Z') });
  // failed signature, replacement not yet linked → needs replacement
  await Lead.create({ ref: 'KB-2026-000007', affiliate_id: affC._id, submitted_at: june, initial_status: 'accepted', signature_status: 'failed', needs_replacement: true });
  const res = await request(createApp())
    .get('/api/v1/dashboard/summary?from=2026-07-05&to=2026-07-05')
    .set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.submitted, 4); // range-scoped fields unaffected by June leads
  assert.deepStrictEqual(res.body.attention, {
    overdue_signature: 1, // seed lead 1 has signature pending but NO deadline → excluded
    needs_replacement: 1,
    awaiting_confirmation: 1, // seed lead 3, counted all-time
    possible_duplicates: 0,
  });
});

test('breakdown groups by affiliate; affiliate user sees only own row', async () => {
  const { admin, affUser } = await seed();
  const app = createApp();
  const adminRes = await request(app)
    .get('/api/v1/dashboard/affiliate-breakdown?from=2026-07-05&to=2026-07-05')
    .set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(adminRes.body.length, 2);
  const a = adminRes.body.find((r) => r.name === 'A');
  assert.deepStrictEqual(
    { submitted: a.submitted, accepted: a.accepted, owed: a.owed },
    { submitted: 2, accepted: 1, owed: 40 }
  );
  const affRes = await request(app)
    .get('/api/v1/dashboard/affiliate-breakdown?from=2026-07-05&to=2026-07-05')
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(affRes.body.length, 1);
  assert.strictEqual(affRes.body[0].name, 'A');
});
