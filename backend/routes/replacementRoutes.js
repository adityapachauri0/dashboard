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
    .select('ref affiliate_id submitted_at signature_status replacement_status replacement_requested_at replaced_by_lead')
    .populate('affiliate_id', 'name')
    .populate('replaced_by_lead', 'ref')
    .lean();

  const counts = { required: 0, supplied: 0, closed: 0, overdue: 0 };
  for (const l of leads) {
    counts[l.replacement_status] += 1;
    if (slaState(l)?.overdue) counts.overdue += 1;
  }
  const status = req.query.replacement_status;
  const rows = (['required', 'supplied', 'closed'].includes(status) ? leads.filter((l) => l.replacement_status === status) : leads)
    .map((l) => ({ ...l, sla: slaState(l) }));
  res.json({ rows, counts });
});

module.exports = router;
