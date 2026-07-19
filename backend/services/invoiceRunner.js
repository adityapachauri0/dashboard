const fs = require('fs');
const path = require('path');
const Invoice = require('../models/Invoice');
const Lead = require('../models/Lead');
const ReconSend = require('../models/ReconSend');
const {
  generateInvoiceForDay, money, STORAGE_DIR, ensureStorage, periodBounds, billableFilter, londonDay,
} = require('./invoiceService');
// property access (not destructured) so tests can stub renderInvoicePdf/buildBlueLionWorkbook to fail
const invoicePdf = require('./invoicePdf');
const reconExcel = require('./reconExcel');
const { buildAffiliateRecons } = require('./affiliateRecon');
const { sendAccountsMail } = require('./mailer');

const ddmmyyyyFromDay = (day) => day.split('-').reverse().join('/');

function recipients() {
  const to = process.env.INVOICE_TO_EMAIL || process.env.INVOICE_CC || process.env.DIGEST_TO;
  const cc = process.env.INVOICE_CC && process.env.INVOICE_CC !== to ? process.env.INVOICE_CC : undefined;
  return { to, cc };
}

function invoiceEmail(invoice) {
  const period = ddmmyyyyFromDay(invoice.period_end);
  const [virgin, searched] = invoice.lines;
  const subject = `Invoice ${invoice.number} – Kickbyte Media Ltd – ${period}`;
  const text = `Good morning,

Please find attached Invoice ${invoice.number} for leads processed during the reporting period:

${period} 00:00 – ${period} 23:59

The invoice has been prepared in accordance with the agreed commercial terms and includes:

- Fully Payable (Virgin Search) Leads
- Part-Payable (Previous Search) Leads
- VAT calculated at 20%

For ease of reconciliation, we have also attached a supporting Excel workbook containing a detailed breakdown of all leads included within this invoice, together with an affiliate summary.

Invoice Summary

- Fully Payable Leads: ${virgin.qty}
- Part-Payable Leads: ${searched.qty}

Net Total: £${money(invoice.net)}
VAT (20%): £${money(invoice.vat)}
Invoice Total: £${money(invoice.gross)}

If you have any queries regarding the attached invoice or supporting reconciliation, please let us know.

Kind regards,
Kickbyte Media Ltd (Trading as Click2Leads)
`;
  const html = text.split('\n\n').map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
  return { subject, text, html };
}

function attachmentsFor(invoice) {
  return [
    { filename: `Invoice ${invoice.number}.pdf`, path: path.join(STORAGE_DIR, invoice.pdf_file) },
    { filename: `Reconciliation ${invoice.number}.xlsx`, path: path.join(STORAGE_DIR, invoice.xlsx_file) },
  ];
}

async function emailInvoice(invoice, send) {
  const { to, cc } = recipients();
  const { subject, text, html } = invoiceEmail(invoice);
  try {
    await send({ to, cc, subject, text, html, attachments: attachmentsFor(invoice) });
    invoice.email_to = to;
    invoice.email_status = 'sent';
    invoice.sent_at = new Date();
    invoice.email_error = undefined;
  } catch (e) {
    invoice.email_status = 'failed';
    invoice.email_error = e.message;
    console.error(`invoice ${invoice.number} email failed: ${e.message}`);
  }
  await invoice.save();
  return invoice.email_status === 'sent';
}

// Renders the PDF/XLSX, writes them to STORAGE_DIR, stamps the filenames on
// the invoice and saves — shared by the daily-generation path and the retry
// path so a stranded invoice (row persisted, artifacts never written) is
// healed with the exact same code that generates them the first time.
// Filenames are only stamped after both files are written successfully, so a
// render failure leaves pdf_file/xlsx_file unset — the invoice stays
// self-healing on the next run instead of looking "done" with missing files.
async function ensureArtifacts(invoice, leads) {
  if (!leads) {
    leads = await Lead.find(billableFilter(periodBounds(invoice.period_end)))
      .sort({ submitted_at: 1 }).populate('affiliate_id', 'name rate_card').lean();
  }
  const seq3 = String(invoice.seq).padStart(3, '0');
  const pdfFile = `BlueLion-${seq3}.pdf`;
  const xlsxFile = `BlueLion-${seq3}.xlsx`;
  const pdfBuf = await invoicePdf.renderInvoicePdf(invoice);
  const xlsxBuf = await reconExcel.buildBlueLionWorkbook(leads);
  fs.writeFileSync(path.join(STORAGE_DIR, pdfFile), pdfBuf);
  fs.writeFileSync(path.join(STORAGE_DIR, xlsxFile), xlsxBuf);
  invoice.pdf_file = pdfFile;
  invoice.xlsx_file = xlsxFile;
  await invoice.save();
}

async function runDaily(now = new Date(), { send = sendAccountsMail } = {}) {
  ensureStorage();
  const summary = { day: null, invoice: null, retried: 0, backfilled: 0, recons_sent: 0, recons_failed: 0 };

  // 1. retry earlier failures first — heal any stranded invoice (row saved,
  // artifacts never written, e.g. a prior render crash) before (re)sending.
  const unsent = await Invoice.find({ email_status: { $ne: 'sent' } }).sort({ seq: 1 });
  for (const inv of unsent) {
    if (!inv.pdf_file) {
      try {
        await ensureArtifacts(inv);
      } catch (e) {
        inv.email_status = 'failed';
        inv.email_error = e.message;
        await inv.save();
        console.error(`invoice ${inv.number} artifact regeneration failed: ${e.message}`);
        continue;
      }
    }
    if (await emailInvoice(inv, send)) summary.retried += 1;
  }

  // 2. yesterday's invoice, plus backfill of any earlier missed day within the
  // 3-day lookback — a server down across both cron firings previously meant
  // that day's invoice was skipped forever (retry in step 1 only heals rows
  // that already exist). Oldest day first so invoice numbers stay chronological.
  // Artifact generation/render/persist must never escape runDaily: the Invoice
  // row is already saved by generateInvoiceForDay, so a crash here is
  // contained and left for step 1 to heal on the next run.
  for (let n = 3; n >= 1; n -= 1) {
    const day = londonDay(new Date(now.getTime() - n * 24 * 3600 * 1000));
    const { invoice, created, leads } = await generateInvoiceForDay(day, now);
    if (invoice && created) {
      try {
        await ensureArtifacts(invoice, leads);
        await emailInvoice(invoice, send);
      } catch (e) {
        invoice.email_status = 'failed';
        invoice.email_error = e.message;
        console.error(`invoice ${invoice.number} generation failed: ${e.message}`);
        await invoice.save();
      }
      if (n > 1) summary.backfilled += 1;
    }
    if (n === 1) {
      summary.day = day;
      if (invoice) {
        summary.invoice = { number: invoice.number, net: invoice.net, vat: invoice.vat, gross: invoice.gross, email_status: invoice.email_status };
      }
    }
  }

  // 3. affiliate reconciliations (ReconSend row only on success → failures retry next run)
  for (const r of await buildAffiliateRecons(now)) {
    try {
      await send({
        to: r.to, subject: r.subject, text: r.text, html: r.html,
        attachments: [{ filename: `Reconciliation ${r.name} ${r.day}.xlsx`, content: r.xlsx }],
      });
      await ReconSend.create({ affiliate_id: r.affiliate_id, day: r.day, sent_at: new Date() });
      summary.recons_sent += 1;
    } catch (e) {
      summary.recons_failed += 1;
      console.error(`recon email to ${r.name} failed: ${e.message}`);
    }
  }
  return summary;
}

module.exports = { runDaily, invoiceEmail, recipients };
