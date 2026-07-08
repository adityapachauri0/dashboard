const express = require('express');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { applyStatusChanges } = require('../services/statusService');
const { buildLeadFilter } = require('../services/leadFilter');

const router = express.Router();

router.get('/dashboard/leads', requireAuth, async (req, res) => {
  const filter = buildLeadFilter(req.query, req.user);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const [total, rows] = await Promise.all([
    Lead.countDocuments(filter),
    Lead.find(filter).sort({ submitted_at: -1 }).skip((page - 1) * limit).limit(limit)
      .select('-payload -history').populate('affiliate_id', 'name lead_source').lean(),
  ]);
  res.json({ rows, total });
});

router.get('/dashboard/leads/:id', requireAuth, async (req, res) => {
  const lead = await Lead.findById(req.params.id)
    .populate('affiliate_id', 'name lead_source')
    .populate('replaces_lead', 'ref')
    .populate('replaced_by_lead', 'ref')
    .lean();
  if (!lead) return res.status(404).json({ error: 'not found' });
  if (req.user.role === 'affiliate' && String(lead.affiliate_id._id) !== String(req.user.affiliate_id)) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json(lead);
});

router.patch('/dashboard/leads/:id', requireAuth, requireAdmin, async (req, res) => {
  // Injection guard — at the top of the PATCH handler, before using req.body.replaces_ref
  if ('replaces_ref' in req.body && typeof req.body.replaces_ref !== 'string') {
    return res.status(400).json({ error: 'replaces_ref must be a string' });
  }

  const lead = await Lead.findById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const affiliate = await Affiliate.findById(lead.affiliate_id);
  const meta = { source: 'manual', user: req.user.email };
  const now = new Date();

  if (req.body.replaces_ref) {
    if (lead.replaces_lead) return res.status(409).json({ error: `lead ${lead.ref} is already a replacement` });
    const original = await Lead.findOne({ ref: req.body.replaces_ref, affiliate_id: lead.affiliate_id });
    if (!original) return res.status(400).json({ error: `replaces_ref ${req.body.replaces_ref} not found for this affiliate` });
    // Double-replacement guard — right after the `if (!original)` check
    if (original.replaced_by_lead) {
      return res.status(409).json({ error: `lead ${original.ref} already replaced` });
    }
    lead.replaces_lead = original._id;
    original.replaced_by_lead = lead._id;
    original.history.push({ at: now, field: 'replaced_by_lead', from: null, to: lead.ref, source: 'manual', user: req.user.email });
    applyStatusChanges(original, {}, affiliate?.rate_card || {}, meta);
    await original.save();
    lead.history.push({ at: now, field: 'replaces_lead', from: null, to: original.ref, source: 'manual', user: req.user.email });
  }

  applyStatusChanges(lead, req.body, affiliate?.rate_card || {}, meta);
  await lead.save();
  res.json(lead.toObject());
});

module.exports = router;
