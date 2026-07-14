const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const { slaState, propagateReplacementOutcome, SLA_HOURS } = require('../services/replacementService');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

const HOUR = 3600 * 1000;

test('slaState derives countdown, overdue and null cases', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const fresh = { replacement_status: 'required', replacement_requested_at: new Date(now - 5 * HOUR) };
  const s = slaState(fresh, now);
  assert.strictEqual(s.overdue, false);
  assert.strictEqual(s.hours_remaining, SLA_HOURS - 5);
  assert.strictEqual(s.label, `${SLA_HOURS - 5}h remaining`);
  const old = { replacement_status: 'required', replacement_requested_at: new Date(now - 80 * HOUR) };
  assert.strictEqual(slaState(old, now).overdue, true);
  assert.strictEqual(slaState(old, now).label, 'OVERDUE');
  assert.strictEqual(slaState({ replacement_status: 'supplied', replacement_requested_at: new Date() }, now), null);
  assert.strictEqual(slaState({ replacement_status: 'required' }, now), null);
});

async function seedPair() {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: { virgin_rate: 40 } });
  const original = await Lead.create({
    ref: 'KB-2026-000001', affiliate_id: aff._id, initial_status: 'accepted',
    signature_status: 'failed', needs_replacement: true, payable_status: 'not_payable',
    replacement_status: 'required', replacement_requested_at: new Date('2026-07-10T10:00:00Z'),
  });
  const replacement = await Lead.create({
    ref: 'KB-2026-000002', affiliate_id: aff._id, initial_status: 'pending',
    replaces_lead: original._id,
  });
  original.replaced_by_lead = replacement._id;
  original.replacement_status = 'supplied';
  original.payable_status = 'replaced';
  await original.save();
  return { original, replacement };
}

test('replacement accepted closes the original', async () => {
  const { original, replacement } = await seedPair();
  replacement.initial_status = 'accepted';
  const updated = await propagateReplacementOutcome(replacement, { source: 'webhook' });
  assert.strictEqual(updated.replacement_status, 'closed');
  assert.strictEqual(String(updated._id), String(original._id));
  assert.ok(updated.history.some((h) => h.field === 'replacement_status' && h.to === 'closed'));
});

test('replacement rejected reopens the original without resetting the clock', async () => {
  const { original, replacement } = await seedPair();
  replacement.initial_status = 'rejected';
  const updated = await propagateReplacementOutcome(replacement, { source: 'webhook' });
  assert.strictEqual(updated.replacement_status, 'required');
  assert.strictEqual(updated.replaced_by_lead, null);
  assert.strictEqual(updated.replacement_requested_at.toISOString(), '2026-07-10T10:00:00.000Z');
  assert.strictEqual(updated.payable_status, 'not_payable'); // money recomputed — no longer 'replaced'
  assert.ok(updated.history.some((h) => h.field === 'replaced_by_lead' && h.to === null));
});

test('a stale replacement (original re-linked elsewhere) is a no-op', async () => {
  const { original, replacement } = await seedPair();
  const other = await Lead.create({ ref: 'KB-2026-000003', affiliate_id: original.affiliate_id });
  original.replaced_by_lead = other._id;
  await original.save();
  replacement.initial_status = 'accepted';
  assert.strictEqual(await propagateReplacementOutcome(replacement, { source: 'webhook' }), null);
});

test('pending replacement and non-replacement leads are no-ops', async () => {
  const { replacement } = await seedPair();
  assert.strictEqual(await propagateReplacementOutcome(replacement, { source: 'api' }), null); // still pending
  const plain = await Lead.create({ ref: 'KB-2026-000009', affiliate_id: replacement.affiliate_id, initial_status: 'accepted' });
  assert.strictEqual(await propagateReplacementOutcome(plain, { source: 'api' }), null); // no replaces_lead
});
