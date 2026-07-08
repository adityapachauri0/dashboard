import { useEffect, useState } from 'react';
import { Card, Group, SimpleGrid, Table, Text, Title, Alert } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import dayjs from 'dayjs';
import { api, getUser } from '../api';

function Stat({ label, value, suffix = '' }) {
  return (
    <Card withBorder p="md">
      <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
      <Text size="xl" fw={700}>{value}{suffix}</Text>
    </Card>
  );
}

export default function Summary() {
  const user = getUser();
  const [range, setRange] = useState([new Date(), new Date()]);
  const [summary, setSummary] = useState(null);
  const [breakdown, setBreakdown] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const [from, to] = range;
    if (!from || !to) return;
    const qs = `?from=${dayjs(from).format('YYYY-MM-DD')}&to=${dayjs(to).format('YYYY-MM-DD')}`;
    Promise.all([api(`/dashboard/summary${qs}`), api(`/dashboard/affiliate-breakdown${qs}`)])
      .then(([s, b]) => { setSummary(s); setBreakdown(b); setError(null); })
      .catch((e) => setError(e.message));
  }, [range]);

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Summary</Title>
        <DatePickerInput type="range" value={range} onChange={setRange} allowSingleDateInRange w={280} />
      </Group>
      {error && <Alert color="red" mb="md">{error}</Alert>}
      {summary && (
        <SimpleGrid cols={{ base: 2, md: 4 }} mb="lg">
          <Stat label="Submitted" value={summary.submitted} />
          <Stat label="Accepted" value={summary.accepted} />
          <Stat label="Rejected" value={summary.rejected} />
          <Stat label="Pending" value={summary.pending} />
          <Stat label="Acceptance rate" value={summary.acceptance_rate} suffix="%" />
          <Stat label="Awaiting signature" value={summary.awaiting_signature} />
          <Stat label="Awaiting confirmation" value={summary.awaiting_confirmation} />
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
    </>
  );
}
