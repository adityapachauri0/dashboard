import { Badge } from '@mantine/core';

const COLORS = {
  initial_status: { pending: 'yellow', accepted: 'green', rejected: 'red' },
  search_status: { virgin: 'teal', searched: 'indigo', unknown: 'gray' },
  signature_status: { pending: 'yellow', passed: 'green', failed: 'red' },
  payable_status: {
    not_payable: 'gray', payable: 'green', partial_pending_confirmation: 'orange',
    payable_full: 'green', replaced: 'grape',
  },
};
const LABELS = {
  payable: 'payable (100%)',
  partial_pending_confirmation: 'part-paid — awaiting law firm',
  payable_full: 'payable in full',
  not_payable: 'not payable',
  virgin: 'virgin search',
  searched: 'already searched',
};

export default function StatusBadge({ field, value }) {
  if (value === undefined || value === null) return null;
  return (
    <Badge color={COLORS[field]?.[value] || 'gray'} variant="light">
      {LABELS[value] || value}
    </Badge>
  );
}
