const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const svc = require('../services/invoiceService');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

// 09:00 London on 19 Jul 2026 (BST) = 08:00Z
const NOW = new Date('2026-07-19T08:00:00Z');

async function seed(overrides = {}) {
  const aff = overrides.affiliate || await Affiliate.create({ name: 'Acme', lead_source: `a${Math.random().toString(36).slice(2, 8)}` });
  return Lead.create({
    ref: overrides.ref || `KB-${Math.random().toString(36).slice(2, 10)}`,
    affiliate_id: aff._id,
    submitted_at: overrides.submitted_at || new Date('2026-07-18T10:00:00Z'),
    initial_status: overrides.initial_status || 'accepted',
    search_status: overrides.search_status || 'virgin',
    signature_status: overrides.signature_status || 'passed',
    cancelled: overrides.cancelled || false,
    replaced_by_lead: overrides.replaced_by_lead || null,
  });
}

test('periodBounds handles BST: London midnight is 23:00Z previous day', () => {
  const b = svc.periodBounds('2026-07-18');
  assert.strictEqual(b.start.toISOString(), '2026-07-17T23:00:00.000Z');
  assert.strictEqual(b.end.toISOString(), '2026-07-18T23:00:00.000Z');
});

test('periodBounds handles GMT: London midnight equals UTC midnight', () => {
  const b = svc.periodBounds('2026-01-15');
  assert.strictEqual(b.start.toISOString(), '2026-01-15T00:00:00.000Z');
});

test('buildLines always emits both lines and computes VAT to 2dp', () => {
  const r = svc.buildLines({ virgin: 12, searched: 2 }, { virgin: 110, searched: 30 });
  assert.deepStrictEqual(r.lines.map((l) => l.amount), [1320, 60]);
  assert.strictEqual(r.net, 1380);
  assert.strictEqual(r.vat, 276);
  assert.strictEqual(r.gross, 1656);
  const zero = svc.buildLines({ virgin: 3, searched: 0 }, { virgin: 110, searched: 30 });
  assert.strictEqual(zero.lines.length, 2);
  assert.strictEqual(zero.lines[1].qty, 0);
});

test('billable rules: excludes pending, cancelled, sig-failed, replaced, unknown', async () => {
  await seed({ search_status: 'virgin' });                                  // billable
  await seed({ search_status: 'searched' });                                // billable
  await seed({ initial_status: 'pending' });
  await seed({ initial_status: 'rejected' });
  await seed({ cancelled: true });
  await seed({ signature_status: 'failed' });
  await seed({ search_status: 'unknown' });
  const other = await seed({ search_status: 'virgin' });
  await Lead.updateOne({ _id: other._id }, { replaced_by_lead: other._id }); // replaced
  await seed({ submitted_at: new Date('2026-07-17T22:00:00Z') });            // 17 Jul London (23:00 London bound)
  const p = await svc.previewDailyInvoice(NOW);
  assert.strictEqual(p.day, '2026-07-18');
  assert.deepStrictEqual(p.counts, { virgin: 1, searched: 1 });
  assert.strictEqual(p.calc.net, 140);
  assert.strictEqual(p.calc.vat, 28);
  assert.strictEqual(p.calc.gross, 168);
});

test('lead submitted 23:30 London lands on that London day (BST edge)', async () => {
  await seed({ submitted_at: new Date('2026-07-18T22:30:00Z') }); // 23:30 London 18 Jul
  const p = await svc.previewDailyInvoice(NOW);
  assert.strictEqual(p.counts.virgin, 1);
});

test('generateDailyInvoice numbers sequentially, idempotent, zero-day null', async () => {
  const empty = await svc.generateDailyInvoice(NOW);
  assert.strictEqual(empty.invoice, null);
  await seed({});
  const first = await svc.generateDailyInvoice(NOW);
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.invoice.number, 'BlueLion 001');
  assert.strictEqual(first.invoice.period_end, '2026-07-18');
  assert.strictEqual(first.leads.length, 1);
  const again = await svc.generateDailyInvoice(NOW);
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.invoice._id.toString(), first.invoice._id.toString());
  assert.strictEqual(await Invoice.countDocuments(), 1);
});

test('generateDailyInvoice returns the existing invoice when create loses a duplicate-key race', async () => {
  await seed({});
  // Simulate a concurrent request that already won: the invoice for this period exists in the DB.
  // Uses a different number/seq than the Counter will hand out below, so the E11000 below is
  // unambiguously the (type, period_end) unique index, not the (number) one.
  const winner = await Invoice.create({
    number: 'BlueLion 002', seq: 2, type: 'daily', period_start: '2026-07-18', period_end: '2026-07-18',
    invoice_date: NOW, lines: [], net: 0, vat: 0, gross: 0, email_to: '',
  });

  // Force the pre-check findOne to miss once (the race window), so generateDailyInvoice proceeds
  // to Invoice.create and collides with `winner` on the unique (type, period_end) index. The
  // recovery findOne inside the fix must hit real data, so only the first call is stubbed.
  const realFindOne = Invoice.findOne.bind(Invoice);
  let first = true;
  Invoice.findOne = (...args) => {
    if (first) { first = false; return Promise.resolve(null); }
    return realFindOne(...args);
  };
  try {
    const result = await svc.generateDailyInvoice(NOW);
    assert.strictEqual(result.created, false);
    assert.strictEqual(result.leads, null);
    assert.strictEqual(result.invoice._id.toString(), winner._id.toString());
    assert.strictEqual(await Invoice.countDocuments(), 1);
  } finally {
    Invoice.findOne = realFindOne;
  }
});
