const { test } = require('node:test');
const assert = require('node:assert');
const { applyStatusChanges } = require('../services/statusService');

const rates = { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 };

function freshLead() {
  return {
    initial_status: 'pending',
    rejection_reason: undefined,
    search_status: 'unknown',
    signature_status: 'pending',
    law_firm_confirmed: false,
    platform_ref: undefined,
    payable_status: 'not_payable',
    needs_replacement: false,
    replaced_by_lead: null,
    amounts: { upfront_due: 0, confirmation_due: 0, total_due: 0 },
    history: [],
  };
}

test('acceptance as virgin records history and money', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', search_status: 'virgin' }, rates, { source: 'import', user: 'admin@x.com' });
  assert.strictEqual(lead.initial_status, 'accepted');
  assert.strictEqual(lead.payable_status, 'payable');
  assert.strictEqual(lead.amounts.total_due, 40);
  const fields = lead.history.map((h) => h.field);
  assert.ok(fields.includes('initial_status'));
  assert.ok(fields.includes('search_status'));
  assert.ok(fields.includes('payable_status'));
  assert.strictEqual(lead.history[0].source, 'import');
  assert.strictEqual(lead.history[0].user, 'admin@x.com');
});

test('no-op change appends no history', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'pending' }, rates, { source: 'manual' });
  assert.strictEqual(lead.history.length, 0);
});

test('non-updatable fields in changes are ignored', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { ref: 'HACK', amounts: { total_due: 999 }, payable_status: 'payable_full' }, rates, { source: 'manual' });
  assert.strictEqual(lead.amounts.total_due, 0);
  assert.strictEqual(lead.payable_status, 'not_payable');
});

test('signature failure flags needs_replacement and zeroes money', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', search_status: 'virgin' }, rates, { source: 'import' });
  applyStatusChanges(lead, { signature_status: 'failed' }, rates, { source: 'webhook' });
  assert.strictEqual(lead.needs_replacement, true);
  assert.strictEqual(lead.payable_status, 'not_payable');
  assert.strictEqual(lead.amounts.total_due, 0);
  assert.ok(lead.history.some((h) => h.field === 'needs_replacement' && h.to === true));
});

test('law firm confirmation upgrades searched lead to payable_full', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', search_status: 'searched' }, rates, { source: 'import' });
  assert.strictEqual(lead.payable_status, 'partial_pending_confirmation');
  applyStatusChanges(lead, { law_firm_confirmed: true }, rates, { source: 'import' });
  assert.strictEqual(lead.payable_status, 'payable_full');
  assert.strictEqual(lead.amounts.total_due, 40);
});

test('signature failure opens a replacement obligation and starts the 72h clock', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', search_status: 'virgin' }, rates, { source: 'import' });
  applyStatusChanges(lead, { signature_status: 'failed' }, rates, { source: 'webhook' });
  assert.strictEqual(lead.replacement_status, 'required');
  assert.ok(lead.replacement_requested_at instanceof Date);
  assert.strictEqual(lead.payable_status, 'not_payable');
  const fields = lead.history.map((h) => h.field);
  assert.ok(fields.includes('replacement_status'));
  assert.ok(fields.includes('replacement_requested_at'));
});

test('re-applying a failed signature does not reset the clock or duplicate history', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', signature_status: 'failed' }, rates, { source: 'webhook' });
  const firstClock = lead.replacement_requested_at;
  const historyLen = lead.history.length;
  applyStatusChanges(lead, { signature_status: 'failed' }, rates, { source: 'import' });
  assert.strictEqual(lead.replacement_requested_at, firstClock);
  assert.strictEqual(lead.history.length, historyLen);
});

test('linking a replacement moves the original to supplied', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', signature_status: 'failed' }, rates, { source: 'webhook' });
  lead.replaced_by_lead = 'someObjectId'; // linking is done by the route; choke point reacts
  applyStatusChanges(lead, {}, rates, { source: 'api' });
  assert.strictEqual(lead.replacement_status, 'supplied');
  assert.strictEqual(lead.payable_status, 'replaced');
});

test('a linked lead that was never required still becomes supplied (pre-feature data)', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', search_status: 'virgin' }, rates, { source: 'import' });
  lead.replaced_by_lead = 'someObjectId';
  applyStatusChanges(lead, {}, rates, { source: 'manual' });
  assert.strictEqual(lead.replacement_status, 'supplied');
});
