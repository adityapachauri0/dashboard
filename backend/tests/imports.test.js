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
const CSV = [
  'Our Ref,Status,Search Type,Signature,Confirmed,Reason',
  'KB-2026-000001,Accepted,already searched,signed,,',
  'KB-2026-000002,Declined,,,,No credit file',
  'KB-2026-999999,Accepted,virgin,,,',
].join('\n');
const MAPPING = {
  match_by: 'ref',
  columns: {
    ref: 'Our Ref', initial_status: 'Status', search_status: 'Search Type',
    signature_status: 'Signature', law_firm_confirmed: 'Confirmed', rejection_reason: 'Reason',
  },
};

async function seed() {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: rates });
  await Lead.create({ ref: 'KB-2026-000001', affiliate_id: aff._id, lead_source: 'aaa', applicant_name: 'One' });
  await Lead.create({ ref: 'KB-2026-000002', affiliate_id: aff._id, lead_source: 'aaa', applicant_name: 'Two' });
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  return signToken(admin);
}

test('preview returns headers and sample rows', async () => {
  const token = await seed();
  const res = await request(createApp())
    .post('/api/v1/imports/preview')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(CSV), 'report.csv');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.headers, ['Our Ref', 'Status', 'Search Type', 'Signature', 'Confirmed', 'Reason']);
  assert.strictEqual(res.body.rows.length, 3);
});

test('apply updates matched leads, counts unmatched, saves record', async () => {
  const token = await seed();
  const app = createApp();
  const res = await request(app)
    .post('/api/v1/imports')
    .set('Authorization', `Bearer ${token}`)
    .field('mapping', JSON.stringify(MAPPING))
    .attach('file', Buffer.from(CSV), 'report.csv');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(
    { row_count: res.body.row_count, matched: res.body.matched, unmatched: res.body.unmatched },
    { row_count: 3, matched: 2, unmatched: 1 }
  );
  const one = await Lead.findOne({ ref: 'KB-2026-000001' });
  assert.strictEqual(one.initial_status, 'accepted');
  assert.strictEqual(one.search_status, 'searched');
  assert.strictEqual(one.signature_status, 'passed');
  assert.strictEqual(one.payable_status, 'partial_pending_confirmation');
  assert.strictEqual(one.amounts.total_due, 15);
  assert.ok(one.history.every((h) => h.source === 'import' && h.user === 'admin@x.com'));
  const two = await Lead.findOne({ ref: 'KB-2026-000002' });
  assert.strictEqual(two.initial_status, 'rejected');
  assert.strictEqual(two.rejection_reason, 'No credit file');
  const last = await request(app).get('/api/v1/imports/last-mapping').set('Authorization', `Bearer ${token}`);
  assert.deepStrictEqual(last.body, MAPPING);
});
