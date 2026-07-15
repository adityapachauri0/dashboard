const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const { backfillReplacementReason } = require('../scripts/backfillReplacementReason');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

test('stamps signature on legacy obligations only, idempotently', async () => {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: {} });
  const mk = (ref, extra) => Lead.create({ ref, affiliate_id: aff._id, ...extra });
  await mk('KB-2026-000701', { replacement_status: 'required' });   // legacy → signature
  await mk('KB-2026-000702', { replacement_status: 'closed' });     // legacy → signature
  await mk('KB-2026-000703', { replacement_status: 'required', replacement_reason: 'cooling_off' }); // keeps reason
  await mk('KB-2026-000704', {});                                   // no obligation → untouched

  assert.strictEqual(await backfillReplacementReason(), 2);
  assert.strictEqual((await Lead.findOne({ ref: 'KB-2026-000701' })).replacement_reason, 'signature');
  assert.strictEqual((await Lead.findOne({ ref: 'KB-2026-000702' })).replacement_reason, 'signature');
  assert.strictEqual((await Lead.findOne({ ref: 'KB-2026-000703' })).replacement_reason, 'cooling_off');
  assert.strictEqual((await Lead.findOne({ ref: 'KB-2026-000704' })).replacement_reason, undefined);
  assert.ok((await Lead.findOne({ ref: 'KB-2026-000701' })).history.some((h) => h.field === 'replacement_reason' && h.to === 'signature'));

  assert.strictEqual(await backfillReplacementReason(), 0); // idempotent
});
