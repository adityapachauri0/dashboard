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
const { STORAGE_DIR, periodBounds } = require('../services/invoiceService');
const invoicePdf = require('../services/invoicePdf');

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

test('containment: artifact render failure marks invoice failed, does not crash runDaily, recons still attempted', async () => {
  await seedDay();
  const original = invoicePdf.renderInvoicePdf;
  invoicePdf.renderInvoicePdf = async () => { throw new Error('pdf render boom'); };
  try {
    const sent = [];
    const summary = await runDaily(NOW, { send: async (m) => { sent.push(m); } });
    assert.strictEqual(summary.invoice.email_status, 'failed');
    assert.strictEqual(summary.recons_sent, 1);
    const inv = await Invoice.findOne({ number: 'BlueLion 001' });
    assert.strictEqual(inv.email_error, 'pdf render boom');
    assert.ok(!inv.pdf_file);
  } finally {
    invoicePdf.renderInvoicePdf = original;
  }
});

test('backfill: 2-days-ago day with no invoice row is generated and sent; yesterday still processed normally', async () => {
  const aff = await Affiliate.create({
    name: 'Claim3000', lead_source: 'claim3000', contact_email: 'ali@claim3000.co.uk',
    rate_card: { virgin_rate: 40, searched_upfront_rate: 15 },
  });
  // day D = 2026-07-17 (NOW - 2 days) — no Invoice row exists for this day yet
  await Lead.create({
    ref: 'KB-2026-000301', affiliate_id: aff._id, submitted_at: new Date('2026-07-17T10:00:00Z'),
    initial_status: 'accepted', search_status: 'virgin', signature_status: 'passed',
  });
  // yesterday (2026-07-18) — normal day, unrelated to the backfill
  await Lead.create({
    ref: 'KB-2026-000302', affiliate_id: aff._id, submitted_at: new Date('2026-07-18T10:00:00Z'),
    initial_status: 'accepted', search_status: 'virgin', signature_status: 'passed',
  });

  const sent = [];
  const summary = await runDaily(NOW, { send: async (m) => { sent.push(m); } });

  assert.strictEqual(summary.backfilled, 1);
  assert.strictEqual(await Invoice.countDocuments(), 2);

  const backfilledInv = await Invoice.findOne({ period_end: '2026-07-17' });
  assert.ok(backfilledInv, 'day D invoice row should exist');
  assert.strictEqual(backfilledInv.email_status, 'sent');
  assert.ok(backfilledInv.pdf_file);
  assert.ok(fs.existsSync(path.join(STORAGE_DIR, backfilledInv.pdf_file)));

  // normal yesterday behaviour unchanged
  assert.ok(summary.invoice, 'yesterday invoice summary should still be populated');
  assert.strictEqual(summary.day, '2026-07-18');
  const yesterdayInv = await Invoice.findOne({ period_end: '2026-07-18' });
  assert.strictEqual(summary.invoice.number, yesterdayInv.number);
  assert.strictEqual(yesterdayInv.email_status, 'sent');
});

test('recovery: stranded invoice (row saved, artifacts never written) is healed and emailed on retry', async () => {
  const aff = await Affiliate.create({
    name: 'Claim3000', lead_source: 'claim3000', contact_email: 'ali@claim3000.co.uk',
    rate_card: { virgin_rate: 40, searched_upfront_rate: 15 },
  });
  const oldPeriod = '2026-07-17';
  const bounds = periodBounds(oldPeriod);
  await Lead.create({
    ref: 'KB-2026-000199', affiliate_id: aff._id,
    submitted_at: new Date(bounds.start.getTime() + 3600 * 1000),
    initial_status: 'accepted', search_status: 'virgin', signature_status: 'passed',
  });
  await Invoice.create({
    number: 'BlueLion 001', seq: 1, type: 'daily',
    period_start: oldPeriod, period_end: oldPeriod, invoice_date: new Date('2026-07-17T09:00:00Z'),
    lines: [
      { description: 'PCP Claim Accepted Not Searched', qty: 1, rate: 110, amount: 110 },
      { description: 'PCP Claim Payable Previous Search', qty: 0, rate: 30, amount: 0 },
    ],
    net: 110, vat: 22, gross: 132,
    email_to: 'accounts@bluelion.test', email_status: 'pending',
  });

  const sent = [];
  const summary = await runDaily(NOW, { send: async (m) => { sent.push(m); } });
  assert.strictEqual(summary.retried, 1);
  const inv = await Invoice.findOne({ number: 'BlueLion 001' });
  assert.strictEqual(inv.email_status, 'sent');
  assert.ok(inv.pdf_file);
  assert.ok(inv.xlsx_file);
  assert.ok(fs.existsSync(path.join(STORAGE_DIR, inv.pdf_file)));
  assert.ok(fs.existsSync(path.join(STORAGE_DIR, inv.xlsx_file)));
  const invMail = sent.find((m) => m.subject.includes('BlueLion 001'));
  assert.ok(invMail, 'stranded invoice should have been emailed');
  assert.deepStrictEqual(invMail.attachments.map((a) => a.filename), ['Invoice BlueLion 001.pdf', 'Reconciliation BlueLion 001.xlsx']);
});
