const express = require('express');
const Lead = require('../models/Lead');
const { requireAuth } = require('../middleware/auth');
const { buildLeadFilter } = require('../services/leadFilter');
const { slaState } = require('../services/replacementService');

const router = express.Router();

// Replacement obligations control centre: scoped rows + all-time mini-stat counts.
// Counts ignore the status filter so the header cards stay stable while filtering.
router.get('/dashboard/replacements', requireAuth, async (req, res) => {
  const base = buildLeadFilter({ affiliate_id: req.query.affiliate_id }, req.user);
  const leads = await Lead.find({ ...base, replacement_status: { $ne: 'none' } })
    .sort({ replacement_requested_at: 1 })
    .select('ref affiliate_id submitted_at signature_status replacement_status replacement_requested_at replacement_reason cancelled_at replaced_by_lead')
    .populate('affiliate_id', 'name')
    .populate('replaced_by_lead', 'ref')
    .lean();

  const blank = () => ({ required: 0, supplied: 0, closed: 0, overdue: 0 });
  const counts = { ...blank(), signature: blank(), cooling_off: blank() };
  for (const l of leads) {
    const reason = l.replacement_reason || 'signature';
    counts[l.replacement_status] += 1;
    counts[reason][l.replacement_status] += 1;
    if (slaState(l)?.overdue) { counts.overdue += 1; counts[reason].overdue += 1; }
  }
  const status = req.query.replacement_status;
  const reasonFilter = req.query.replacement_reason;
  const rows = leads
    .filter((l) => (['required', 'supplied', 'closed'].includes(status) ? l.replacement_status === status : true))
    .filter((l) => (['signature', 'cooling_off'].includes(reasonFilter) ? (l.replacement_reason || 'signature') === reasonFilter : true))
    .map((l) => ({ ...l, replacement_reason: l.replacement_reason || 'signature', sla: slaState(l) }));
  res.json({ rows, counts });
});

module.exports = router;
