import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Card, Code, FileInput, Group, Select, Stack, Table, Text, TextInput, Title, Divider,
} from '@mantine/core';
import dayjs from 'dayjs';
import { api } from '../api';

const CANONICAL_FIELDS = [
  ['ref', 'Our ref (KB-…)'], ['platform_ref', 'Platform ref'], ['initial_status', 'API status'],
  ['rejection_reason', 'Rejection reason'], ['search_status', 'Search status'],
  ['signature_status', 'Signature status'], ['law_firm_confirmed', 'Law firm confirmed'],
];

export default function Imports() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null); // {headers, rows}
  const [mapping, setMapping] = useState({ match_by: 'ref', columns: {} });
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [matchRefs, setMatchRefs] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api('/imports').then(setHistory).catch(() => {});
    api('/webhooks/unmatched').then(setUnmatched).catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function doPreview() {
    setBusy(true); setError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const p = await api('/imports/preview', { method: 'POST', formData: fd });
      setPreview(p);
      const last = await api('/imports/last-mapping');
      if (last) setMapping(last);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function apply() {
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mapping', JSON.stringify(mapping));
      setResult(await api('/imports', { method: 'POST', formData: fd }));
      setPreview(null); setFile(null); load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function matchEvent(id) {
    try {
      await api(`/webhooks/${id}/match`, { method: 'POST', body: { ref: matchRefs[id] } });
      load();
    } catch (e) { setError(e.message); }
  }

  const headerOptions = preview ? preview.headers.map((h) => ({ value: h, label: h })) : [];

  return (
    <>
      <Title order={3} mb="md">Imports</Title>
      {error && <Alert color="red" mb="md" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
      {result && <Alert color="green" mb="md">Imported: {result.matched} matched, {result.unmatched} unmatched of {result.row_count} rows.</Alert>}

      <Card withBorder mb="lg">
        <Group align="end">
          <FileInput label="Platform report (CSV)" accept=".csv,text/csv" value={file} onChange={setFile} w={300} />
          <Button onClick={doPreview} disabled={!file} loading={busy}>Preview</Button>
        </Group>
        {preview && (
          <Stack mt="md">
            <Text size="sm" fw={600}>Map columns (unmapped fields are skipped)</Text>
            <Group>
              <Select label="Match leads by" w={180} data={[{ value: 'ref', label: 'Our ref (KB-…)' }, { value: 'platform_ref', label: 'Platform ref' }]}
                value={mapping.match_by} onChange={(v) => setMapping((m) => ({ ...m, match_by: v }))} />
            </Group>
            <Group wrap="wrap">
              {CANONICAL_FIELDS.map(([field, label]) => (
                <Select key={field} label={label} placeholder="—" clearable w={200} data={headerOptions}
                  value={mapping.columns[field] || null}
                  onChange={(v) => setMapping((m) => ({ ...m, columns: { ...m.columns, [field]: v || undefined } }))} />
              ))}
            </Group>
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>{preview.headers.map((h) => <Table.Th key={h}>{h}</Table.Th>)}</Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {preview.rows.map((r, i) => (
                  <Table.Tr key={i}>{preview.headers.map((h) => <Table.Td key={h}>{r[h]}</Table.Td>)}</Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Button onClick={apply} loading={busy} disabled={!mapping.columns[mapping.match_by]}>Apply import</Button>
          </Stack>
        )}
      </Card>

      <Title order={4} mb="sm">Unmatched webhooks</Title>
      {unmatched.length === 0 && <Text size="sm" c="dimmed" mb="md">None — all webhook events matched.</Text>}
      <Stack mb="lg">
        {unmatched.map((ev) => (
          <Card withBorder key={ev._id} p="sm">
            <Group justify="space-between" align="start">
              <Code block style={{ maxWidth: '70%' }}>{JSON.stringify(ev.payload)}</Code>
              <Group>
                <TextInput placeholder="KB-2026-000001" size="xs" value={matchRefs[ev._id] || ''}
                  onChange={(e) => setMatchRefs((m) => ({ ...m, [ev._id]: e.target.value }))} />
                <Button size="xs" onClick={() => matchEvent(ev._id)} disabled={!matchRefs[ev._id]}>Match</Button>
              </Group>
            </Group>
            <Text size="xs" c="dimmed" mt={4}>{dayjs(ev.at).format('DD MMM YYYY HH:mm')}</Text>
          </Card>
        ))}
      </Stack>

      <Divider mb="md" />
      <Title order={4} mb="sm">Import history</Title>
      <Table striped withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>When</Table.Th><Table.Th>File</Table.Th><Table.Th>By</Table.Th>
            <Table.Th>Rows</Table.Th><Table.Th>Matched</Table.Th><Table.Th>Unmatched</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {history.map((h) => (
            <Table.Tr key={h._id}>
              <Table.Td>{dayjs(h.at).format('DD MMM YYYY HH:mm')}</Table.Td>
              <Table.Td>{h.filename}</Table.Td><Table.Td>{h.uploaded_by}</Table.Td>
              <Table.Td>{h.row_count}</Table.Td><Table.Td>{h.matched}</Table.Td><Table.Td>{h.unmatched}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
