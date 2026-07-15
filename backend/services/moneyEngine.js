// Pure money calculation per the spec's rate-card table.
// Order matters: replaced beats everything; only accepted leads with a
// non-failed signature and a known search class are worth money.
function computeMoney(lead, rateCard) {
  const zero = { upfront_due: 0, confirmation_due: 0, total_due: 0 };
  if (lead.replaced_by_lead) return { ...zero, payable_status: 'replaced' };
  if (lead.initial_status !== 'accepted') return { ...zero, payable_status: 'not_payable' };
  if (lead.signature_status === 'failed') return { ...zero, payable_status: 'not_payable' };
  if (lead.cancelled) return { ...zero, payable_status: 'not_payable' };

  if (lead.search_status === 'virgin') {
    const upfront = rateCard.virgin_rate || 0;
    return { upfront_due: upfront, confirmation_due: 0, total_due: upfront, payable_status: 'payable' };
  }
  if (lead.search_status === 'searched') {
    const upfront = rateCard.searched_upfront_rate || 0;
    if (lead.law_firm_confirmed) {
      const conf = rateCard.searched_confirmation_rate || 0;
      return {
        upfront_due: upfront,
        confirmation_due: conf,
        total_due: upfront + conf,
        payable_status: 'payable_full',
      };
    }
    return { upfront_due: upfront, confirmation_due: 0, total_due: upfront, payable_status: 'partial_pending_confirmation' };
  }
  // accepted, search class unknown — nothing payable until classified
  return { ...zero, payable_status: 'not_payable' };
}

module.exports = { computeMoney };
