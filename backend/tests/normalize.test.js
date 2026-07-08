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
