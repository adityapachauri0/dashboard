const { computeMoney } = require('./moneyEngine');

const UPDATABLE_FIELDS = [
  'initial_status',
  'rejection_reason',
  'search_status',
  'signature_status',
  'law_firm_confirmed',
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

  if (lead.signature_status === 'failed' && !lead.needs_replacement) {
    record('needs_replacement', false, true);
    lead.needs_replacement = true;
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
