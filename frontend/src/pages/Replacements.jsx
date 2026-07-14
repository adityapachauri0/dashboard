import { useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, Code, Group, Modal, Select, SimpleGrid, Table, Text, TextInput, Title,
} from '@mantine/core';
import dayjs from 'dayjs';
import { api, getUser } from '../api';
import StatusBadge from '../components/StatusBadge';

function Stat({ label, value, accent = 'var(--mantine-color-emerald-5)' }) {
  return (
    <Card withBorder p="md" style={{ borderLeft: `3px solid ${accent}` }}>
      <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
      <Text fz={24} fw={700}>{value}</Text>
    </Card>
  );
}

function SlaCell({ sla }) {
  if (!sla) return <Text size="sm" c="dimmed">—</Text>;
  const color = sla.overdue ? 'red' : sla.hours_remaining <= 24 ? 'yellow' : 'green';
  return <Badge color={color} variant={sla.overdue ? 'filled' : 'light'}>{sla.label}</Badge>;
}

export default function Replacements() {
  const user = getUser();
  const isAdmin = user.role === 'admin';
  const [data, setData] = useState({ rows: [], counts: { required: 0, supplied: 0, closed: 0, overdue: 0 } });
  const [status, setStatus] = useState(null);
  const [affiliates, setAffiliates] = useState([]);
  const [affiliateId, setAffiliateId] = useState(null);
  const [assigning, setAssigning] = useState(null); // the obligation row being assigned
  const [replacementRef, setReplacementRef] = useState('');
  const [error, setError] = useState(null);
  const [modalError, setModalError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => { if (isAdmin) api('/affiliates').then(setAffiliates).catch(() => {}); }, [isAdmin]);

  useEffect(() => {
    let stale = false;
    const params = new URLSearchParams();
    if (status) params.set('replacement_status', status);
    if (affiliateId) params.set('affiliate_id', affiliateId);
    api(`/dashboard/replacements?${params}`)
      .then((d) => { if (!stale) { setData(d); setError(null); } })
      .catch((e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [status, affiliateId, refreshKey]);

  async function assign() {
    setBusy(true); setModalError(null);
    try {
      const ref = replacementRef.trim();
      const found = await api(`/dashboard/leads?q=${encodeURIComponent(ref)}&limit=5`);
      const repl = (found.rows || []).find((r) => r.ref === ref);
      if (!repl) throw new Error(`lead ${ref} not found`);
      await api(`/dashboard/leads/${repl._id}`, { method: 'PATCH', body: { replaces_ref: assigning.ref } });
      setAssigning(null); setReplacementRef(''); setRefreshKey((k) => k + 1);
    } catch (e) { setModalError(e.message); } finally { setBusy(false); }
  }

  const { counts } = data;
  return (
    <>
      <Title order={3} mb="md">Replacements</Title>
      {error && <Alert color="red" mb="md" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
      <SimpleGrid cols={{ base: 2, md: 4 }} mb="lg">
        <Stat label="Required" value={counts.required} accent="var(--mantine-color-red-6)" />
        <Stat label="Supplied" value={counts.supplied} accent="var(--mantine-color-blue-6)" />
        <Stat label="Closed" value={counts.closed} accent="var(--mantine-color-green-6)" />
        <Stat label="Overdue" value={counts.overdue} accent="var(--mantine-color-red-9)" />
      </SimpleGrid>

      <Group mb="md" gap="xs">
        <Select placeholder="Status" clearable w={160}
          data={[
            { value: 'required', label: 'Required' },
            { value: 'supplied', label: 'Supplied' },
            { value: 'closed', label: 'Closed' },
          ]}
          value={status} onChange={setStatus} />
        {isAdmin && (
          <Select placeholder="Affiliate" clearable w={180} value={affiliateId}
            data={affiliates.map((a) => ({ value: a._id, label: a.name }))} onChange={setAffiliateId} />
        )}
      </Group>

      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Ref</Table.Th>
            {isAdmin && <Table.Th>Affiliate</Table.Th>}
            <Table.Th>Signature failed</Table.Th>
            <Table.Th>SLA (72h)</Table.Th>
            <Table.Th>Replacement</Table.Th>
            <Table.Th>Status</Table.Th>
            {isAdmin && <Table.Th />}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.rows.map((l) => (
            <Table.Tr key={l._id}>
              <Table.Td><Code>{l.ref}</Code></Table.Td>
              {isAdmin && <Table.Td>{l.affiliate_id?.name}</Table.Td>}
              <Table.Td>{l.replacement_requested_at ? dayjs(l.replacement_requested_at).format('DD MMM HH:mm') : '—'}</Table.Td>
              <Table.Td><SlaCell sla={l.sla} /></Table.Td>
              <Table.Td>{l.replaced_by_lead ? <Code>{l.replaced_by_lead.ref}</Code> : <Text size="sm" c="dimmed">—</Text>}</Table.Td>
              <Table.Td><StatusBadge field="replacement_status" value={l.replacement_status} /></Table.Td>
              {isAdmin && (
                <Table.Td>
                  {l.replacement_status === 'required' && (
                    <Button size="xs" variant="light" onClick={() => { setAssigning(l); setModalError(null); }}>
                      Assign replacement
                    </Button>
                  )}
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {data.rows.length === 0 && (
        <Text c="dimmed" size="sm" mt="sm">No replacement obligations — nothing owed. 🎉</Text>
      )}

      <Modal opened={!!assigning} onClose={() => setAssigning(null)}
        title={assigning ? `Assign replacement for ${assigning.ref}` : ''}>
        <Text size="sm" c="dimmed" mb="sm">
          Enter the ref of the lead that replaces this one. It must belong to the same affiliate and not already be a replacement.
        </Text>
        {modalError && <Alert color="red" mb="sm">{modalError}</Alert>}
        <TextInput placeholder="KB-2026-000123" value={replacementRef}
          onChange={(e) => setReplacementRef(e.target.value)} mb="md" />
        <Button onClick={assign} loading={busy} disabled={!replacementRef.trim()}>Link replacement</Button>
      </Modal>
    </>
  );
}
