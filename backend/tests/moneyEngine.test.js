const { test } = require('node:test');
const assert = require('node:assert');
const { computeMoney } = require('../services/moneyEngine');

const rates = { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 };
const base = {
  initial_status: 'accepted',
  search_status: 'virgin',
  signature_status: 'pending',
  law_firm_confirmed: false,
  replaced_by_lead: null,
};

test('accepted virgin -> full virgin rate, payable', () => {
  assert.deepStrictEqual(computeMoney(base, rates), {
    upfront_due: 40, confirmation_due: 0, total_due: 40, payable_status: 'payable',
  });
});

test('accepted searched, unconfirmed -> upfront only, partial_pending_confirmation', () => {
  const m = computeMoney({ ...base, search_status: 'searched' }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 15, confirmation_due: 0, total_due: 15, payable_status: 'partial_pending_confirmation',
  });
});

test('accepted searched, confirmed -> full amount, payable_full', () => {
  const m = computeMoney({ ...base, search_status: 'searched', law_firm_confirmed: true }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 15, confirmation_due: 25, total_due: 40, payable_status: 'payable_full',
  });
});

test('rejected -> zero, not_payable', () => {
  const m = computeMoney({ ...base, initial_status: 'rejected' }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 0, confirmation_due: 0, total_due: 0, payable_status: 'not_payable',
  });
});

test('pending -> zero, not_payable', () => {
  const m = computeMoney({ ...base, initial_status: 'pending' }, rates);
  assert.strictEqual(m.payable_status, 'not_payable');
  assert.strictEqual(m.total_due, 0);
});

test('signature failed -> zero, not_payable (even if virgin accepted)', () => {
  const m = computeMoney({ ...base, signature_status: 'failed' }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 0, confirmation_due: 0, total_due: 0, payable_status: 'not_payable',
  });
});

test('replaced lead -> zero, replaced (never double-billed)', () => {
  const m = computeMoney({ ...base, replaced_by_lead: 'someObjectId' }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 0, confirmation_due: 0, total_due: 0, payable_status: 'replaced',
  });
});

test('accepted but search class unknown -> zero, not_payable until classified', () => {
  const m = computeMoney({ ...base, search_status: 'unknown' }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 0, confirmation_due: 0, total_due: 0, payable_status: 'not_payable',
  });
});
