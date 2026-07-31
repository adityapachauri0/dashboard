// Suppliers see the client's DECISION, never the client's MONEY — client-side
// amounts reveal our margin. Admin keeps full visibility.
function scrubClientMoney(lead) {
  (lead.client_outcomes || []).forEach((o) => {
    delete o.amount;
  });
  if (lead.history) {
    lead.history = lead.history.filter((h) => !String(h.field || '').startsWith('client_outcome'));
  }
  return lead;
}

const isAffiliate = (user) => user?.role === 'affiliate';

module.exports = { scrubClientMoney, isAffiliate };
