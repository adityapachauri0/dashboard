// Maps the many spellings platforms use to our canonical enum values.
// Unrecognized input -> undefined (callers skip the field; we never guess).
const MAPS = {
  initial_status: {
    accepted: 'accepted', approved: 'accepted', success: 'accepted', accept: 'accepted',
    rejected: 'rejected', declined: 'rejected', refused: 'rejected', reject: 'rejected',
    pending: 'pending', processing: 'pending',
  },
  search_status: {
    virgin: 'virgin', new: 'virgin', unsearched: 'virgin', 'non-searched': 'virgin',
    'non searched': 'virgin', 'not searched': 'virgin',
    searched: 'searched', existing: 'searched', 'already searched': 'searched',
    'already_searched': 'searched',
  },
  signature_status: {
    passed: 'passed', signed: 'passed', valid: 'passed', true: 'passed', yes: 'passed',
    failed: 'failed', false: 'failed', invalid: 'failed', no: 'failed', missing: 'failed',
    unsigned: 'failed',
    pending: 'pending', awaiting: 'pending', 'awaiting signature': 'pending',
  },
  law_firm_confirmed: {
    true: true, yes: true, confirmed: true, payable: true,
    false: false, no: false, unconfirmed: false,
  },
  // 14-day cooling-off cancellation — truthy spellings only; false/unknown →
  // undefined. Un-cancelling is a manual dashboard action, never a payload.
  cancelled: {
    cancelled: true, canceled: true, cancellation: true,
    'cooling off': true, 'cooling-off': true, cooling_off: true, 'cooled off': true,
    true: true, yes: true,
  },
};

function normalizeField(field, raw) {
  if (raw === undefined || raw === null) return undefined;
  if (field === 'law_firm_confirmed' && typeof raw === 'boolean') return raw;
  const key = String(raw).trim().toLowerCase();
  const map = MAPS[field];
  return map ? map[key] : undefined;
}

// Best-effort canonical changes from an arbitrary webhook/report payload.
function canonicalFromPayload(p) {
  const out = {};
  const tryKeys = (field, keys) => {
    for (const k of keys) {
      if (p[k] === undefined || p[k] === null || p[k] === '') continue;
      const v = normalizeField(field, p[k]);
      if (v !== undefined) { out[field] = v; return; }
    }
  };
  tryKeys('initial_status', ['initial_status', 'status', 'result', 'outcome']);
  tryKeys('search_status', ['search_status', 'search_type', 'credit_search', 'search']);
  tryKeys('signature_status', ['signature_status', 'signature', 'signed', 'esign']);
  tryKeys('law_firm_confirmed', ['law_firm_confirmed', 'confirmed', 'payable_confirmed', 'confirmation']);
  tryKeys('cancelled', ['cancelled', 'canceled', 'cancellation', 'cancellation_status', 'status', 'result', 'outcome']);
  const reason = p.rejection_reason || p.reason || p.reject_reason;
  if (reason) out.rejection_reason = String(reason);
  return out;
}

// Contact identity for duplicate detection. Returns '' when unusable.
function normalizeEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /\S+@\S+\.\S+/.test(s) ? s : '';
}
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('44')) d = '0' + d.slice(2); // +44 7… → 07…
  return d.length >= 10 ? d : '';
}

module.exports = { normalizeField, canonicalFromPayload, normalizeEmail, normalizePhone };
