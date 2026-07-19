import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Group, Select, Table, Title } from '@mantine/core';
import { api, download } from '../api';

const fmtGBP = (n) => `£${(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDay = (d) => (d ? d.split('-').reverse().join('/') : '');
const EMAIL_COLORS = { sent: 'green', failed: 'red', pending: 'yellow' };

export default function Invoices() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    api('/invoices').then(setRows).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function setPayment(inv, payment_status) {
    try { await api(`/invoices/${inv._id}`, { method: 'PATCH', body: { payment_status } }); load(); }
    catch (e) { setError(e.message); }
  }

  async function resend(inv) {
    if (!window.confirm(`Re-send ${inv.number} by email?`)) return;
    setBusy(inv._id);
    try { await api(`/invoices/${inv._id}/resend`, { method: 'POST' }); load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  return (
    <>
      <Group justify="space-between" mb="md"><Title order={3}>Invoices</Title></Group>
      {error && <Alert color="red" mb="md" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
      <Table striped withTableBorder highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Invoice</Table.Th><Table.Th>Period</Table.Th><Table.Th>Net</Table.Th>
            <Table.Th>VAT</Table.Th><Table.Th>Total</Table.Th><Table.Th>Email</Table.Th>
            <Table.Th>Payment</Table.Th><Table.Th></Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((i) => (
            <Table.Tr key={i._id}>
              <Table.Td>{i.number}</Table.Td>
              <Table.Td>{fmtDay(i.period_end)}</Table.Td>
              <Table.Td>{fmtGBP(i.net)}</Table.Td>
              <Table.Td>{fmtGBP(i.vat)}</Table.Td>
              <Table.Td>{fmtGBP(i.gross)}</Table.Td>
              <Table.Td>
                <Badge color={EMAIL_COLORS[i.email_status] || 'gray'} variant="light" title={i.email_error || ''}>
                  {i.email_status}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Select size="xs" w={110} data={['awaiting', 'paid']} value={i.payment_status} onChange={(v) => v && setPayment(i, v)} />
              </Table.Td>
              <Table.Td>
                <Group gap={4}>
                  <Button size="compact-xs" variant="default" onClick={() => download(`/invoices/${i._id}/pdf`, `Invoice ${i.number}.pdf`)}>PDF</Button>
                  <Button size="compact-xs" variant="default" onClick={() => download(`/invoices/${i._id}/xlsx`, `Reconciliation ${i.number}.xlsx`)}>Excel</Button>
                  <Button size="compact-xs" variant="default" loading={busy === i._id} onClick={() => resend(i)}>Resend</Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
