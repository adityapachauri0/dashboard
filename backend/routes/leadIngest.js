const express = require('express');
const rateLimit = require('express-rate-limit');
const Lead = require('../models/Lead');
const { nextLeadRef } = require('../models/Counter');
const { apiKeyAuth } = require('../middleware/apiKey');
const { applyStatusChanges } = require('../services/statusService');
const { submitLead } = require('../services/platformAdapter');

const router = express.Router();
const ingestLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true });

router.post('/leads', ingestLimiter, apiKeyAuth, async (req, res) => {
  const body = req.body || {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const applicant_name = (str(body.name) || `${str(body.first_name)} ${str(body.last_name)}`).trim();
  if (!applicant_name) return res.status(400).json({ error: 'name (or first_name/last_name) required' });
  if (!body.email && !body.phone) return res.status(400).json({ error: 'email or phone required' });
  if ('replaces_ref' in body && typeof body.replaces_ref !== 'string') {
    return res.status(400).json({ error: 'replaces_ref must be a string' });
  }

  const submitted_at = new Date();
  const lead = new Lead({
    ref: await nextLeadRef(submitted_at),
    affiliate_id: req.affiliate._id,
    lead_source: req.affiliate.lead_source,
    brand: body.brand || req.affiliate.brands?.[0] || '',
    submitted_at,
    signature_deadline: new Date(submitted_at.getTime() + 48 * 3600 * 1000),
    applicant_name,
    payload: body,
  });

  // Replacement for a signature-failed lead: link both ways, zero the original.
  if (body.replaces_ref) {
    const original = await Lead.findOne({ ref: body.replaces_ref, affiliate_id: req.affiliate._id });
    if (!original) return res.status(400).json({ error: `replaces_ref ${body.replaces_ref} not found` });
    if (original.replaced_by_lead) {
      return res.status(409).json({ error: `lead ${original.ref} already replaced` });
    }
    lead.replaces_lead = original._id;
    original.replaced_by_lead = lead._id;
    original.history.push({ at: submitted_at, field: 'replaced_by_lead', from: null, to: lead.ref, source: 'api' });
    applyStatusChanges(original, {}, req.affiliate.rate_card, { source: 'api' });
    await original.save();
    lead.history.push({ at: submitted_at, field: 'replaces_lead', from: null, to: original.ref, source: 'api' });
  }

  // Forward to buyer platform (manual mode returns null -> stays pending).
  const platformResponse = await submitLead(lead);
  if (platformResponse) {
    applyStatusChanges(lead, platformResponse, req.affiliate.rate_card, { source: 'api' });
  }

  await lead.save();
  res.status(201).json({ ref: lead.ref, status: lead.initial_status });
});

module.exports = router;
