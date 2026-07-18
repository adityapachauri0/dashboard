// backend/tests/affiliateRecon.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const ReconSend = require('../models/ReconSend');
const { buildAffiliateRecons } = require('../services/affiliateRecon');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

const NOW = new Date('2026-07-19T08:00:00Z'); // 09:00 London, reporting day 2026-07-18

async function mkAff(name, email) {
  return Affiliate.create({
    name, lead_source: name.toLowerCase(), contact_name: 'Ali', contact_email: email,
    rate_card: { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 },
  });
}
const mkLead = (aff, over = {}) => Lead.create({
  ref: `KB-${Math.random().toString(36).slice(2, 10)}`, affiliate_id: aff._id,
  submitted_at: new Date('2026-07-18T10:00:00Z'), initial_status: 'accepted',
  search_status: 'virgin', signature_status: 'passed', ...over,
});

test('builds recon with affiliate rates and VAT; skips no-activity and no-email affiliates', async () => {
  const a = await mkAff('Claim3000', 'ali@claim3000.co.uk');
  await mkLead(a);
  await mkLead(a, { search_status: 'searched' });
  const idle = await mkAff('Idle', 'idle@x.com');       // no leads — no email
  const noEmail = await mkAff('NoMail', undefined);      // leads but no address — skipped
  await mkLead(noEmail);
  const recons = await buildAffiliateRecons(NOW);
  assert.strictEqual(recons.length, 1);
  const r = recons[0];
  assert.strictEqual(r.to, 'ali@claim3000.co.uk');
  assert.strictEqual(r.day, '2026-07-18');
  assert.match(r.subject, /Daily Lead Reconciliation – Claim3000 – 18\/07\/2026/);
  assert.match(r.text, /Fully Payable Leads: 1/);
  assert.match(r.text, /Part-Payable Leads: 1/);
  assert.match(r.text, /Net Amount: £55\.00/);       // 40 + 15
  assert.match(r.text, /VAT at 20%: £11\.00/);
  assert.match(r.text, /Total Including VAT: £66\.00/);
  assert.ok(Buffer.isBuffer(r.xlsx));
});

test('replacement obligation opened yesterday triggers email even with no leads', async () => {
  const a = await mkAff('Claim3000', 'ali@claim3000.co.uk');
  await mkLead(a, {
    submitted_at: new Date('2026-07-10T10:00:00Z'), signature_status: 'failed',
    replacement_status: 'required', replacement_reason: 'signature',
    replacement_requested_at: new Date('2026-07-18T11:00:00Z'),
  });
  const recons = await buildAffiliateRecons(NOW);
  assert.strictEqual(recons.length, 1);
  assert.match(recons[0].text, /Fully Payable Leads: 0/);
});

test('already-sent day (ReconSend row) is not rebuilt', async () => {
  const a = await mkAff('Claim3000', 'ali@claim3000.co.uk');
  await mkLead(a);
  await ReconSend.create({ affiliate_id: a._id, day: '2026-07-18', sent_at: new Date() });
  assert.strictEqual((await buildAffiliateRecons(NOW)).length, 0);
});
