const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');
const Affiliate = require('../models/Affiliate');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

test('admin login enrols then requires TOTP; valid code returns token', async () => {
  await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('secret1', 10), role: 'admin' });
  const app = createApp();

  // 1. password only -> 401 with enrolment material
  const first = await request(app).post('/api/v1/auth/login').send({ email: 'admin@x.com', password: 'secret1' });
  assert.strictEqual(first.status, 401);
  assert.strictEqual(first.body.totp_required, true);
  assert.ok(first.body.totp_setup.secret);
  assert.match(first.body.totp_setup.otpauth_url, /^otpauth:\/\/totp\//);

  // 2. password + valid code -> enabled + token
  const code = authenticator.generate(first.body.totp_setup.secret);
  const second = await request(app).post('/api/v1/auth/login').send({ email: 'admin@x.com', password: 'secret1', code });
  assert.strictEqual(second.status, 200);
  assert.ok(second.body.token);
  assert.strictEqual(second.body.role, 'admin');
  const user = await User.findOne({ email: 'admin@x.com' });
  assert.strictEqual(user.totp_enabled, true);

  // 3. once enabled: password only -> 401 WITHOUT the secret; bad code -> 401
  const third = await request(app).post('/api/v1/auth/login').send({ email: 'admin@x.com', password: 'secret1' });
  assert.strictEqual(third.status, 401);
  assert.strictEqual(third.body.totp_required, true);
  assert.strictEqual(third.body.totp_setup, undefined);
  const bad = await request(app).post('/api/v1/auth/login').send({ email: 'admin@x.com', password: 'secret1', code: '000000' });
  assert.strictEqual(bad.status, 401);

  // 4. password + fresh code -> token
  const fourth = await request(app).post('/api/v1/auth/login')
    .send({ email: 'admin@x.com', password: 'secret1', code: authenticator.generate(user.totp_secret) });
  assert.strictEqual(fourth.status, 200);
  assert.ok(fourth.body.token);
});

test('affiliate login is unaffected by TOTP', async () => {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa' });
  await User.create({ email: 'a@x.com', password_hash: bcrypt.hashSync('secret1', 10), role: 'affiliate', affiliate_id: aff._id });
  const res = await request(createApp()).post('/api/v1/auth/login').send({ email: 'a@x.com', password: 'secret1' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token);
  assert.strictEqual(res.body.role, 'affiliate');
});

test('login rejects bad password (no TOTP material leaked)', async () => {
  await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('secret1', 10), role: 'admin' });
  const res = await request(createApp())
    .post('/api/v1/auth/login')
    .send({ email: 'admin@x.com', password: 'wrong' });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.totp_setup, undefined);
  assert.strictEqual(res.body.totp_required, undefined);
});

test('requireAuth blocks missing/invalid token', async () => {
  const res = await request(createApp()).get('/api/v1/dashboard/leads');
  assert.strictEqual(res.status, 401);
});
