const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Shared by lead list, stats and CSV export. Affiliate users are ALWAYS
// pinned to their own affiliate_id from the JWT — client filters can't widen it.
function buildLeadFilter(query, user) {
  const filter = {};
  if (user.role === 'affiliate') filter.affiliate_id = user.affiliate_id;
  else if (query.affiliate_id) filter.affiliate_id = query.affiliate_id;

  for (const f of ['brand', 'initial_status', 'search_status', 'signature_status', 'payable_status']) {
    if (query[f]) filter[f] = query[f];
  }
  if (query.needs_replacement === 'true') filter.needs_replacement = true;
  if (query.from || query.to) filter.submitted_at = {};
  if (query.from) filter.submitted_at.$gte = new Date(query.from);
  if (query.to) filter.submitted_at.$lte = new Date(new Date(query.to).setHours(23, 59, 59, 999));
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [{ ref: rx }, { applicant_name: rx }, { platform_ref: rx }];
  }
  return filter;
}

module.exports = { buildLeadFilter };
