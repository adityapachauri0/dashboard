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

const rates = { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 };

async function seed() {
  const affA = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: rates });
  const affB = await Affiliate.create({ name: 'B', lead_source: 'bbb', rate_card: rates });
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const affUser = await User.create({ email: 'a@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: affA._id });
  const leadA = await Lead.create({ ref: 'KB-2026-000001', affiliate_id: affA._id, lead_source: 'aaa', applicant_name: 'Alpha One', submitted_at: new Date('2026-07-01'), initial_status: 'accepted', search_status: 'virgin', payable_status: 'payable' });
  const leadB = await Lead.create({ ref: 'KB-2026-000002', affiliate_id: affB._id, lead_source: 'bbb', applicant_name: 'Beta Two', submitted_at: new Date('2026-07-02') });
  return { affA, affB, admin, affUser, leadA, leadB };
}

test('admin sees all leads; filters work', async () => {
  const { admin } = await seed();
  const app = createApp();
  const all = await request(app).get('/api/v1/dashboard/leads').set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(all.body.total, 2);
  const filtered = await request(app).get('/api/v1/dashboard/leads?initial_status=accepted').set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(filtered.body.total, 1);
  assert.strictEqual(filtered.body.rows[0].ref, 'KB-2026-000001');
});

test('affiliate user sees only own leads, even when requesting another affiliate_id', async () => {
  const { affUser, affB } = await seed();
  const app = createApp();
  const res = await request(app)
    .get(`/api/v1/dashboard/leads?affiliate_id=${affB._id}`)
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.body.total, 1);
  assert.strictEqual(res.body.rows[0].ref, 'KB-2026-000001');
});

test('affiliate cannot read another affiliate lead detail; cannot PATCH', async () => {
  const { affUser, leadB, leadA } = await seed();
  const app = createApp();
  const detail = await request(app).get(`/api/v1/dashboard/leads/${leadB._id}`).set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(detail.status, 404);
  const patch = await request(app).patch(`/api/v1/dashboard/leads/${leadA._id}`).set('Authorization', `Bearer ${signToken(affUser)}`).send({ initial_status: 'accepted' });
  assert.strictEqual(patch.status, 403);
});

test('admin PATCH applies status change with manual source history', async () => {
  const { admin, leadB } = await seed();
  const app = createApp();
  const res = await request(app)
    .patch(`/api/v1/dashboard/leads/${leadB._id}`)
    .set('Authorization', `Bearer ${signToken(admin)}`)
    .send({ initial_status: 'accepted', search_status: 'searched' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.payable_status, 'partial_pending_confirmation');
  assert.strictEqual(res.body.amounts.total_due, 15);
  const stored = await Lead.findById(leadB._id);
  assert.ok(stored.history.every((h) => h.source === 'manual' && h.user === 'admin@x.com'));
});

test('admin PATCH replaces_ref links this lead as replacement', async () => {
  const { admin, leadA, leadB } = await seed();
  const app = createApp();
  const res = await request(app)
    .patch(`/api/v1/dashboard/leads/${leadB._id}`)
    .set('Authorization', `Bearer ${signToken(admin)}`)
    .send({ replaces_ref: 'KB-2026-000001' });
  assert.strictEqual(res.status, 400); // different affiliate — must reject
  const own = await Lead.create({ ref: 'KB-2026-000003', affiliate_id: leadA.affiliate_id, lead_source: 'aaa', applicant_name: 'Alpha Three' });
  const ok = await request(app)
    .patch(`/api/v1/dashboard/leads/${own._id}`)
    .set('Authorization', `Bearer ${signToken(admin)}`)
    .send({ replaces_ref: 'KB-2026-000001' });
  assert.strictEqual(ok.status, 200);
  const orig = await Lead.findById(leadA._id);
  assert.strictEqual(orig.payable_status, 'replaced');

  // `own` is now a replacement itself — linking it to a second original must be rejected.
  const secondOriginal = await Lead.create({ ref: 'KB-2026-000004', affiliate_id: leadA.affiliate_id, lead_source: 'aaa', applicant_name: 'Alpha Four' });
  const again = await request(app)
    .patch(`/api/v1/dashboard/leads/${own._id}`)
    .set('Authorization', `Bearer ${signToken(admin)}`)
    .send({ replaces_ref: secondOriginal.ref });
  assert.strictEqual(again.status, 409);
});

test('PATCH replaces_ref rejects non-string (injection guard)', async () => {
  const { admin, leadB } = await seed();
  const app = createApp();
  const res = await request(app)
    .patch(`/api/v1/dashboard/leads/${leadB._id}`)
    .set('Authorization', `Bearer ${signToken(admin)}`)
    .send({ replaces_ref: { $ne: null } });
  assert.strictEqual(res.status, 400);
});

test('leads list filters by replacement_reason with legacy signature fallback', async () => {
  const { admin } = await seed();
  const app = createApp();
  const auth = { Authorization: `Bearer ${signToken(admin)}` };
  const aff = await Affiliate.create({ name: 'A2', lead_source: 'aaa2', rate_card: rates });
  await Lead.create({ ref: 'KB-2026-000401', affiliate_id: aff._id, replacement_status: 'required', replacement_reason: 'cooling_off' });
  await Lead.create({ ref: 'KB-2026-000402', affiliate_id: aff._id, replacement_status: 'required', replacement_reason: 'signature' });
  await Lead.create({ ref: 'KB-2026-000403', affiliate_id: aff._id, replacement_status: 'supplied' }); // legacy, no reason
  await Lead.create({ ref: 'KB-2026-000404', affiliate_id: aff._id }); // no obligation

  const cooling = await request(app).get('/api/v1/dashboard/leads?replacement_reason=cooling_off').set(auth);
  assert.deepStrictEqual(cooling.body.rows.map((r) => r.ref), ['KB-2026-000401']);

  const sig = await request(app).get('/api/v1/dashboard/leads?replacement_reason=signature&replacement_status=supplied_or_closed').set(auth);
  assert.deepStrictEqual(sig.body.rows.map((r) => r.ref), ['KB-2026-000403']);

  // reason=signature ALONE (no replacement_status) must not fall back to matching
  // every no-obligation lead just because replacement_reason is absent on them too.
  const sigAlone = await request(app).get('/api/v1/dashboard/leads?replacement_reason=signature').set(auth);
  assert.deepStrictEqual(sigAlone.body.rows.map((r) => r.ref).sort(), ['KB-2026-000402', 'KB-2026-000403']);
});

test('admin PATCH cancelled:true then cancelled:false — obligation survives un-cancel, money restored', async () => {
  const { admin, affA } = await seed();
  const app = createApp();
  const auth = { Authorization: `Bearer ${signToken(admin)}` };
  const lead = await Lead.create({
    ref: 'KB-2026-000501', affiliate_id: affA._id, lead_source: 'aaa', applicant_name: 'Cancel Test',
    initial_status: 'accepted', search_status: 'virgin', payable_status: 'payable',
    amounts: { upfront_due: 40, confirmation_due: 0, total_due: 40 },
  });

  const cancelRes = await request(app).patch(`/api/v1/dashboard/leads/${lead._id}`).set(auth).send({ cancelled: true });
  assert.strictEqual(cancelRes.status, 200);
  assert.strictEqual(cancelRes.body.cancelled, true);
  assert.ok(cancelRes.body.cancelled_at);
  assert.strictEqual(cancelRes.body.replacement_status, 'required');
  assert.strictEqual(cancelRes.body.replacement_reason, 'cooling_off');
  assert.strictEqual(cancelRes.body.payable_status, 'not_payable');
  assert.strictEqual(cancelRes.body.amounts.total_due, 0);
  const cancelledAt = cancelRes.body.cancelled_at;

  const uncancelRes = await request(app).patch(`/api/v1/dashboard/leads/${lead._id}`).set(auth).send({ cancelled: false });
  assert.strictEqual(uncancelRes.status, 200);
  assert.strictEqual(uncancelRes.body.cancelled, false);
  assert.strictEqual(uncancelRes.body.cancelled_at, cancelledAt); // never reset
  assert.strictEqual(uncancelRes.body.replacement_status, 'required'); // obligation survives un-cancel
  assert.strictEqual(uncancelRes.body.payable_status, 'payable');
  assert.strictEqual(uncancelRes.body.amounts.total_due, 40); // money restored to virgin rate
});
