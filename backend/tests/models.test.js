const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const { nextLeadRef } = require('../models/Counter');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

test('nextLeadRef produces sequential zero-padded refs', async () => {
  const a = await nextLeadRef(new Date('2026-07-08'));
  const b = await nextLeadRef(new Date('2026-07-08'));
  assert.strictEqual(a, 'KB-2026-000001');
  assert.strictEqual(b, 'KB-2026-000002');
});

test('nextLeadRef sequence resets for a new year', async () => {
  const a = await nextLeadRef(new Date('2026-07-08'));
  const b = await nextLeadRef(new Date('2027-01-02'));
  assert.strictEqual(a, 'KB-2026-000001');
  assert.strictEqual(b, 'KB-2027-000001');
});

test('lead defaults match spec', async () => {
  const aff = await Affiliate.create({ name: 'Acme Leads', lead_source: 'acme' });
  const lead = await Lead.create({
    ref: 'KB-2026-000001',
    affiliate_id: aff._id,
    lead_source: 'acme',
    applicant_name: 'John Smith',
    payload: { first_name: 'John' },
  });
  assert.strictEqual(lead.initial_status, 'pending');
  assert.strictEqual(lead.search_status, 'unknown');
  assert.strictEqual(lead.signature_status, 'pending');
  assert.strictEqual(lead.payable_status, 'not_payable');
  assert.strictEqual(lead.law_firm_confirmed, false);
  assert.strictEqual(lead.needs_replacement, false);
  assert.strictEqual(lead.amounts.total_due, 0);
});

test('affiliate lead_source is unique', async () => {
  await Affiliate.create({ name: 'A', lead_source: 'dup' });
  await Affiliate.ensureIndexes();
  await assert.rejects(Affiliate.create({ name: 'B', lead_source: 'dup' }));
});

test('lead has replacement lifecycle fields with safe defaults', async () => {
  const aff = await Affiliate.create({ name: 'R', lead_source: 'rrr' });
  const lead = await Lead.create({ ref: 'KB-2026-900001', affiliate_id: aff._id });
  assert.strictEqual(lead.replacement_status, 'none');
  assert.strictEqual(lead.replacement_requested_at, undefined);
  await assert.rejects(
    Lead.create({ ref: 'KB-2026-900002', affiliate_id: aff._id, replacement_status: 'bogus' }),
    /replacement_status/
  );
});
