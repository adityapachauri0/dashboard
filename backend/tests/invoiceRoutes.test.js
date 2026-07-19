const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');
const Invoice = require('../models/Invoice');
const { signToken } = require('../middleware/auth');
const { STORAGE_DIR, ensureStorage } = require('../services/invoiceService');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

async function tokenFor(role) {
  const u = await User.create({ email: `${role}@x.com`, password_hash: bcrypt.hashSync('p', 10), role });
  return signToken(u);
}

const mkInvoice = (over = {}) => Invoice.create({
  number: over.number || 'BlueLion 001', seq: over.seq || 1, period_start: '2026-07-18', period_end: over.period_end || '2026-07-18',
  invoice_date: new Date(), lines: [], net: 110, vat: 22, gross: 132, email_status: 'sent', ...over,
});

test('list is admin-only and sorted newest first', async () => {
  const app = createApp();
  await mkInvoice();
  await mkInvoice({ number: 'BlueLion 002', seq: 2, period_end: '2026-07-19' });
  const forbidden = await request(app).get('/api/v1/invoices').set('Authorization', `Bearer ${await tokenFor('affiliate')}`);
  assert.strictEqual(forbidden.status, 403);
  const res = await request(app).get('/api/v1/invoices').set('Authorization', `Bearer ${await tokenFor('admin')}`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.map((i) => i.number), ['BlueLion 002', 'BlueLion 001']);
});

test('pdf download streams stored file; 404 when file missing', async () => {
  const app = createApp();
  ensureStorage();
  fs.writeFileSync(path.join(STORAGE_DIR, 'BlueLion-001.pdf'), '%PDF-test');
  const withFile = await mkInvoice({ pdf_file: 'BlueLion-001.pdf' });
  const without = await mkInvoice({ number: 'BlueLion 002', seq: 2, period_end: '2026-07-19' });
  const token = await tokenFor('admin');
  const ok = await request(app).get(`/api/v1/invoices/${withFile._id}/pdf`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(ok.status, 200);
  assert.match(ok.headers['content-disposition'], /Invoice BlueLion 001\.pdf/);
  const missing = await request(app).get(`/api/v1/invoices/${without._id}/pdf`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(missing.status, 404);
});

test('patch payment_status validates value', async () => {
  const app = createApp();
  const inv = await mkInvoice();
  const token = await tokenFor('admin');
  const ok = await request(app).patch(`/api/v1/invoices/${inv._id}`).set('Authorization', `Bearer ${token}`).send({ payment_status: 'paid' });
  assert.strictEqual(ok.body.payment_status, 'paid');
  const bad = await request(app).patch(`/api/v1/invoices/${inv._id}`).set('Authorization', `Bearer ${token}`).send({ payment_status: 'nonsense' });
  assert.strictEqual(bad.status, 400);
});
