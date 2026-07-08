import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Code, Group, Modal, NumberInput, Stack, Switch, Table, TagsInput, Text,
  TextInput, Title, CopyButton, PasswordInput,
} from '@mantine/core';
import { api } from '../api';

const emptyForm = { name: '', lead_source: '', brands: [], rate_card: { virgin_rate: 0, searched_upfront_rate: 0, searched_confirmation_rate: 0 } };

export default function Affiliates() {
  const [affiliates, setAffiliates] = useState([]);
  const [stats, setStats] = useState({});
  const [modal, setModal] = useState(null); // {mode:'create'|'edit'|'user', affiliate?}
  const [form, setForm] = useState(emptyForm);
  const [newKey, setNewKey] = useState(null); // {name, key}
  const [userForm, setUserForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api('/affiliates').then(setAffiliates).catch((e) => setError(e.message));
    api('/dashboard/affiliate-breakdown?from=1970-01-01&to=2100-01-01')
      .then((rows) => setStats(Object.fromEntries(rows.map((r) => [r.affiliate_id, r]))))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function save() {
    try {
      if (modal.mode === 'create') {
        const res = await api('/affiliates', { method: 'POST', body: form });
        setNewKey({ name: res.affiliate.name, key: res.api_key });
      } else {
        await api(`/affiliates/${modal.affiliate._id}`, { method: 'PATCH', body: form });
      }
      setModal(null); load();
    } catch (e) { setError(e.message); }
  }

  async function rotate(a) {
    if (!window.confirm(`Rotate API key for ${a.name}? The old key stops working immediately.`)) return;
    try {
      const res = await api(`/affiliates/${a._id}/rotate-key`, { method: 'POST' });
      setNewKey({ name: a.name, key: res.api_key });
    } catch (e) { setError(e.message); }
  }

  async function addUser() {
    try {
      await api(`/affiliates/${modal.affiliate._id}/users`, { method: 'POST', body: userForm });
      setModal(null); setUserForm({ email: '', password: '' });
    } catch (e) { setError(e.message); }
  }

  const setRate = (k) => (v) => setForm((f) => ({ ...f, rate_card: { ...f.rate_card, [k]: Number(v) || 0 } }));

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Affiliates</Title>
        <Button onClick={() => { setForm(emptyForm); setModal({ mode: 'create' }); }}>New affiliate</Button>
      </Group>
      {error && <Alert color="red" mb="md" withCloseButton onClose={() => setError(null)}>{error}</Alert>}

      <Table striped withTableBorder highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th><Table.Th>Source</Table.Th><Table.Th>Key</Table.Th>
            <Table.Th>Rates (V / S / C)</Table.Th><Table.Th>Leads</Table.Th><Table.Th>Accept %</Table.Th>
            <Table.Th>Owed</Table.Th><Table.Th>Active</Table.Th><Table.Th></Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {affiliates.map((a) => {
            const s = stats[a._id] || {};
            return (
              <Table.Tr key={a._id}>
                <Table.Td>{a.name}</Table.Td>
                <Table.Td><Code>{a.lead_source}</Code></Table.Td>
                <Table.Td><Code>{a.api_key_prefix}…</Code></Table.Td>
                <Table.Td>£{a.rate_card?.virgin_rate} / £{a.rate_card?.searched_upfront_rate} / £{a.rate_card?.searched_confirmation_rate}</Table.Td>
                <Table.Td>{s.submitted || 0}</Table.Td>
                <Table.Td>{s.acceptance_rate ?? 0}%</Table.Td>
                <Table.Td>£{(s.owed || 0).toFixed(2)}</Table.Td>
                <Table.Td>{a.active ? 'yes' : 'no'}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    <Button size="compact-xs" variant="default" onClick={() => { setForm({ name: a.name, brands: a.brands || [], rate_card: { ...a.rate_card }, active: a.active }); setModal({ mode: 'edit', affiliate: a }); }}>Edit</Button>
                    <Button size="compact-xs" variant="default" onClick={() => rotate(a)}>Rotate key</Button>
                    <Button size="compact-xs" variant="default" onClick={() => setModal({ mode: 'user', affiliate: a })}>Add login</Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>

      <Modal opened={!!modal && modal.mode !== 'user'} onClose={() => setModal(null)} title={modal?.mode === 'create' ? 'New affiliate' : `Edit ${modal?.affiliate?.name}`}>
        <Stack>
          <TextInput label="Name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          {modal?.mode === 'create' && (
            <TextInput label="Lead source slug" description="lowercase, unique — used in shared-key submissions" value={form.lead_source} onChange={(e) => setForm((f) => ({ ...f, lead_source: e.target.value }))} required />
          )}
          <TagsInput label="Brands / domains" value={form.brands} onChange={(v) => setForm((f) => ({ ...f, brands: v }))} />
          <NumberInput label="Virgin search rate (£)" value={form.rate_card.virgin_rate} onChange={setRate('virgin_rate')} min={0} decimalScale={2} />
          <NumberInput label="Searched upfront rate (£)" value={form.rate_card.searched_upfront_rate} onChange={setRate('searched_upfront_rate')} min={0} decimalScale={2} />
          <NumberInput label="Searched confirmation rate (£)" value={form.rate_card.searched_confirmation_rate} onChange={setRate('searched_confirmation_rate')} min={0} decimalScale={2} />
          {modal?.mode === 'edit' && (
            <Switch label="Active" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.currentTarget.checked }))} />
          )}
          <Button onClick={save}>{modal?.mode === 'create' ? 'Create' : 'Save'}</Button>
        </Stack>
      </Modal>

      <Modal opened={modal?.mode === 'user'} onClose={() => setModal(null)} title={`Add login for ${modal?.affiliate?.name}`}>
        <Stack>
          <TextInput label="Email" value={userForm.email} onChange={(e) => setUserForm((f) => ({ ...f, email: e.target.value }))} />
          <PasswordInput label="Password" value={userForm.password} onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))} />
          <Button onClick={addUser}>Create login</Button>
        </Stack>
      </Modal>

      <Modal opened={!!newKey} onClose={() => setNewKey(null)} title={`API key for ${newKey?.name}`}>
        <Alert color="yellow" mb="sm">Copy this key now — it is shown only once.</Alert>
        <Group>
          <Code style={{ wordBreak: 'break-all' }}>{newKey?.key}</Code>
          <CopyButton value={newKey?.key || ''}>
            {({ copied, copy }) => <Button size="xs" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>}
          </CopyButton>
        </Group>
      </Modal>
    </>
  );
}
