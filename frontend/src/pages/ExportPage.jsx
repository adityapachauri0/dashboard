import { useEffect, useState } from 'react';
import { Alert, Button, Card, Select, Stack, Text, Title } from '@mantine/core';
import { DatePickerInput, MonthPickerInput } from '@mantine/dates';
import dayjs from 'dayjs';
import { api, download, getUser } from '../api';
import { PAYMENT_FILTER_OPTIONS, paymentFilterToParams } from '../components/StatusBadge';

const opts = (arr) => arr.map((v) => ({ value: v, label: v.replaceAll('_', ' ') }));

export default function ExportPage() {
  const user = getUser();
  const [affiliates, setAffiliates] = useState([]);
  const [affiliateId, setAffiliateId] = useState(null);
  const [range, setRange] = useState([dayjs().startOf('month').toDate(), new Date()]);
  const [initialStatus, setInitialStatus] = useState(null);
  const [payment, setPayment] = useState(null);
  const [nextUpdate, setNextUpdate] = useState(null);
  const [period, setPeriod] = useState(null);
  const [format, setFormat] = useState('xlsx');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stmtAffiliate, setStmtAffiliate] = useState(null);
  const [stmtMonth, setStmtMonth] = useState(dayjs().subtract(1, 'month').startOf('month').toDate());
  const [stmtBusy, setStmtBusy] = useState(false);

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
      for (const [k, v] of Object.entries(paymentFilterToParams(payment))) params.set(k, v);
      if (nextUpdate) params.set('next_update', nextUpdate);
      await download(`/dashboard/export.${format}?${params}`, `leads-export-${dayjs().format('YYYY-MM-DD')}.${format}`);
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
          <Select label="Payment status" placeholder="Any" clearable
            data={PAYMENT_FILTER_OPTIONS}
            value={payment} onChange={setPayment} />
          <Select label="Next update" placeholder="Any" clearable
            data={[
              { value: 'awaiting_confirmation', label: 'Awaiting confirmation' },
              { value: 'replacement_required', label: 'Replacement required' },
              { value: 'complete', label: 'Complete' },
            ]}
            value={nextUpdate} onChange={setNextUpdate} />
          <Select label="Format" value={format} allowDeselect={false}
            data={[{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV (.csv)' }]}
            onChange={setFormat} />
          <Button onClick={doExport} loading={busy}>Download {format.toUpperCase()}</Button>
        </Stack>
      </Card>

      <Title order={4} mt="lg" mb="sm">Monthly statement</Title>
      <Card withBorder maw={480}>
        <Stack>
          <Text size="sm" c="dimmed">One affiliate, one calendar month, with totals — what the affiliate invoices against.</Text>
          {user.role === 'admin' && (
            <Select label="Affiliate" placeholder="Choose affiliate" value={stmtAffiliate}
              data={affiliates.map((a) => ({ value: a._id, label: a.name }))} onChange={setStmtAffiliate} />
          )}
          <MonthPickerInput label="Month" value={stmtMonth} onChange={setStmtMonth} maxDate={new Date()} />
          <Button loading={stmtBusy} disabled={(user.role === 'admin' && !stmtAffiliate) || !stmtMonth}
            onClick={async () => {
              setStmtBusy(true); setError(null);
              try {
                const month = dayjs(stmtMonth).format('YYYY-MM');
                const params = new URLSearchParams({ month });
                if (stmtAffiliate) params.set('affiliate_id', stmtAffiliate);
                await download(`/dashboard/statement.xlsx?${params}`, `statement-${month}.xlsx`);
              } catch (e) { setError(e.message); } finally { setStmtBusy(false); }
            }}>
            Download statement
          </Button>
        </Stack>
      </Card>
    </>
  );
}
