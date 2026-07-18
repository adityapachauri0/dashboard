const fs = require('fs');
const path = require('path');
const Invoice = require('../models/Invoice');
const ReconSend = require('../models/ReconSend');
const { generateDailyInvoice, previewDailyInvoice, money, STORAGE_DIR, ensureStorage } = require('./invoiceService');
const { renderInvoicePdf } = require('./invoicePdf');
const { buildBlueLionWorkbook } = require('./reconExcel');
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

async function runDaily(now = new Date(), { send = sendAccountsMail } = {}) {
  ensureStorage();
  const summary = { day: null, invoice: null, retried: 0, recons_sent: 0, recons_failed: 0 };

  // 1. retry earlier failures first (artifacts already on disk)
  const unsent = await Invoice.find({ email_status: { $ne: 'sent' } }).sort({ seq: 1 });
  for (const inv of unsent) {
    if (inv.pdf_file && (await emailInvoice(inv, send))) summary.retried += 1;
  }

  // 2. today's invoice
  const { invoice, created, leads } = await generateDailyInvoice(now);
  summary.day = invoice?.period_end || (await previewDailyInvoice(now)).day;
  if (invoice && created) {
    const seq3 = String(invoice.seq).padStart(3, '0');
    invoice.pdf_file = `BlueLion-${seq3}.pdf`;
    invoice.xlsx_file = `BlueLion-${seq3}.xlsx`;
    fs.writeFileSync(path.join(STORAGE_DIR, invoice.pdf_file), await renderInvoicePdf(invoice));
    fs.writeFileSync(path.join(STORAGE_DIR, invoice.xlsx_file), await buildBlueLionWorkbook(leads));
    await invoice.save();
    await emailInvoice(invoice, send);
  }
  if (invoice) {
    summary.invoice = { number: invoice.number, net: invoice.net, vat: invoice.vat, gross: invoice.gross, email_status: invoice.email_status };
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

module.exports = { runDaily, invoiceEmail };
