const mongoose = require('mongoose');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Shared by lead list, stats and CSV export. Affiliate users are ALWAYS
// pinned to their own affiliate_id from the JWT — client filters can't widen it.
function buildLeadFilter(query, user) {
  const filter = {};
  if (user.role === 'affiliate') filter.affiliate_id = new mongoose.Types.ObjectId(String(user.affiliate_id));
  else if (query.affiliate_id) {
    if (mongoose.isValidObjectId(query.affiliate_id)) {
      filter.affiliate_id = new mongoose.Types.ObjectId(String(query.affiliate_id));
    }
  }

  for (const f of ['brand', 'initial_status', 'search_status', 'signature_status', 'payable_status']) {
    if (typeof query[f] === 'string' && query[f]) filter[f] = query[f];
  }
  if (query.needs_replacement === 'true') filter.needs_replacement = true;
  if (['required', 'supplied', 'closed'].includes(query.replacement_status)) {
    filter.replacement_status = query.replacement_status;
  }
  // Anthony's payment list folds 'closed' into Supplied
  if (query.replacement_status === 'supplied_or_closed') {
    filter.replacement_status = { $in: ['supplied', 'closed'] };
  }
  // signature also matches legacy rows from before the reason existed
  // ($in with null matches missing fields)
  if (query.replacement_reason === 'signature') filter.replacement_reason = { $in: ['signature', null] };
  if (query.replacement_reason === 'cooling_off') filter.replacement_reason = 'cooling_off';
  // "Next update" mirrors the Leads-page column: what is this lead waiting on?
  if (query.next_update === 'awaiting_confirmation') filter.payable_status = 'partial_pending_confirmation';
  if (query.next_update === 'replacement_required') filter.replacement_status = 'required';
  if (query.next_update === 'complete') {
    // nothing pending: payable now, or the obligation fully closed
    filter.$and = [
      ...(filter.$and || []),
      { $or: [{ payable_status: { $in: ['payable', 'payable_full'] } }, { replacement_status: 'closed' }] },
    ];
  }
  if (query.from || query.to) filter.submitted_at = {};
  if (query.from) filter.submitted_at.$gte = new Date(query.from);
  if (query.to) filter.submitted_at.$lte = new Date(new Date(query.to).setHours(23, 59, 59, 999));
  if (typeof query.q === 'string' && query.q) {
    const rx = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [{ ref: rx }, { applicant_name: rx }, { platform_ref: rx }];
  }
  return filter;
}

module.exports = { buildLeadFilter };
