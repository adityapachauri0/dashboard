import { useEffect, useState } from 'react';
import { Card, Group, SimpleGrid, Table, Text, Title, Alert } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import dayjs from 'dayjs';
import { api, getUser } from '../api';

function Stat({ label, value, suffix = '', accent = 'var(--mantine-color-emerald-5)' }) {
  return (
    <Card withBorder p="md" style={{ borderLeft: `3px solid ${accent}` }}>
      <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
      <Text fz={24} fw={700}>{value}{suffix}</Text>
    </Card>
  );
}

export default function Summary() {
  const user = getUser();
  const [range, setRange] = useState([dayjs().subtract(29, 'day').toDate(), new Date()]);
  const [summary, setSummary] = useState(null);
  const [breakdown, setBreakdown] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const [from, to] = range;
    if (!from || !to) return;
    let stale = false;
    const qs = `?from=${dayjs(from).format('YYYY-MM-DD')}&to=${dayjs(to).format('YYYY-MM-DD')}`;
    Promise.all([api(`/dashboard/summary${qs}`), api(`/dashboard/affiliate-breakdown${qs}`)])
      .then(([s, b]) => { if (!stale) { setSummary(s); setBreakdown(b); setError(null); } })
      .catch((e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [range]);

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Summary</Title>
        <DatePickerInput type="range" value={range} onChange={setRange} allowSingleDateInRange w={280} />
      </Group>
      {error && <Alert color="red" mb="md">{error}</Alert>}
      {summary?.attention && (summary.attention.overdue_signature + summary.attention.needs_replacement + summary.attention.awaiting_confirmation) > 0 && (
        <Alert color="yellow" mb="md" title="Needs attention">
          {[
            summary.attention.overdue_signature > 0 && `${summary.attention.overdue_signature} signature check${summary.attention.overdue_signature === 1 ? '' : 's'} overdue`,
            summary.attention.needs_replacement > 0 && `${summary.attention.needs_replacement} replacement${summary.attention.needs_replacement === 1 ? '' : 's'} needed`,
            summary.attention.awaiting_confirmation > 0 && `${summary.attention.awaiting_confirmation} part-paid — awaiting law firm`,
          ].filter(Boolean).join(' · ')}
        </Alert>
      )}
      {summary && (
        <SimpleGrid cols={{ base: 2, md: 4 }} mb="lg">
          <Stat label="Submitted" value={summary.submitted} />
          <Stat label="Accepted" value={summary.accepted} accent="var(--mantine-color-green-6)" />
          <Stat label="Rejected" value={summary.rejected} accent="var(--mantine-color-red-6)" />
          <Stat label="Pending" value={summary.pending} accent="var(--mantine-color-yellow-6)" />
          <Stat label="Acceptance rate" value={summary.acceptance_rate} suffix="%" />
          <Stat label="Awaiting signature" value={summary.awaiting_signature} accent="var(--mantine-color-teal-6)" />
          <Stat label="Awaiting confirmation" value={summary.awaiting_confirmation} accent="var(--mantine-color-indigo-6)" />
          <Stat label="Total due" value={`£${(summary.total_due || 0).toFixed(2)}`} />
        </SimpleGrid>
      )}
      <Title order={4} mb="sm">{user.role === 'admin' ? 'By affiliate' : 'Your totals'}</Title>
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Affiliate</Table.Th><Table.Th>Submitted</Table.Th><Table.Th>Accepted</Table.Th>
            <Table.Th>Rejected</Table.Th><Table.Th>Pending</Table.Th><Table.Th>Accept %</Table.Th>
            <Table.Th>Payable</Table.Th><Table.Th>Replacements</Table.Th><Table.Th>Owed</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {breakdown.map((r) => (
            <Table.Tr key={r.affiliate_id}>
              <Table.Td>{r.name} <Text span size="xs" c="dimmed">({r.lead_source})</Text></Table.Td>
              <Table.Td>{r.submitted}</Table.Td><Table.Td>{r.accepted}</Table.Td>
              <Table.Td>{r.rejected}</Table.Td><Table.Td>{r.pending}</Table.Td>
              <Table.Td>{r.acceptance_rate}%</Table.Td><Table.Td>{r.payable}</Table.Td>
              <Table.Td>{r.replacements}</Table.Td><Table.Td>£{(r.owed || 0).toFixed(2)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {breakdown.length === 0 && (
        <Text c="dimmed" size="sm" mt="sm">No leads in this range — try widening the date filter.</Text>
      )}
    </>
  );
}
