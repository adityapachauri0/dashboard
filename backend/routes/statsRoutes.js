const express = require('express');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const { requireAuth } = require('../middleware/auth');
const { buildLeadFilter } = require('../services/leadFilter');
const { SLA_HOURS } = require('../services/replacementService');

const router = express.Router();

const PAYABLE_STATUSES = ['payable', 'partial_pending_confirmation', 'payable_full'];
const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : 0);
const is = (field, val) => ({ $cond: [{ $eq: [`$${field}`, val] }, 1, 0] });

function dateRange(query) {
  // default: today
  const from = query.from ? new Date(query.from) : new Date(new Date().setHours(0, 0, 0, 0));
  const to = query.to ? new Date(new Date(query.to).setHours(23, 59, 59, 999)) : new Date(new Date().setHours(23, 59, 59, 999));
  return { from: from.toISOString(), to: to.toISOString() };
}

router.get('/dashboard/summary', requireAuth, async (req, res) => {
  const range = dateRange(req.query);
  const match = buildLeadFilter({ ...req.query, ...range }, req.user);
  // "Needs attention" is all-time (an overdue signature from last month still needs
  // acting on), scoped to the user / selected affiliate but NOT the date range.
  const attentionMatch = buildLeadFilter({ affiliate_id: req.query.affiliate_id }, req.user);
  const [[g], [a]] = await Promise.all([
    Lead.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          submitted: { $sum: 1 },
          accepted: { $sum: is('initial_status', 'accepted') },
          rejected: { $sum: is('initial_status', 'rejected') },
          pending: { $sum: is('initial_status', 'pending') },
          awaiting_signature: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$initial_status', 'accepted'] }, { $eq: ['$signature_status', 'pending'] }] },
                1, 0,
              ],
            },
          },
          awaiting_confirmation: { $sum: is('payable_status', 'partial_pending_confirmation') },
          total_due: { $sum: '$amounts.total_due' },
        },
      },
    ]),
    Lead.aggregate([
      { $match: attentionMatch },
      {
        $group: {
          _id: null,
          overdue_signature: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$initial_status', 'accepted'] },
                    { $eq: ['$signature_status', 'pending'] },
                    { $eq: [{ $type: '$signature_deadline' }, 'date'] },
                    { $lt: ['$signature_deadline', '$$NOW'] },
                  ],
                },
                1, 0,
              ],
            },
          },
          needs_replacement: { $sum: is('replacement_status', 'required') },
          overdue_replacements: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$replacement_status', 'required'] },
                    { $eq: [{ $type: '$replacement_requested_at' }, 'date'] },
                    { $lt: ['$replacement_requested_at', new Date(Date.now() - SLA_HOURS * 3600 * 1000)] },
                  ],
                },
                1, 0,
              ],
            },
          },
          awaiting_confirmation: { $sum: is('payable_status', 'partial_pending_confirmation') },
          possible_duplicates: { $sum: { $cond: [{ $eq: ['$possible_duplicate', true] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const s = g || { submitted: 0, accepted: 0, rejected: 0, pending: 0, awaiting_signature: 0, awaiting_confirmation: 0, total_due: 0 };
  const at = a || { overdue_signature: 0, needs_replacement: 0, overdue_replacements: 0, awaiting_confirmation: 0, possible_duplicates: 0 };
  res.json({
    submitted: s.submitted,
    accepted: s.accepted,
    rejected: s.rejected,
    pending: s.pending,
    acceptance_rate: pct(s.accepted, s.submitted),
    rejection_rate: pct(s.rejected, s.submitted),
    awaiting_signature: s.awaiting_signature,
    awaiting_confirmation: s.awaiting_confirmation,
    total_due: s.total_due,
    outstanding_replacements: at.needs_replacement, // all-time, like the rest of attention
    attention: {
      overdue_signature: at.overdue_signature,
      needs_replacement: at.needs_replacement,
      overdue_replacements: at.overdue_replacements,
      awaiting_confirmation: at.awaiting_confirmation,
      possible_duplicates: at.possible_duplicates,
    },
  });
});

router.get('/dashboard/daily', requireAuth, async (req, res) => {
  const range = dateRange(req.query);
  const match = buildLeadFilter({ ...req.query, ...range }, req.user);
  const rows = await Lead.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$submitted_at', timezone: 'Europe/London' } },
        submitted: { $sum: 1 },
        accepted: { $sum: is('initial_status', 'accepted') },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  res.json(rows.map((r) => ({ date: r._id, submitted: r.submitted, accepted: r.accepted })));
});

router.get('/dashboard/affiliate-breakdown', requireAuth, async (req, res) => {
  const range = dateRange(req.query);
  const match = buildLeadFilter({ ...req.query, ...range }, req.user);
  const groups = await Lead.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$affiliate_id',
        submitted: { $sum: 1 },
        accepted: { $sum: is('initial_status', 'accepted') },
        rejected: { $sum: is('initial_status', 'rejected') },
        pending: { $sum: is('initial_status', 'pending') },
        payable: { $sum: { $cond: [{ $in: ['$payable_status', PAYABLE_STATUSES] }, 1, 0] } },
        replacement_required: { $sum: { $cond: [{ $in: ['$replacement_status', ['required', 'supplied', 'closed']] }, 1, 0] } },
        replacement_supplied: { $sum: { $cond: [{ $in: ['$replacement_status', ['supplied', 'closed']] }, 1, 0] } },
        outstanding: { $sum: is('replacement_status', 'required') },
        owed: { $sum: '$amounts.total_due' },
      },
    },
  ]);
  const affiliates = await Affiliate.find({ _id: { $in: groups.map((r) => r._id) } }).select('name lead_source').lean();
  const byId = new Map(affiliates.map((a) => [a._id.toString(), a]));
  res.json(
    groups.map((r) => ({
      affiliate_id: r._id,
      name: byId.get(r._id.toString())?.name || 'unknown',
      lead_source: byId.get(r._id.toString())?.lead_source || '',
      submitted: r.submitted,
      accepted: r.accepted,
      rejected: r.rejected,
      pending: r.pending,
      acceptance_rate: pct(r.accepted, r.submitted),
      payable: r.payable,
      replacement_required: r.replacement_required,
      replacement_supplied: r.replacement_supplied,
      outstanding: r.outstanding,
      owed: r.owed,
    })).sort((a, b) => b.submitted - a.submitted)
  );
});

module.exports = router;
