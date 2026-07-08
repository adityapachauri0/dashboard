const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');
const Affiliate = require('../models/Affiliate');
const { signToken } = require('../middleware/auth');
const { sha256hex } = require('../services/apiKeys');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

async function adminToken() {
  const u = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  return signToken(u);
}

test('create affiliate returns api key once and stores only hash', async () => {
  const app = createApp();
  const token = await adminToken();
  const res = await request(app)
    .post('/api/v1/affiliates')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Acme', lead_source: 'acme', brands: ['acmeclaims.co.uk'], rate_card: { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 } });
  assert.strictEqual(res.status, 201);
  assert.ok(res.body.api_key.length >= 32);
  const stored = await Affiliate.findById(res.body.affiliate._id);
  assert.strictEqual(stored.api_key_hash, sha256hex(res.body.api_key));
  assert.ok(!JSON.stringify(res.body.affiliate).includes(res.body.api_key));
});

test('rotate key replaces hash', async () => {
  const app = createApp();
  const token = await adminToken();
  const created = await request(app).post('/api/v1/affiliates').set('Authorization', `Bearer ${token}`).send({ name: 'A', lead_source: 'a1' });
  const oldHash = (await Affiliate.findById(created.body.affiliate._id)).api_key_hash;
  const rotated = await request(app).post(`/api/v1/affiliates/${created.body.affiliate._id}/rotate-key`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(rotated.status, 200);
  const newHash = (await Affiliate.findById(created.body.affiliate._id)).api_key_hash;
  assert.notStrictEqual(oldHash, newHash);
  assert.strictEqual(newHash, sha256hex(rotated.body.api_key));
});

test('non-admin cannot access affiliate routes', async () => {
  const app = createApp();
  const aff = await Affiliate.create({ name: 'X', lead_source: 'x1' });
  const u = await User.create({ email: 'aff@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: aff._id });
  const res = await request(app).get('/api/v1/affiliates').set('Authorization', `Bearer ${signToken(u)}`);
  assert.strictEqual(res.status, 403);
});

test('admin can create affiliate login user', async () => {
  const app = createApp();
  const token = await adminToken();
  const aff = await Affiliate.create({ name: 'X', lead_source: 'x2' });
  const res = await request(app)
    .post(`/api/v1/affiliates/${aff._id}/users`)
    .set('Authorization', `Bearer ${token}`)
    .send({ email: 'supplier@x.com', password: 'pass1234' });
  assert.strictEqual(res.status, 201);
  const u = await User.findOne({ email: 'supplier@x.com' });
  assert.strictEqual(u.role, 'affiliate');
  assert.strictEqual(u.affiliate_id.toString(), aff._id.toString());
});
