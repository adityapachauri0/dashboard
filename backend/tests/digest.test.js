const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const { buildDigest } = require('../services/digest');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

test('digest summarises yesterday per affiliate, month-to-date and attention', async () => {
  const aff = await Affiliate.create({ name: 'Acme Leads', lead_source: 'acme' });
  const now = new Date('2026-07-10T08:00:00Z'); // "yesterday" = 9 Jul
  await Lead.create({ ref: 'KB-2026-000021', affiliate_id: aff._id, submitted_at: new Date('2026-07-09T10:00:00Z'), initial_status: 'accepted', amounts: { upfront_due: 40, confirmation_due: 0, total_due: 40 } });
  await Lead.create({ ref: 'KB-2026-000022', affiliate_id: aff._id, submitted_at: new Date('2026-07-09T11:00:00Z'), initial_status: 'rejected' });
  // earlier in the month, signature overdue
  await Lead.create({ ref: 'KB-2026-000023', affiliate_id: aff._id, submitted_at: new Date('2026-07-02T10:00:00Z'), initial_status: 'accepted', signature_status: 'pending', signature_deadline: new Date('2026-07-04T17:00:00Z'), amounts: { upfront_due: 15, confirmation_due: 0, total_due: 15 } });

  const { subject, text } = await buildDigest(now);
  assert.match(subject, /2 submitted, 1 accepted, £40\.00 due/);
  assert.match(text, /Acme Leads: 2 submitted, 1 accepted, £40\.00 due/);
  assert.match(text, /Month to date: 3 submitted · £55\.00 due/);
  assert.match(text, /1 signature check overdue/);
  assert.match(text, /Dashboard: https:\/\/leads\.click2leads\.co\.uk/);
});

test('digest handles a quiet day', async () => {
  const { subject, text } = await buildDigest(new Date('2026-07-10T08:00:00Z'));
  assert.match(subject, /no leads/);
  assert.match(text, /No leads were submitted yesterday\./);
  assert.match(text, /Nothing needs attention\./);
});
