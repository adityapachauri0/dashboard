const express = require('express');
const { stringify } = require('csv-stringify/sync');
const ExcelJS = require('exceljs');
const Lead = require('../models/Lead');
const { requireAuth } = require('../middleware/auth');
const { buildLeadFilter } = require('../services/leadFilter');

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
  'upfront_due', 'confirmation_due', 'total_due', 'platform_ref', 'last_updated',
];

async function fetchExportRows(req) {
  const filter = buildLeadFilter(req.query, req.user);
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
    upfront_due: l.amounts?.upfront_due ?? 0,
    confirmation_due: l.amounts?.confirmation_due ?? 0,
    total_due: l.amounts?.total_due ?? 0,
    platform_ref: csvSafe(l.platform_ref),
    last_updated: l.last_updated?.toISOString() || '',
  }));
}

const stamp = () => new Date().toISOString().slice(0, 10);

router.get('/dashboard/export.csv', requireAuth, async (req, res) => {
  const rows = await fetchExportRows(req);
  const csv = stringify(rows, { header: true, columns: COLUMNS });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-export-${stamp()}.csv"`);
  res.send(csv);
});

router.get('/dashboard/export.xlsx', requireAuth, async (req, res) => {
  const rows = await fetchExportRows(req);
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

module.exports = router;
