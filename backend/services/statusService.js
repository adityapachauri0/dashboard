const { computeMoney } = require('./moneyEngine');

const UPDATABLE_FIELDS = [
  'initial_status',
  'rejection_reason',
  'search_status',
  'signature_status',
  'law_firm_confirmed',
  'cancelled', // 14-day cooling-off; one-way from payloads, admin can undo manually
  'platform_ref',
  'possible_duplicate', // manual clear/set from the dashboard only
];

// Single choke-point for every status mutation (api/webhook/import/manual):
// history append + needs_replacement rule + money recompute.
function applyStatusChanges(lead, changes, rateCard, { source, user } = {}) {
  const now = new Date();
  const record = (field, from, to) => lead.history.push({ at: now, field, from, to, source, user });

  for (const field of UPDATABLE_FIELDS) {
    if (!(field in changes)) continue;
    const to = changes[field];
    if (to === undefined || lead[field] === to) continue;
    record(field, lead[field], to);
    lead[field] = to;
  }

  // Cooling-off cancellation: stamp the notification date once, never reset.
  if (lead.cancelled && !lead.cancelled_at) {
    record('cancelled_at', null, now);
    lead.cancelled_at = now;
  }

  const obligationReason =
    lead.signature_status === 'failed' ? 'signature' : lead.cancelled ? 'cooling_off' : null;

  if (obligationReason && !lead.needs_replacement) {
    record('needs_replacement', false, true);
    lead.needs_replacement = true;
  }

  // Replacement lifecycle — own-lead transitions only. Cross-lead close/reopen
  // (replacement accepted/rejected) lives in replacementService.
  if (!lead.replacement_status) lead.replacement_status = 'none'; // plain objects / pre-backfill docs
  if (obligationReason && lead.replacement_status === 'none') {
    record('replacement_status', 'none', 'required');
    lead.replacement_status = 'required';
    if (!lead.replacement_reason) {
      record('replacement_reason', null, obligationReason);
      lead.replacement_reason = obligationReason; // first reason wins, never overwritten
    }
    if (!lead.replacement_requested_at) {
      record('replacement_requested_at', null, now);
      lead.replacement_requested_at = now; // 72h SLA clock — set once, never reset
    }
  }
  if (lead.replaced_by_lead && ['none', 'required'].includes(lead.replacement_status)) {
    record('replacement_status', lead.replacement_status, 'supplied');
    lead.replacement_status = 'supplied';
  }

  const money = computeMoney(lead, rateCard);
  if (lead.payable_status !== money.payable_status) {
    record('payable_status', lead.payable_status, money.payable_status);
    lead.payable_status = money.payable_status;
  }
  lead.amounts = {
    upfront_due: money.upfront_due,
    confirmation_due: money.confirmation_due,
    total_due: money.total_due,
  };
  return lead;
}

module.exports = { applyStatusChanges, UPDATABLE_FIELDS };
