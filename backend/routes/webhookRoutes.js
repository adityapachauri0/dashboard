const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const WebhookEvent = require('../models/WebhookEvent');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { canonicalFromPayload, normalizeEmail, normalizePhone } = require('../services/normalize');
const { applyStatusChanges } = require('../services/statusService');
const { propagateReplacementOutcome } = require('../services/replacementService');
const { nextLeadRef } = require('../models/Counter');
const { applyClientOutcome, canon } = require('../services/clientOutcome');

const router = express.Router();

const webhookLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true });

async function applyEventToLead(event, lead) {
  const changes = canonicalFromPayload(event.payload);
  const pref = event.payload.platform_ref || event.payload.reference || event.payload.id;
  if (pref && !lead.platform_ref) changes.platform_ref = String(pref);
  const affiliate = await Affiliate.findById(lead.affiliate_id);
  // orphaned affiliate -> zero rate card; computeMoney treats missing rates as 0
  applyStatusChanges(lead, changes, affiliate?.rate_card || {}, { source: 'webhook' });
  // one-endpoint integration: a post may carry the commercial outcome too
  const p = event.payload;
  if (typeof p.outcome === 'string' && p.outcome.trim()) {
    const amt = Number(p.amount);
    applyClientOutcome(
      lead,
      {
        client: typeof p.client === 'string' && p.client.trim() ? canon(p.client).slice(0, 40) : 'bluelion',
        outcome: canon(p.outcome).slice(0, 40),
        amount: Number.isFinite(amt) && amt >= 0 ? Math.round(amt * 100) / 100 : undefined,
        reason: typeof p.reason === 'string' ? p.reason.trim().slice(0, 500) : undefined,
      },
      { source: 'webhook' }
    );
  }
  await lead.save();
  await propagateReplacementOutcome(lead, { source: 'webhook' });
  event.matched_lead = lead._id;
  await event.save();
}

// Model B: the platform posts every lead attempt keyed by the supplier's own
// reference (keycode) + supplier brand. Resolve which supplier a payload is for.
const keycodeOf = (p) => {
  const raw = p.keycode ?? p.leadClientRef ?? p.lead_client_ref;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
};
async function affiliateFromPayload(p) {
  const raw = p.brand ?? p.leadSourceBrand ?? p.lead_source ?? p.sub_source;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const key = raw.trim().toLowerCase();
  return Affiliate.findOne({ active: true, $or: [{ lead_source: key }, { brands: key }] });
}

// First sighting of a keycode -> the attempt post itself creates the lead.
async function createLeadFromEvent(event, affiliate, keycode) {
  const p = event.payload;
  const str = (v) => (typeof v === 'string' ? v : '');
  const submitted_at = new Date();
  const lead = new Lead({
    ref: await nextLeadRef(submitted_at),
    keycode,
    affiliate_id: affiliate._id,
    lead_source: affiliate.lead_source,
    brand: str(p.brand) || affiliate.brands?.[0] || '',
    submitted_at,
    signature_deadline: new Date(submitted_at.getTime() + 48 * 3600 * 1000),
    applicant_name: (str(p.name) || `${str(p.first_name)} ${str(p.last_name)}`).trim() || keycode,
    payload: p,
    contact_email: normalizeEmail(p.email),
    contact_phone: normalizePhone(p.phone),
  });
  lead.history.push({ at: submitted_at, field: 'created_via', from: null, to: 'platform_webhook', source: 'webhook' });
  try {
    await applyEventToLead(event, lead);
    return lead;
  } catch (e) {
    // concurrent create of the same keycode lost the race -> update the winner
    if (e.code === 11000) {
      const winner = await Lead.findOne({ affiliate_id: affiliate._id, keycode });
      if (winner) await applyEventToLead(event, winner);
      return winner;
    }
    throw e;
  }
}

// Integrator liveness ping: proves the API is up and the token is valid.
// Touches no data, stores no event. GET or POST.
router.all('/webhooks/platform/ping', webhookLimiter, (req, res) => {
  const configured = process.env.WEBHOOK_TOKEN;
  if (!configured) return res.status(503).json({ error: 'webhook disabled: WEBHOOK_TOKEN not configured' });
  const a = Buffer.from(String(req.query.token || ''));
  const b = Buffer.from(configured);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'bad token' });
  }
  res.json({ ok: true, service: 'click2leads-platform-api' });
});

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
  const keycode = keycodeOf(payload);
  const affiliate = lead || !keycode ? null : await affiliateFromPayload(payload);
  if (!lead && keycode) {
    // brand-scoped first (two suppliers may reuse a ref format), global fallback
    lead = affiliate
      ? await Lead.findOne({ affiliate_id: affiliate._id, keycode })
      : await Lead.findOne({ keycode });
  }
  const pref = payload.platform_ref || payload.reference || payload.id;
  if (!lead && pref) lead = await Lead.findOne({ platform_ref: String(pref) });

  let created = false;
  if (lead) {
    await applyEventToLead(event, lead);
  } else if (keycode && affiliate) {
    lead = await createLeadFromEvent(event, affiliate, keycode);
    created = !!lead;
  }
  res.json({ received: true, matched: !!lead, created });
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
