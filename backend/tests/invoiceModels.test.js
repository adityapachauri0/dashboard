const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Invoice = require('../models/Invoice');
const ReconSend = require('../models/ReconSend');
const mongoose = require('mongoose');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

const base = {
  number: 'BlueLion 001', seq: 1, period_start: '2026-07-18', period_end: '2026-07-18',
  invoice_date: new Date(), lines: [{ description: 'PCP Claim Accepted Not Searched', qty: 2, rate: 110, amount: 220 }],
  net: 220, vat: 44, gross: 264,
};

test('invoice defaults and duplicate period rejected', async () => {
  const inv = await Invoice.create(base);
  assert.strictEqual(inv.type, 'daily');
  assert.strictEqual(inv.email_status, 'pending');
  assert.strictEqual(inv.payment_status, 'awaiting');
  await Invoice.syncIndexes();
  await assert.rejects(Invoice.create({ ...base, number: 'BlueLion 002', seq: 2 }), /duplicate/i);
});

test('same period allowed for different type', async () => {
  await Invoice.syncIndexes();
  await Invoice.create(base);
  const conf = await Invoice.create({ ...base, number: 'BlueLion 002', seq: 2, type: 'confirmation' });
  assert.strictEqual(conf.type, 'confirmation');
});

test('recon send unique per affiliate+day', async () => {
  const aid = new mongoose.Types.ObjectId();
  await ReconSend.syncIndexes();
  await ReconSend.create({ affiliate_id: aid, day: '2026-07-18', sent_at: new Date() });
  await assert.rejects(ReconSend.create({ affiliate_id: aid, day: '2026-07-18' }), /duplicate/i);
});
