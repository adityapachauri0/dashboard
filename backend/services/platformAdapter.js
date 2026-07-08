// Buyer-platform adapter. MANUAL MODE: the platform's API docs are pending,
// so submission returns null and leads stay `pending`; statuses arrive via
// webhook / CSV import / manual adjustment instead.
//
// When docs arrive, implement the HTTP call here and return the canonical
// shape — nothing else in the codebase changes:
//   { initial_status, rejection_reason, search_status, platform_ref, raw }
async function submitLead(lead) {
  return null;
}

module.exports = { submitLead };
