import { Badge } from '@mantine/core';

const COLORS = {
  initial_status: { pending: 'yellow', accepted: 'green', rejected: 'red' },
  search_status: { virgin: 'teal', searched: 'indigo', unknown: 'gray' },
  signature_status: { pending: 'yellow', passed: 'green', failed: 'red' },
  payable_status: {
    not_payable: 'gray', payable: 'green', partial_pending_confirmation: 'orange',
    payable_full: 'green', replaced: 'grape',
  },
  replacement_status: { none: 'gray', required: 'red', supplied: 'blue', closed: 'green' },
};
export const LABELS = {
  payable: 'payable (100%)',
  partial_pending_confirmation: 'part-paid — awaiting law firm',
  payable_full: 'payable in full',
  not_payable: 'not payable',
  replaced: 'replacement supplied',
  required: 'replacement required',
  supplied: 'replacement supplied',
  closed: 'replacement closed',
  virgin: 'virgin search',
  searched: 'already searched',
};

// Anthony's 8-option Payment Status (spec 2026-07-15). Replacement labels win
// over money labels while an obligation exists; 'closed' renders as Supplied;
// missing reason (legacy) = Signature.
export function paymentStatus(l) {
  const reason = l.replacement_reason === 'cooling_off' ? '14 Day Cooling-Off' : 'Signature';
  if (l.replacement_status === 'required') return { label: `Replacement Required – ${reason}`, color: 'red' };
  if (['supplied', 'closed'].includes(l.replacement_status)) return { label: `Replacement Supplied – ${reason}`, color: 'blue' };
  if (l.payable_status === 'payable') return { label: 'Payable (100%)', color: 'green' };
  if (l.payable_status === 'partial_pending_confirmation') return { label: 'Part-paid – Awaiting Law Firm', color: 'orange' };
  if (l.payable_status === 'payable_full') return { label: 'Payable in Full', color: 'green' };
  return { label: 'Not Payable', color: 'gray' };
}

export const PAYMENT_FILTER_OPTIONS = [
  { value: 'not_payable', label: 'Not Payable' },
  { value: 'payable', label: 'Payable (100%)' },
  { value: 'partial_pending_confirmation', label: 'Part-paid – Awaiting Law Firm' },
  { value: 'payable_full', label: 'Payable in Full' },
  { value: 'replacement_required_signature', label: 'Replacement Required – Signature' },
  { value: 'replacement_supplied_signature', label: 'Replacement Supplied – Signature' },
  { value: 'replacement_required_cooling_off', label: 'Replacement Required – 14 Day Cooling-Off' },
  { value: 'replacement_supplied_cooling_off', label: 'Replacement Supplied – 14 Day Cooling-Off' },
];
export function paymentFilterToParams(value) {
  if (!value) return {};
  if (value.startsWith('replacement_')) {
    return {
      replacement_status: value.includes('required') ? 'required' : 'supplied_or_closed',
      replacement_reason: value.endsWith('cooling_off') ? 'cooling_off' : 'signature',
    };
  }
  return { payable_status: value };
}

export default function StatusBadge({ field, value }) {
  if (value === undefined || value === null) return null;
  return (
    <Badge color={COLORS[field]?.[value] || 'gray'} variant="light">
      {LABELS[value] || value}
    </Badge>
  );
}
