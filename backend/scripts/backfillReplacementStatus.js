// One-shot, idempotent backfill for the replacement lifecycle (spec 2026-07-14).
// Usage: node scripts/backfillReplacementStatus.js
require('dotenv').config();
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const { applyStatusChanges } = require('../services/statusService');

(async () => {
  await connectDB();
  const candidates = await Lead.find({
    replacement_status: { $in: [null, 'none'] },
    $or: [{ needs_replacement: true }, { replaced_by_lead: { $ne: null } }],
  }).populate('replaced_by_lead', 'ref initial_status');

  let n = 0;
  for (const lead of candidates) {
    const failedAt = [...lead.history].reverse().find((h) => h.field === 'signature_status' && h.to === 'failed')?.at;
    if (!lead.replacement_requested_at) lead.replacement_requested_at = failedAt || lead.last_updated;

    if (!lead.replaced_by_lead) {
      lead.replacement_status = 'required';
    } else if (lead.replaced_by_lead.initial_status === 'accepted') {
      lead.replacement_status = 'closed';
    } else if (lead.replaced_by_lead.initial_status === 'rejected') {
      // pre-feature data with a rejected replacement: apply the go-forward reopen rule
      lead.history.push({ at: new Date(), field: 'replaced_by_lead', from: lead.replaced_by_lead.ref, to: null, source: 'manual', user: 'backfill' });
      lead.replaced_by_lead = null;
      lead.replacement_status = 'required';
      // money was computed while replaced_by_lead was set (payable_status='replaced');
      // recompute now that the link is cleared, same as the go-forward reopen path.
      const affiliate = await Affiliate.findById(lead.affiliate_id);
      applyStatusChanges(lead, {}, affiliate?.rate_card || {}, { source: 'manual', user: 'backfill' });
    } else {
      lead.replacement_status = 'supplied';
    }
    lead.history.push({ at: new Date(), field: 'replacement_status', from: 'none', to: lead.replacement_status, source: 'manual', user: 'backfill' });
    await lead.save();
    n += 1;
  }
  console.log(`backfilled ${n} leads`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
