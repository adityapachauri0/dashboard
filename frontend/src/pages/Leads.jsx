import { useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Drawer, Group, Pagination, Select, Stack, Switch, Table, Text,
  TextInput, Timeline, Title, Code, Divider,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import dayjs from 'dayjs';
import { api, getUser } from '../api';
import StatusBadge, { LABELS } from '../components/StatusBadge';

const PAGE_SIZE = 50;
const opts = (arr) => arr.map((v) => ({ value: v, label: v.replaceAll('_', ' ') }));

// What happens next for this lead, in plain English (mirrors the money flow:
// virgin = 100% payable; searched = part-paid, rest on law firm confirmation)
function nextUpdate(l) {
  if (l.payable_status === 'replaced' || l.initial_status === 'rejected') return '—';
  if (l.initial_status === 'pending') return 'Awaiting acceptance';
  if (l.needs_replacement && !l.replaced_by_lead) return 'Replacement needed';
  if (l.signature_status === 'pending') {
    return `Signature check by ${l.signature_deadline ? dayjs(l.signature_deadline).format('DD MMM') : '—'}`;
  }
  if (l.payable_status === 'partial_pending_confirmation') return 'Awaiting law firm confirmation';
  if (l.payable_status === 'payable' || l.payable_status === 'payable_full') return 'None — ready to pay';
  return '—';
}

export default function Leads() {
  const user = getUser();
  const isAdmin = user.role === 'admin';
  const [filters, setFilters] = useState({ affiliate_id: null, initial_status: null, search_status: null, signature_status: null, payable_status: null, q: '' });
  const [qInput, setQInput] = useState('');
  const [range, setRange] = useState([null, null]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], total: 0 });
  const [affiliates, setAffiliates] = useState([]);
  const [selected, setSelected] = useState(null); // full lead detail
  const [edit, setEdit] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (isAdmin) api('/affiliates').then(setAffiliates).catch(() => {});
  }, [isAdmin]);

  const set = (k) => (v) => { setPage(1); setFilters((f) => ({ ...f, [k]: v })); };

  useEffect(() => {
    const t = setTimeout(() => { if (qInput !== filters.q) set('q')(qInput); }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  useEffect(() => {
    let stale = false;
    const params = new URLSearchParams({ page, limit: PAGE_SIZE });
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    if (range[0]) params.set('from', dayjs(range[0]).format('YYYY-MM-DD'));
    if (range[1]) params.set('to', dayjs(range[1]).format('YYYY-MM-DD'));
    api(`/dashboard/leads?${params}`).then((d) => { if (!stale) setData(d); }).catch((e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [filters, range, page, refreshKey]);

  async function openDetail(id) {
    try {
      const lead = await api(`/dashboard/leads/${id}`);
      setSelected(lead);
      setEdit({});
    } catch (e) { setError(e.message); }
  }

  async function saveEdit() {
    setSaving(true);
    try {
      await api(`/dashboard/leads/${selected._id}`, { method: 'PATCH', body: edit });
      await openDetail(selected._id);
      setRefreshKey((k) => k + 1);
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  return (
    <>
      <Title order={3} mb="md">Leads</Title>
      {error && <Alert color="red" mb="md" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
      <Group mb="md" gap="xs" wrap="wrap">
        {isAdmin && (
          <Select placeholder="Affiliate" clearable w={180} value={filters.affiliate_id}
            data={affiliates.map((a) => ({ value: a._id, label: a.name }))} onChange={set('affiliate_id')} />
        )}
        <Select placeholder="API status" clearable w={140} data={opts(['pending', 'accepted', 'rejected'])} value={filters.initial_status} onChange={set('initial_status')} />
        <Select placeholder="Search status" clearable w={150} data={opts(['virgin', 'searched', 'unknown'])} value={filters.search_status} onChange={set('search_status')} />
        <Select placeholder="Signature" clearable w={140} data={opts(['pending', 'passed', 'failed'])} value={filters.signature_status} onChange={set('signature_status')} />
        <Select placeholder="Payment status" clearable w={230}
          data={['not_payable', 'payable', 'partial_pending_confirmation', 'payable_full', 'replaced'].map((v) => ({ value: v, label: LABELS[v] || v }))}
          value={filters.payable_status} onChange={set('payable_status')} />
        <DatePickerInput type="range" placeholder="Date range" clearable value={range} onChange={(v) => { setPage(1); setRange(v); }} w={240} />
        <TextInput placeholder="Search ref / name" value={qInput} onChange={(e) => setQInput(e.target.value)} w={180} />
      </Group>

      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Ref</Table.Th><Table.Th>Submitted</Table.Th><Table.Th>Affiliate</Table.Th>
            <Table.Th>Name</Table.Th><Table.Th>API status</Table.Th><Table.Th>Search</Table.Th>
            <Table.Th>Signature</Table.Th><Table.Th>Payment status</Table.Th><Table.Th>Next update</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.rows.map((l) => (
            <Table.Tr key={l._id} style={{ cursor: 'pointer' }} onClick={() => openDetail(l._id)}>
              <Table.Td><Code>{l.ref}</Code></Table.Td>
              <Table.Td>{dayjs(l.submitted_at).format('DD MMM HH:mm')}</Table.Td>
              <Table.Td>{l.affiliate_id?.name}</Table.Td>
              <Table.Td>{l.applicant_name}</Table.Td>
              <Table.Td><StatusBadge field="initial_status" value={l.initial_status} /></Table.Td>
              <Table.Td><StatusBadge field="search_status" value={l.search_status} /></Table.Td>
              <Table.Td>
                <StatusBadge field="signature_status" value={l.signature_status} />
                {l.signature_status === 'pending' && l.signature_deadline && dayjs().isAfter(l.signature_deadline) && (
                  <Badge color="red" variant="outline" ml={4}>overdue{[0, 6].includes(dayjs(l.signature_deadline).day()) ? ' (weekend)' : ''}</Badge>
                )}
                {l.needs_replacement && !l.replaced_by_lead && <Badge color="red" ml={4}>needs replacement</Badge>}
              </Table.Td>
              <Table.Td><StatusBadge field="payable_status" value={l.payable_status} /></Table.Td>
              <Table.Td><Text size="sm" c="dimmed">{nextUpdate(l)}</Text></Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {data.total === 0 && (
        <Text c="dimmed" size="sm" mt="sm">
          {Object.values(filters).some(Boolean) || range[0]
            ? 'No leads match — try clearing filters or widening the date range.'
            : 'No leads yet.'}
        </Text>
      )}
      <Group justify="space-between" mt="sm">
        <Text size="sm" c="dimmed">{data.total} leads</Text>
        <Pagination value={page} onChange={setPage} total={Math.max(1, Math.ceil(data.total / PAGE_SIZE))} />
      </Group>

      <Drawer opened={!!selected} onClose={() => setSelected(null)} position="right" size="lg"
        title={selected ? `${selected.ref} — ${selected.applicant_name}` : ''}>
        {selected && (
          <Stack gap="sm">
            <Group gap="xs">
              <StatusBadge field="initial_status" value={selected.initial_status} />
              <StatusBadge field="search_status" value={selected.search_status} />
              <StatusBadge field="signature_status" value={selected.signature_status} />
              <StatusBadge field="payable_status" value={selected.payable_status} />
            </Group>
            <Text size="sm">
              Affiliate: <b>{selected.affiliate_id?.name}</b> · Brand: {selected.brand || '—'} · Platform ref: {selected.platform_ref || '—'}
            </Text>
            <Text size="sm">
              Submitted {dayjs(selected.submitted_at).format('DD MMM YYYY HH:mm')} · Signature deadline {selected.signature_deadline ? dayjs(selected.signature_deadline).format('DD MMM YYYY HH:mm') : '—'}
            </Text>
            {selected.rejection_reason && <Alert color="red" p="xs">Rejection: {selected.rejection_reason}</Alert>}
            {selected.replaces_lead && <Text size="sm">Replaces: <Code>{selected.replaces_lead.ref}</Code></Text>}
            {selected.replaced_by_lead && <Text size="sm">Replaced by: <Code>{selected.replaced_by_lead.ref}</Code></Text>}
            <Text size="sm">
              Due: upfront £{(selected.amounts?.upfront_due || 0).toFixed(2)} + confirmation £{(selected.amounts?.confirmation_due || 0).toFixed(2)} = <b>£{(selected.amounts?.total_due || 0).toFixed(2)}</b>
            </Text>

            {isAdmin && (
              <>
                <Divider label="Manual adjustment" />
                <Group grow>
                  <Select label="API status" data={opts(['pending', 'accepted', 'rejected'])} value={edit.initial_status ?? selected.initial_status} onChange={(v) => setEdit((e) => ({ ...e, initial_status: v }))} />
                  <Select label="Search status" data={opts(['virgin', 'searched', 'unknown'])} value={edit.search_status ?? selected.search_status} onChange={(v) => setEdit((e) => ({ ...e, search_status: v }))} />
                </Group>
                <Group grow>
                  <Select label="Signature" data={opts(['pending', 'passed', 'failed'])} value={edit.signature_status ?? selected.signature_status} onChange={(v) => setEdit((e) => ({ ...e, signature_status: v }))} />
                  <TextInput label="Rejection reason" value={edit.rejection_reason ?? (selected.rejection_reason || '')} onChange={(ev) => setEdit((e) => ({ ...e, rejection_reason: ev.target.value }))} />
                </Group>
                <Group grow align="end">
                  <Switch label="Law firm confirmed" checked={edit.law_firm_confirmed ?? selected.law_firm_confirmed} onChange={(ev) => setEdit((e) => ({ ...e, law_firm_confirmed: ev.currentTarget.checked }))} />
                  <TextInput label="Replaces ref (link as replacement)" placeholder="KB-2026-000001" value={edit.replaces_ref || ''} onChange={(ev) => setEdit((e) => ({ ...e, replaces_ref: ev.target.value }))} />
                </Group>
                <Button onClick={saveEdit} loading={saving} disabled={!Object.keys(edit).length}>Save changes</Button>
              </>
            )}

            <Divider label="History" />
            <Timeline bulletSize={16} lineWidth={2}>
              {[...(selected.history || [])].reverse().map((h, i) => (
                <Timeline.Item key={i} title={`${h.field}: ${h.from ?? '—'} → ${h.to}`}>
                  <Text size="xs" c="dimmed">{dayjs(h.at).format('DD MMM YYYY HH:mm')} · {h.source}{h.user ? ` · ${h.user}` : ''}</Text>
                </Timeline.Item>
              ))}
            </Timeline>

            <Divider label="Raw payload" />
            <Code block>{JSON.stringify(selected.payload, null, 2)}</Code>
          </Stack>
        )}
      </Drawer>
    </>
  );
}
