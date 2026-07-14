const express = require('express');
const { stringify } = require('csv-stringify/sync');
const ExcelJS = require('exceljs');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const { requireAuth } = require('../middleware/auth');
const { buildLeadFilter } = require('../services/leadFilter');
const { slaState } = require('../services/replacementService');

const router = express.Router();

// neutralise spreadsheet formula prefixes in externally-supplied text
const csvSafe = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

const COLUMNS = [
  'ref', 'submitted_at', 'affiliate', 'lead_source', 'brand', 'applicant_name',
  'initial_status', 'rejection_reason', 'search_status', 'signature_status',
  'signature_deadline', 'law_firm_confirmed', 'payable_status',
  'replacement_status', 'replacement_requested_at', 'replacement_sla',
  'upfront_due', 'confirmation_due', 'total_due', 'platform_ref', 'last_updated',
];

async function fetchExportRows(query, user) {
  const filter = buildLeadFilter(query, user);
  const leads = await Lead.find(filter).sort({ submitted_at: -1 }).limit(50_000)
    .select('-payload -history').populate('affiliate_id', 'name').lean();
  return leads.map((l) => ({
    ref: l.ref,
    submitted_at: l.submitted_at?.toISOString() || '',
    affiliate: csvSafe(l.affiliate_id?.name),
    lead_source: csvSafe(l.lead_source),
    brand: csvSafe(l.brand),
    applicant_name: csvSafe(l.applicant_name),
    initial_status: l.initial_status,
    rejection_reason: csvSafe(l.rejection_reason),
    search_status: l.search_status,
    signature_status: l.signature_status,
    signature_deadline: l.signature_deadline?.toISOString() || '',
    law_firm_confirmed: l.law_firm_confirmed ? 'yes' : 'no',
    payable_status: l.payable_status,
    replacement_status: l.replacement_status || 'none',
    replacement_requested_at: l.replacement_requested_at?.toISOString() || '',
    replacement_sla: slaState(l)?.label || '',
    upfront_due: l.amounts?.upfront_due ?? 0,
    confirmation_due: l.amounts?.confirmation_due ?? 0,
    total_due: l.amounts?.total_due ?? 0,
    platform_ref: csvSafe(l.platform_ref),
    last_updated: l.last_updated?.toISOString() || '',
  }));
}

const stamp = () => new Date().toISOString().slice(0, 10);

router.get('/dashboard/export.csv', requireAuth, async (req, res) => {
  const rows = await fetchExportRows(req.query, req.user);
  const csv = stringify(rows, { header: true, columns: COLUMNS });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-export-${stamp()}.csv"`);
  res.send(csv);
});

router.get('/dashboard/export.xlsx', requireAuth, async (req, res) => {
  const rows = await fetchExportRows(req.query, req.user);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Leads');
  ws.columns = COLUMNS.map((c) => ({ header: c, key: c, width: Math.max(12, c.length + 2) }));
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="leads-export-${stamp()}.xlsx"`);
  res.send(Buffer.from(buffer));
});

// Monthly statement: one affiliate, one calendar month, with a totals row —
// what the affiliate invoices against.
router.get('/dashboard/statement.xlsx', requireAuth, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  if (!month) return res.status(400).json({ error: 'month=YYYY-MM required' });
  const affiliateId = req.user.role === 'affiliate' ? String(req.user.affiliate_id) : req.query.affiliate_id;
  if (!affiliateId) return res.status(400).json({ error: 'affiliate_id required' });
  const affiliate = await Affiliate.findById(affiliateId).select('name lead_source').lean().catch(() => null);
  if (!affiliate) return res.status(400).json({ error: 'affiliate not found' });

  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const rows = await fetchExportRows(
    { affiliate_id: affiliateId, from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` },
    req.user
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Statement');
  ws.columns = COLUMNS.map((c) => ({ key: c, width: Math.max(12, c.length + 2) }));
  ws.addRow([`Statement — ${csvSafe(affiliate.name)}`]).font = { bold: true, size: 14 };
  ws.addRow([`Period: ${month}`]);
  ws.addRow([`Generated: ${stamp()}`]);
  ws.addRow([]);
  ws.addRow(COLUMNS).font = { bold: true };
  rows.forEach((r) => ws.addRow(COLUMNS.map((c) => r[c])));
  ws.addRow([]);
  const sum = (k) => Math.round(rows.reduce((t, r) => t + (Number(r[k]) || 0), 0) * 100) / 100;
  const totals = ws.addRow({
    ref: 'TOTALS',
    applicant_name: `${rows.length} lead${rows.length === 1 ? '' : 's'}`,
    upfront_due: sum('upfront_due'),
    confirmation_due: sum('confirmation_due'),
    total_due: sum('total_due'),
  });
  totals.font = { bold: true };
  const outstanding = rows.filter((r) => r.replacement_status === 'required').length;
  const outRow = ws.addRow({ ref: 'OUTSTANDING REPLACEMENTS', applicant_name: String(outstanding) });
  outRow.font = { bold: true };

  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="statement-${affiliate.lead_source || 'affiliate'}-${month}.xlsx"`);
  res.send(Buffer.from(buffer));
});

module.exports = router;
