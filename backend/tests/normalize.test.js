const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeField, canonicalFromPayload } = require('../services/normalize');

test('initial_status variants', () => {
  assert.strictEqual(normalizeField('initial_status', 'Accepted'), 'accepted');
  assert.strictEqual(normalizeField('initial_status', 'APPROVED'), 'accepted');
  assert.strictEqual(normalizeField('initial_status', 'declined'), 'rejected');
  assert.strictEqual(normalizeField('initial_status', 'garbage'), undefined);
});

test('search_status variants', () => {
  assert.strictEqual(normalizeField('search_status', 'Virgin'), 'virgin');
  assert.strictEqual(normalizeField('search_status', 'non-searched'), 'virgin');
  assert.strictEqual(normalizeField('search_status', 'already searched'), 'searched');
});

test('signature_status variants', () => {
  assert.strictEqual(normalizeField('signature_status', 'signed'), 'passed');
  assert.strictEqual(normalizeField('signature_status', 'FALSE'), 'failed');
  assert.strictEqual(normalizeField('signature_status', 'awaiting'), 'pending');
});

test('law_firm_confirmed variants return booleans', () => {
  assert.strictEqual(normalizeField('law_firm_confirmed', 'YES'), true);
  assert.strictEqual(normalizeField('law_firm_confirmed', true), true);
  assert.strictEqual(normalizeField('law_firm_confirmed', 'no'), false);
});

test('canonicalFromPayload maps common webhook shapes, skips junk', () => {
  const changes = canonicalFromPayload({
    status: 'Accepted',
    credit_search: 'already searched',
    signature: 'signed',
    confirmed: 'yes',
    reason: 'n/a-field',
  });
  assert.deepStrictEqual(changes, {
    initial_status: 'accepted',
    search_status: 'searched',
    signature_status: 'passed',
    law_firm_confirmed: true,
    rejection_reason: 'n/a-field',
  });
  assert.deepStrictEqual(canonicalFromPayload({ foo: 'bar' }), {});
});

test('cancellation spellings map to cancelled=true', () => {
  for (const raw of ['cancelled', 'canceled', 'cancellation', 'cooling off', 'cooling-off', 'cooling_off', 'cooled off', 'yes', 'true', true]) {
    assert.strictEqual(normalizeField('cancelled', raw), true, `raw=${raw}`);
  }
});

test('cancelled never maps false — un-cancel is manual-only', () => {
  for (const raw of ['false', 'no', false, 'active', 'random']) {
    assert.strictEqual(normalizeField('cancelled', raw), undefined, `raw=${raw}`);
  }
});

test('canonicalFromPayload picks up cancellation from dedicated and main status keys', () => {
  assert.deepStrictEqual(canonicalFromPayload({ cancelled: true }), { cancelled: true });
  assert.deepStrictEqual(canonicalFromPayload({ cancellation_status: 'cooling-off' }), { cancelled: true });
  assert.deepStrictEqual(canonicalFromPayload({ status: 'cancelled' }), { cancelled: true });
  // a cancelled main status must NOT bleed into initial_status
  assert.strictEqual(canonicalFromPayload({ status: 'cancelled' }).initial_status, undefined);
  // accepted status still works and does not set cancelled
  assert.deepStrictEqual(canonicalFromPayload({ status: 'accepted' }), { initial_status: 'accepted' });
});
