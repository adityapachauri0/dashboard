const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../server');

test('GET /api/v1/health returns ok', async () => {
  const res = await request(createApp()).get('/api/v1/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true });
});
