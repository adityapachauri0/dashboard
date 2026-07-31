const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Lead = require('../models/Lead');
const { apiKeyAuth } = require('../middleware/apiKey');

const router = express.Router();
const outcomeLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true });

// Two callers: suppliers (X-API-Key, scoped to their own leads) and the buying
// client's platform (?token= shared secret, same WEBHOOK_TOKEN as the status
// webhook, any lead). Sets req.affiliate or req.platformAuth.
function outcomeAuth(req, res, next) {
  const token = req.query.token;
  if (token !== undefined) {
    const configured = process.env.WEBHOOK_TOKEN;
    if (!configured) return res.status(401).json({ error: 'token auth not configured' });
    const a = Buffer.from(String(token));
    const b = Buffer.from(configured);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'bad token' });
    }
    req.platformAuth = true;
    return next();
  }
  return apiKeyAuth(req, res, next);
}

// ponytail: single buying client today; suppliers may omit `client` until a second one exists
const DEFAULT_CLIENT = 'bluelion';

// "Full Pay" / "part-pay" / "FULL_PAY" -> "full_pay"
const canon = (v) => String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');

// Suppliers post the buying client's FINAL decision for a lead they sent us.
// Idempotent per (lead, client): a re-post updates that client's outcome in place.
// Deliberately does NOT touch payable_status / money — separate lifecycles.
router.post('/outcomes', outcomeLimiter, outcomeAuth, async (req, res) => {
  const body = req.body || {};
  const keycode = typeof body.keycode === 'string' ? body.keycode.trim() : '';
  if (!keycode) return res.status(400).json({ error: 'keycode required' });
  if (typeof body.outcome !== 'string' || !body.outcome.trim()) {
    return res.status(400).json({ error: 'outcome required (e.g. accepted, part_pay, full_pay, rejected)' });
  }
  const outcome = canon(body.outcome);
  if (outcome.length > 40) return res.status(400).json({ error: 'outcome too long' });

  const client = body.client !== undefined ? canon(body.client) : DEFAULT_CLIENT;
  if (!client || client.length > 40) return res.status(400).json({ error: 'client invalid' });

  let amount;
  if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a number >= 0' });
    amount = Math.round(amount * 100) / 100;
  }
  let occurred_at;
  if (body.occurred_at !== undefined) {
    occurred_at = new Date(body.occurred_at);
    if (Number.isNaN(occurred_at.getTime())) return res.status(400).json({ error: 'occurred_at must be a valid date' });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined;

  // suppliers are scoped to their own leads — one supplier can't write another's;
  // the client platform (token auth) can post outcomes for any lead.
  // keycode = supplier's own reference (Model B) or our KB ref — both accepted.
  const base = req.platformAuth ? {} : { affiliate_id: req.affiliate._id };
  const lead =
    (await Lead.findOne({ ...base, ref: keycode })) ||
    (await Lead.findOne({ ...base, keycode }));
  if (!lead) return res.status(404).json({ error: `keycode ${keycode} not found` });

  const now = new Date();
  const existing = lead.client_outcomes.find((o) => o.client === client);
  const summarise = (o) => (o ? `${o.outcome}${o.amount ? ` £${o.amount}` : ''}` : null);
  const next = {
    client,
    outcome,
    reason: reason !== undefined ? reason : existing?.reason,
    amount: amount !== undefined ? amount : existing?.amount ?? 0,
    occurred_at: occurred_at !== undefined ? occurred_at : existing?.occurred_at,
    received_at: now,
  };
  const changed = !existing || summarise(existing) !== summarise(next) || (existing.reason || '') !== (next.reason || '');
  if (changed) {
    lead.history.push({
      at: now,
      field: `client_outcome:${client}`,
      from: summarise(existing),
      to: summarise(next),
      source: req.platformAuth ? 'webhook' : 'api',
    });
  }
  if (existing) Object.assign(existing, next);
  else lead.client_outcomes.push(next);
  await lead.save();

  res.json({ ref: lead.ref, client, outcome: next.outcome, amount: next.amount, updated: !!existing });
});

module.exports = router;
