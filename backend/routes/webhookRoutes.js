const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const WebhookEvent = require('../models/WebhookEvent');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { canonicalFromPayload } = require('../services/normalize');
const { applyStatusChanges } = require('../services/statusService');

const router = express.Router();

const webhookLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true });

async function applyEventToLead(event, lead) {
  const changes = canonicalFromPayload(event.payload);
  const pref = event.payload.platform_ref || event.payload.reference || event.payload.id;
  if (pref && !lead.platform_ref) changes.platform_ref = String(pref);
  const affiliate = await Affiliate.findById(lead.affiliate_id);
  // orphaned affiliate -> zero rate card; computeMoney treats missing rates as 0
  applyStatusChanges(lead, changes, affiliate?.rate_card || {}, { source: 'webhook' });
  await lead.save();
  event.matched_lead = lead._id;
  await event.save();
}

router.post('/webhooks/platform', webhookLimiter, async (req, res) => {
  const configured = process.env.WEBHOOK_TOKEN;
  if (!configured) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'webhook disabled: WEBHOOK_TOKEN not configured' });
    }
  } else {
    const supplied = String(req.query.token || '');
    const a = Buffer.from(supplied);
    const b = Buffer.from(configured);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'bad token' });
    }
  }
  const payload = req.body || {};
  const event = await WebhookEvent.create({ payload, source_ip: req.ip });

  let lead = null;
  if (typeof payload.ref === 'string' && payload.ref.startsWith('KB-')) {
    lead = await Lead.findOne({ ref: payload.ref });
  }
  const pref = payload.platform_ref || payload.reference || payload.id;
  if (!lead && pref) lead = await Lead.findOne({ platform_ref: String(pref) });

  if (lead) await applyEventToLead(event, lead);
  res.json({ received: true, matched: !!lead });
});

router.get('/webhooks/unmatched', requireAuth, requireAdmin, async (req, res) => {
  const events = await WebhookEvent.find({ matched_lead: null }).sort({ at: -1 }).limit(100).lean();
  res.json(events);
});

router.post('/webhooks/:id/match', requireAuth, requireAdmin, async (req, res) => {
  const event = await WebhookEvent.findById(req.params.id);
  if (!event) return res.status(404).json({ error: 'event not found' });
  if (event.matched_lead) return res.status(409).json({ error: 'event already matched' });
  if (typeof req.body?.ref !== 'string') return res.status(400).json({ error: 'ref must be a string' });
  const lead = await Lead.findOne({ ref: req.body.ref });
  if (!lead) return res.status(400).json({ error: 'lead ref not found' });
  await applyEventToLead(event, lead);
  res.json({ matched: true, lead_ref: lead.ref });
});

module.exports = router;
