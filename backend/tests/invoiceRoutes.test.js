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
const mailer = require('../services/mailer');

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

test('xlsx download streams stored file; 404 when file missing', async () => {
  const app = createApp();
  ensureStorage();
  fs.writeFileSync(path.join(STORAGE_DIR, 'BlueLion-001.xlsx'), 'xlsx-test');
  const withFile = await mkInvoice({ xlsx_file: 'BlueLion-001.xlsx' });
  const without = await mkInvoice({ number: 'BlueLion 002', seq: 2, period_end: '2026-07-19' });
  const token = await tokenFor('admin');
  const ok = await request(app).get(`/api/v1/invoices/${withFile._id}/xlsx`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(ok.status, 200);
  assert.match(ok.headers['content-disposition'], /Reconciliation BlueLion 001\.xlsx/);
  const missing = await request(app).get(`/api/v1/invoices/${without._id}/xlsx`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(missing.status, 404);
});

test('resend success reuses daily recipients (to + cc) and re-stamps sent status', async () => {
  const app = createApp();
  ensureStorage();
  process.env.INVOICE_TO_EMAIL = 'accounts@bluelion.test';
  process.env.INVOICE_CC = 'anthony@click2leads.co.uk';
  fs.writeFileSync(path.join(STORAGE_DIR, 'BlueLion-001.pdf'), '%PDF-test');
  fs.writeFileSync(path.join(STORAGE_DIR, 'BlueLion-001.xlsx'), 'xlsx-test');
  const inv = await mkInvoice({
    pdf_file: 'BlueLion-001.pdf', xlsx_file: 'BlueLion-001.xlsx', email_status: 'failed',
    lines: [{ description: 'Virgin', qty: 2, rate: 40, amount: 80 }, { description: 'Searched', qty: 1, rate: 15, amount: 15 }],
  });
  const token = await tokenFor('admin');
  const calls = [];
  const original = mailer.sendAccountsMail;
  mailer.sendAccountsMail = async (msg) => { calls.push(msg); };
  try {
    const res = await request(app).post(`/api/v1/invoices/${inv._id}/resend`).set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].to, 'accounts@bluelion.test');
    assert.strictEqual(calls[0].cc, 'anthony@click2leads.co.uk');
    assert.deepStrictEqual(calls[0].attachments.map((a) => a.filename), ['Invoice BlueLion 001.pdf', 'Reconciliation BlueLion 001.xlsx']);
    assert.strictEqual(res.body.email_status, 'sent');
    assert.ok(res.body.sent_at);
    const saved = await Invoice.findById(inv._id);
    assert.strictEqual(saved.email_status, 'sent');
    assert.ok(saved.sent_at);
  } finally {
    mailer.sendAccountsMail = original;
  }
});

test('resend 409 when artifacts not stored; mailer not called', async () => {
  const app = createApp();
  const inv = await mkInvoice();
  const token = await tokenFor('admin');
  const calls = [];
  const original = mailer.sendAccountsMail;
  mailer.sendAccountsMail = async (msg) => { calls.push(msg); };
  try {
    const res = await request(app).post(`/api/v1/invoices/${inv._id}/resend`).set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(calls.length, 0);
  } finally {
    mailer.sendAccountsMail = original;
  }
});

test('resend failure returns 502 and persists failed status with error', async () => {
  const app = createApp();
  ensureStorage();
  process.env.INVOICE_TO_EMAIL = 'accounts@bluelion.test';
  process.env.INVOICE_CC = 'anthony@click2leads.co.uk';
  fs.writeFileSync(path.join(STORAGE_DIR, 'BlueLion-001.pdf'), '%PDF-test');
  fs.writeFileSync(path.join(STORAGE_DIR, 'BlueLion-001.xlsx'), 'xlsx-test');
  const inv = await mkInvoice({
    pdf_file: 'BlueLion-001.pdf', xlsx_file: 'BlueLion-001.xlsx',
    lines: [{ description: 'Virgin', qty: 2, rate: 40, amount: 80 }, { description: 'Searched', qty: 1, rate: 15, amount: 15 }],
  });
  const token = await tokenFor('admin');
  const original = mailer.sendAccountsMail;
  mailer.sendAccountsMail = async () => { throw new Error('smtp down'); };
  try {
    const res = await request(app).post(`/api/v1/invoices/${inv._id}/resend`).set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 502);
    assert.match(res.body.error, /send failed/);
    const saved = await Invoice.findById(inv._id);
    assert.strictEqual(saved.email_status, 'failed');
    assert.strictEqual(saved.email_error, 'smtp down');
  } finally {
    mailer.sendAccountsMail = original;
  }
});
