const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

test('login returns token for valid credentials', async () => {
  await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('secret1', 10), role: 'admin' });
  const res = await request(createApp())
    .post('/api/v1/auth/login')
    .send({ email: 'admin@x.com', password: 'secret1' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token);
  assert.strictEqual(res.body.role, 'admin');
});

test('login rejects bad password', async () => {
  await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('secret1', 10), role: 'admin' });
  const res = await request(createApp())
    .post('/api/v1/auth/login')
    .send({ email: 'admin@x.com', password: 'wrong' });
  assert.strictEqual(res.status, 401);
});

test('requireAuth blocks missing/invalid token', async () => {
  const res = await request(createApp()).get('/api/v1/dashboard/leads');
  assert.strictEqual(res.status, 401);
});
