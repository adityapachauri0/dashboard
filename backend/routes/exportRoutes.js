const express = require('express');
const { stringify } = require('csv-stringify/sync');
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

router.get('/dashboard/export.csv', requireAuth, async (req, res) => {
  const filter = buildLeadFilter(req.query, req.user);
  const leads = await Lead.find(filter).sort({ submitted_at: -1 }).limit(50_000)
    .select('-payload -history').populate('affiliate_id', 'name').lean();
  const rows = leads.map((l) => ({
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
  const csv = stringify(rows, { header: true, columns: COLUMNS });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-export-${stamp}.csv"`);
  res.send(csv);
});

module.exports = router;
