const express = require('express');
const path = require('path');
const fs = require('fs');
const Invoice = require('../models/Invoice');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { STORAGE_DIR } = require('../services/invoiceService');
const { invoiceEmail, recipients } = require('../services/invoiceRunner');
// property access (not destructured) so tests can stub sendAccountsMail
const mailer = require('../services/mailer');

const router = express.Router();
router.use('/invoices', requireAuth, requireAdmin);

router.get('/invoices', async (req, res) => {
  const rows = await Invoice.find().sort({ seq: -1 }).limit(1000)
    .select('number type period_start period_end net vat gross email_status email_error payment_status sent_at email_to invoice_date').lean();
  res.json(rows);
});

function sendFile(res, invoice, field, downloadName) {
  const file = invoice[field];
  const full = file && path.join(STORAGE_DIR, path.basename(file)); // basename: no traversal
  if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'file not stored' });
  res.download(full, downloadName);
}

router.get('/invoices/:id/pdf', async (req, res) => {
  const inv = await Invoice.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  sendFile(res, inv, 'pdf_file', `Invoice ${inv.number}.pdf`);
});

router.get('/invoices/:id/xlsx', async (req, res) => {
  const inv = await Invoice.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  sendFile(res, inv, 'xlsx_file', `Reconciliation ${inv.number}.xlsx`);
});

router.patch('/invoices/:id', async (req, res) => {
  const { payment_status } = req.body || {};
  if (!['awaiting', 'paid'].includes(payment_status)) return res.status(400).json({ error: 'payment_status must be awaiting or paid' });
  const inv = await Invoice.findByIdAndUpdate(req.params.id, { payment_status }, { new: true });
  if (!inv) return res.status(404).json({ error: 'not found' });
  res.json(inv);
});

router.post('/invoices/:id/resend', async (req, res) => {
  const inv = await Invoice.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (!inv.pdf_file || !inv.xlsx_file) return res.status(409).json({ error: 'artifacts not stored' });
  const { subject, text, html } = invoiceEmail(inv);
  const { to, cc } = recipients();
  try {
    await mailer.sendAccountsMail({
      to, cc, subject, text, html,
      attachments: [
        { filename: `Invoice ${inv.number}.pdf`, path: path.join(STORAGE_DIR, path.basename(inv.pdf_file)) },
        { filename: `Reconciliation ${inv.number}.xlsx`, path: path.join(STORAGE_DIR, path.basename(inv.xlsx_file)) },
      ],
    });
    inv.email_to = to; inv.email_status = 'sent'; inv.sent_at = new Date(); inv.email_error = undefined;
    await inv.save();
    return res.json(inv);
  } catch (e) {
    inv.email_status = 'failed'; inv.email_error = e.message;
    await inv.save();
    return res.status(502).json({ error: `send failed: ${e.message}`, invoice: inv });
  }
});

module.exports = router;
