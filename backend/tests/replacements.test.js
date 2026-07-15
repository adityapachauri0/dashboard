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

const HOUR = 3600 * 1000;

async function seed() {
  const affA = await Affiliate.create({ name: 'A', lead_source: 'aaa' });
  const affB = await Affiliate.create({ name: 'B', lead_source: 'bbb' });
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const affUser = await User.create({ email: 'a@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: affA._id });
  await Lead.create({ ref: 'KB-2026-000051', affiliate_id: affA._id, signature_status: 'failed', replacement_status: 'required', replacement_requested_at: new Date(Date.now() - 80 * HOUR) }); // overdue
  await Lead.create({ ref: 'KB-2026-000052', affiliate_id: affA._id, signature_status: 'failed', replacement_status: 'required', replacement_requested_at: new Date(Date.now() - 5 * HOUR) });
  await Lead.create({ ref: 'KB-2026-000053', affiliate_id: affB._id, signature_status: 'failed', replacement_status: 'supplied', replacement_requested_at: new Date() });
  await Lead.create({ ref: 'KB-2026-000054', affiliate_id: affB._id, initial_status: 'accepted' }); // none — excluded
  return { admin, affUser };
}

test('admin sees all obligations with counts and SLA', async () => {
  const { admin } = await seed();
  const res = await request(createApp()).get('/api/v1/dashboard/replacements').set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.rows.length, 3);
  // all seeded leads here predate replacement_reason → legacy fallback puts them all under 'signature'
  assert.deepStrictEqual(res.body.counts, {
    required: 2,
    supplied: 1,
    closed: 0,
    overdue: 1,
    signature: { required: 2, supplied: 1, closed: 0, overdue: 1 },
    cooling_off: { required: 0, supplied: 0, closed: 0, overdue: 0 },
  });
  const overdueRow = res.body.rows.find((r) => r.ref === 'KB-2026-000051');
  assert.strictEqual(overdueRow.sla.label, 'OVERDUE');
  const freshRow = res.body.rows.find((r) => r.ref === 'KB-2026-000052');
  assert.strictEqual(freshRow.sla.overdue, false);
  const suppliedRow = res.body.rows.find((r) => r.ref === 'KB-2026-000053');
  assert.strictEqual(suppliedRow.sla, null);
});

test('status filter narrows rows but not counts', async () => {
  const { admin } = await seed();
  const res = await request(createApp()).get('/api/v1/dashboard/replacements?replacement_status=supplied').set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(res.body.rows.length, 1);
  assert.strictEqual(res.body.rows[0].ref, 'KB-2026-000053');
  assert.strictEqual(res.body.counts.required, 2);
});

test('affiliate users only see their own obligations', async () => {
  const { affUser } = await seed();
  const res = await request(createApp()).get('/api/v1/dashboard/replacements').set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.body.rows.length, 2);
  assert.ok(res.body.rows.every((r) => r.ref.startsWith('KB-2026-00005') && r.ref !== 'KB-2026-000053'));
  assert.deepStrictEqual(res.body.counts, {
    required: 2,
    supplied: 0,
    closed: 0,
    overdue: 1,
    signature: { required: 2, supplied: 0, closed: 0, overdue: 1 },
    cooling_off: { required: 0, supplied: 0, closed: 0, overdue: 0 },
  });
});

test('replacements endpoint returns per-reason counts and reason on rows', async () => {
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const app = createApp();
  const auth = { Authorization: `Bearer ${signToken(admin)}` };
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa' });
  await Lead.create({ ref: 'KB-2026-000501', affiliate_id: aff._id, replacement_status: 'required', replacement_reason: 'cooling_off', replacement_requested_at: new Date() });
  await Lead.create({ ref: 'KB-2026-000502', affiliate_id: aff._id, replacement_status: 'required', replacement_requested_at: new Date() }); // legacy → signature

  const res = await request(app).get('/api/v1/dashboard/replacements').set(auth);
  assert.strictEqual(res.body.counts.required, 2);
  assert.strictEqual(res.body.counts.cooling_off.required, 1);
  assert.strictEqual(res.body.counts.signature.required, 1);
  const reasons = Object.fromEntries(res.body.rows.map((r) => [r.ref, r.replacement_reason]));
  assert.strictEqual(reasons['KB-2026-000501'], 'cooling_off');
  assert.strictEqual(reasons['KB-2026-000502'], 'signature');

  const filtered = await request(app).get('/api/v1/dashboard/replacements?replacement_reason=cooling_off').set(auth);
  assert.deepStrictEqual(filtered.body.rows.map((r) => r.ref), ['KB-2026-000501']);
  assert.strictEqual(filtered.body.counts.required, 2); // counts ignore filters (existing behaviour)
});
