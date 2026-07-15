const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const ImportRecord = require('../models/ImportRecord');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { normalizeField } = require('../services/normalize');
const { applyStatusChanges } = require('../services/statusService');
const { propagateReplacementOutcome } = require('../services/replacementService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.use('/imports', requireAuth, requireAdmin);

const STATUS_FIELDS = ['initial_status', 'search_status', 'signature_status', 'law_firm_confirmed', 'cancelled'];
const TEXT_FIELDS = ['platform_ref', 'rejection_reason'];

function parseCsv(buffer) {
  return parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
}

router.post('/imports/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const rows = parseCsv(req.file.buffer);
  res.json({ headers: rows.length ? Object.keys(rows[0]) : [], rows: rows.slice(0, 5) });
});

router.post('/imports', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  let mapping;
  try {
    mapping = JSON.parse(req.body.mapping);
  } catch {
    return res.status(400).json({ error: 'mapping must be valid JSON' });
  }
  if (!['ref', 'platform_ref'].includes(mapping.match_by) || !mapping.columns?.[mapping.match_by]) {
    return res.status(400).json({ error: 'mapping.match_by must be ref or platform_ref with a mapped column' });
  }

  const rows = parseCsv(req.file.buffer);
  const rateCards = new Map(); // affiliate_id -> rate_card, cached per import
  let matched = 0;
  let unmatched = 0;

  for (const row of rows) {
    const matchVal = (row[mapping.columns[mapping.match_by]] || '').trim();
    const lead = matchVal
      ? await Lead.findOne(mapping.match_by === 'ref' ? { ref: matchVal } : { platform_ref: matchVal })
      : null;
    if (!lead) { unmatched++; continue; }

    const changes = {};
    for (const field of [...STATUS_FIELDS, ...TEXT_FIELDS]) {
      const col = mapping.columns[field];
      if (!col || row[col] === undefined || row[col] === '') continue;
      changes[field] = STATUS_FIELDS.includes(field) ? normalizeField(field, row[col]) : row[col];
    }

    const affId = lead.affiliate_id.toString();
    if (!rateCards.has(affId)) {
      const aff = await Affiliate.findById(affId).lean();
      rateCards.set(affId, aff?.rate_card || {});
    }
    applyStatusChanges(lead, changes, rateCards.get(affId), { source: 'import', user: req.user.email });
    await lead.save();
    await propagateReplacementOutcome(lead, { source: 'import', user: req.user.email });
    matched++;
  }

  await ImportRecord.create({
    filename: req.file.originalname, uploaded_by: req.user.email,
    row_count: rows.length, matched, unmatched, mapping,
  });
  res.json({ row_count: rows.length, matched, unmatched });
});

router.get('/imports', async (req, res) => {
  res.json(await ImportRecord.find().sort({ at: -1 }).limit(50).lean());
});

router.get('/imports/last-mapping', async (req, res) => {
  const last = await ImportRecord.findOne().sort({ at: -1 }).lean();
  res.json(last ? last.mapping : null);
});

module.exports = router;
