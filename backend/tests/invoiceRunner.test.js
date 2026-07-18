// backend/tests/invoiceRunner.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const ReconSend = require('../models/ReconSend');
const { runDaily } = require('../services/invoiceRunner');
const { STORAGE_DIR } = require('../services/invoiceService');

before(setupDB);
after(teardownDB);
beforeEach(async () => {
  await clearDB();
  process.env.INVOICE_TO_EMAIL = 'accounts@bluelion.test';
  process.env.INVOICE_CC = 'anthony@click2leads.co.uk';
});

const NOW = new Date('2026-07-19T08:00:00Z');

async function seedDay() {
  const aff = await Affiliate.create({
    name: 'Claim3000', lead_source: 'claim3000', contact_email: 'ali@claim3000.co.uk',
    rate_card: { virgin_rate: 40, searched_upfront_rate: 15 },
  });
  await Lead.create({
    ref: 'KB-2026-000201', affiliate_id: aff._id, submitted_at: new Date('2026-07-18T10:00:00Z'),
    initial_status: 'accepted', search_status: 'virgin', signature_status: 'passed',
  });
  return aff;
}

test('full run: invoice emailed with 2 attachments, artifacts on disk, recon sent+logged', async () => {
  await seedDay();
  const sent = [];
  const summary = await runDaily(NOW, { send: async (m) => { sent.push(m); } });
  assert.strictEqual(summary.invoice.number, 'BlueLion 001');
  assert.strictEqual(summary.invoice.email_status, 'sent');
  assert.strictEqual(summary.recons_sent, 1);
  const invMail = sent.find((m) => m.to === 'accounts@bluelion.test');
  assert.strictEqual(invMail.cc, 'anthony@click2leads.co.uk');
  assert.match(invMail.subject, /Invoice BlueLion 001/);
  assert.match(invMail.text, /18\/07\/2026 00:00 – 18\/07\/2026 23:59/);
  assert.match(invMail.text, /Net Total: £110\.00/);
  assert.deepStrictEqual(invMail.attachments.map((a) => a.filename), ['Invoice BlueLion 001.pdf', 'Reconciliation BlueLion 001.xlsx']);
  const inv = await Invoice.findOne({ number: 'BlueLion 001' });
  assert.ok(fs.existsSync(path.join(STORAGE_DIR, inv.pdf_file)));
  assert.ok(fs.existsSync(path.join(STORAGE_DIR, inv.xlsx_file)));
  assert.strictEqual(await ReconSend.countDocuments(), 1);
});

test('send failure marks invoice failed, next run retries without regenerating', async () => {
  await seedDay();
  const s1 = await runDaily(NOW, { send: async () => { throw new Error('smtp down'); } });
  assert.strictEqual(s1.invoice.email_status, 'failed');
  assert.strictEqual(s1.recons_sent, 0);
  assert.strictEqual(await Invoice.countDocuments(), 1);
  const sent = [];
  const s2 = await runDaily(NOW, { send: async (m) => { sent.push(m); } });
  assert.strictEqual(s2.retried, 1);
  assert.strictEqual(await Invoice.countDocuments(), 1); // no duplicate
  assert.strictEqual((await Invoice.findOne()).email_status, 'sent');
  assert.strictEqual(s2.recons_sent, 1); // recon also recovered
});

test('zero-lead day: no invoice, no recons, no crash', async () => {
  const sent = [];
  const summary = await runDaily(NOW, { send: async (m) => { sent.push(m); } });
  assert.strictEqual(summary.invoice, null);
  assert.strictEqual(sent.length, 0);
});

test('second same-day run is a no-op', async () => {
  await seedDay();
  await runDaily(NOW, { send: async () => {} });
  const sent = [];
  await runDaily(NOW, { send: async (m) => { sent.push(m); } });
  assert.strictEqual(sent.length, 0);
});
