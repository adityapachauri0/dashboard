const express = require('express');
const rateLimit = require('express-rate-limit');
const Lead = require('../models/Lead');
const { nextLeadRef } = require('../models/Counter');
const { apiKeyAuth } = require('../middleware/apiKey');
const { applyStatusChanges } = require('../services/statusService');
const { submitLead } = require('../services/platformAdapter');
const { normalizeEmail, normalizePhone } = require('../services/normalize');

const DUP_WINDOW_DAYS = 30;

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
    brand: str(body.brand) || req.affiliate.brands?.[0] || '',
    submitted_at,
    signature_deadline: new Date(submitted_at.getTime() + 48 * 3600 * 1000),
    applicant_name,
    payload: body,
    contact_email: normalizeEmail(body.email),
    contact_phone: normalizePhone(body.phone),
  });

  try {
    await lead.validate();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Flag possible duplicates: same normalized email or phone within the window,
  // across ALL affiliates. Replacements are exempt — they intentionally
  // re-submit the same applicant.
  if (!body.replaces_ref) {
    const identity = [];
    if (lead.contact_email) identity.push({ contact_email: lead.contact_email });
    if (lead.contact_phone) identity.push({ contact_phone: lead.contact_phone });
    if (identity.length) {
      const dup = await Lead.findOne({
        $or: identity,
        submitted_at: { $gte: new Date(submitted_at.getTime() - DUP_WINDOW_DAYS * 86400000) },
      }).sort({ submitted_at: -1 }).select('ref').lean();
      if (dup) {
        lead.possible_duplicate = true;
        lead.duplicate_of_ref = dup.ref;
        lead.history.push({ at: submitted_at, field: 'possible_duplicate', from: false, to: true, source: 'api' });
      }
    }
  }

  // Replacement for a signature-failed lead: link both ways, zero the original.
  // Validate the new lead BEFORE touching the original, and claim it atomically
  // (findOneAndUpdate on replaced_by_lead: null) so two concurrent replacements
  // can't both pass a read-then-write check.
  if (body.replaces_ref) {
    const original = await Lead.findOneAndUpdate(
      { ref: body.replaces_ref, affiliate_id: req.affiliate._id, replaced_by_lead: null },
      { replaced_by_lead: lead._id },
      { new: true }
    );
    if (!original) {
      const exists = await Lead.exists({ ref: body.replaces_ref, affiliate_id: req.affiliate._id });
      if (exists) return res.status(409).json({ error: `lead ${body.replaces_ref} already replaced` });
      return res.status(400).json({ error: `replaces_ref ${body.replaces_ref} not found` });
    }
    lead.replaces_lead = original._id;
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
