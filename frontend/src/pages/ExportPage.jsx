import { useEffect, useState } from 'react';
import { Alert, Button, Card, Select, Stack, Title } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import dayjs from 'dayjs';
import { api, download, getUser } from '../api';

const opts = (arr) => arr.map((v) => ({ value: v, label: v.replaceAll('_', ' ') }));

export default function ExportPage() {
  const user = getUser();
  const [affiliates, setAffiliates] = useState([]);
  const [affiliateId, setAffiliateId] = useState(null);
  const [range, setRange] = useState([dayjs().startOf('month').toDate(), new Date()]);
  const [initialStatus, setInitialStatus] = useState(null);
  const [payableStatus, setPayableStatus] = useState(null);
  const [period, setPeriod] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user.role === 'admin') api('/affiliates').then(setAffiliates).catch(() => {});
  }, [user.role]);

  function setPresetPeriod(p) {
    setPeriod(p);
    if (p === 'this_week') setRange([dayjs().startOf('week').toDate(), new Date()]);
    if (p === 'last_week') setRange([dayjs().subtract(1, 'week').startOf('week').toDate(), dayjs().subtract(1, 'week').endOf('week').toDate()]);
    if (p === 'this_month') setRange([dayjs().startOf('month').toDate(), new Date()]);
    if (p === 'last_month') setRange([dayjs().subtract(1, 'month').startOf('month').toDate(), dayjs().subtract(1, 'month').endOf('month').toDate()]);
  }

  async function doExport() {
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (affiliateId) params.set('affiliate_id', affiliateId);
      if (range[0]) params.set('from', dayjs(range[0]).format('YYYY-MM-DD'));
      if (range[1]) params.set('to', dayjs(range[1]).format('YYYY-MM-DD'));
      if (initialStatus) params.set('initial_status', initialStatus);
      if (payableStatus) params.set('payable_status', payableStatus);
      await download(`/dashboard/export.csv?${params}`, `leads-export-${dayjs().format('YYYY-MM-DD')}.csv`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <Title order={3} mb="md">Export</Title>
      {error && <Alert color="red" mb="md">{error}</Alert>}
      <Card withBorder maw={480}>
        <Stack>
          {user.role === 'admin' && (
            <Select label="Affiliate" placeholder="All affiliates" clearable value={affiliateId}
              data={affiliates.map((a) => ({ value: a._id, label: a.name }))} onChange={setAffiliateId} />
          )}
          <Select label="Reconciliation period" placeholder="Custom range" clearable value={period}
            data={[
              { value: 'this_week', label: 'This week' }, { value: 'last_week', label: 'Last week' },
              { value: 'this_month', label: 'This month' }, { value: 'last_month', label: 'Last month' },
            ]}
            onChange={setPresetPeriod} />
          <DatePickerInput type="range" label="Date range" value={range} onChange={(v) => { setPeriod(null); setRange(v); }} />
          <Select label="Lead status" placeholder="Any" clearable data={opts(['pending', 'accepted', 'rejected'])} value={initialStatus} onChange={setInitialStatus} />
          <Select label="Payable status" placeholder="Any" clearable data={opts(['not_payable', 'payable', 'partial_pending_confirmation', 'payable_full', 'replaced'])} value={payableStatus} onChange={setPayableStatus} />
          <Button onClick={doExport} loading={busy}>Download CSV</Button>
        </Stack>
      </Card>
    </>
  );
}
