const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const { applyStatusChanges } = require('./statusService');

const SLA_HOURS = 72;
const HOUR = 3600 * 1000;

// SLA is derived, never stored: contract gives 72h from the replacement request
// event (signature failure or cooling-off cancellation) to supply the replacement.
function slaState(lead, now = new Date()) {
  if (lead.replacement_status !== 'required' || !lead.replacement_requested_at) return null;
  const deadline = new Date(new Date(lead.replacement_requested_at).getTime() + SLA_HOURS * HOUR);
  const overdue = now > deadline;
  const hours_remaining = overdue ? 0 : Math.floor((deadline - now) / HOUR);
  return { deadline, overdue, hours_remaining, label: overdue ? 'OVERDUE' : `${hours_remaining}h remaining` };
}

// Cross-lead transition: a replacement lead's acceptance closes the original's
// obligation; its rejection reopens it (link cleared, clock unchanged).
// Call after saving any lead whose initial_status may have changed.
async function propagateReplacementOutcome(lead, meta = {}) {
  if (!lead.replaces_lead || lead.initial_status === 'pending') return null;
  const original = await Lead.findById(lead.replaces_lead);
  // only the CURRENT replacement may affect the original (stale/rejected ones can't)
  if (!original || String(original.replaced_by_lead) !== String(lead._id)) return null;

  const now = new Date();
  const rec = (field, from, to) =>
    original.history.push({ at: now, field, from, to, source: meta.source || 'webhook', user: meta.user });

  if (lead.initial_status === 'accepted') {
    if (original.replacement_status === 'closed') return null;
    rec('replacement_status', original.replacement_status, 'closed');
    original.replacement_status = 'closed';
  } else if (lead.initial_status === 'rejected') {
    rec('replaced_by_lead', lead.ref, null);
    original.replaced_by_lead = null;
    rec('replacement_status', original.replacement_status, 'required');
    original.replacement_status = 'required'; // replacement_requested_at intentionally untouched
  } else {
    return null;
  }

  const affiliate = await Affiliate.findById(original.affiliate_id);
  applyStatusChanges(original, {}, affiliate?.rate_card || {}, meta); // money recompute + payable history
  await original.save();
  return original;
}

module.exports = { SLA_HOURS, slaState, propagateReplacementOutcome };
