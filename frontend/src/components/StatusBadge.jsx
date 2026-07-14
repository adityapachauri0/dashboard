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

// The "Payment status" dropdown mixes money statuses with the replacement
// lifecycle; this maps each option to the query param the API expects.
export const PAYMENT_FILTER_OPTIONS = [
  { value: 'not_payable', label: LABELS.not_payable },
  { value: 'payable', label: LABELS.payable },
  { value: 'partial_pending_confirmation', label: LABELS.partial_pending_confirmation },
  { value: 'payable_full', label: LABELS.payable_full },
  { value: 'replacement_required', label: 'replacement required' },
  { value: 'replaced', label: 'replacement supplied' },
];
export function paymentFilterToParams(value) {
  if (!value) return {};
  if (value === 'replacement_required') return { replacement_status: 'required' };
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
