const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { money, gbp, ddmmyyyy } = require('./invoiceService');

// The background is a flattened raster of the template, not the template PDF
// itself. Using the live PDF page (with wipe-and-overlay stamping) leaves the
// original text objects in the content stream, so copy/paste and AP-automation
// extraction see both the old and new figures on top of each other. Baking
// the template to an image removes that text layer entirely — pdftotext can
// no longer read the sample figures the template PDF ships with, because
// they're pixels, not text objects.
//
// The template PDF is itself a filled-in sample invoice (BlueLion 001 etc.),
// not a blank form, so those sample figures are still visible as pixels in
// the raster. We still draw white rectangles to visually cover them before
// stamping the real values — same as before, just covering image pixels
// instead of vector text. That keeps the page looking clean without
// reintroducing any extractable old text.
//
// assets/invoice-template-bluelion.pdf remains the source of truth. Regenerate
// the PNG whenever the template changes:
//   pdftoppm -r 300 -png -singlefile assets/invoice-template-bluelion.pdf assets/invoice-template-bluelion
const TEMPLATE_PNG = path.join(__dirname, '..', 'assets', 'invoice-template-bluelion.png');
const PAGE_WIDTH = 594.95996;
const PAGE_HEIGHT = 841.91998;

// Stamp coordinates in PDF points (origin bottom-left), calibrated against the
// client-approved template via scripts/renderSampleInvoice.js. If the template
// is ever regenerated, re-run that script and adjust here.
const C = {
  size: 9,
  header: { value_x: 470, wipe_w: 110, invoice_y: 626, date_y: 613, due_y: 588 },
  cols: { qty_r: 428, rate_r: 484, amount_r: 573 }, // right edges
  rows: { line1_y: 532.5, line2_y: 502.5 },
  totals: { label_wipe_x: 500, subtotal_y: 456, vat_y: 437, total_y: 418 },
  balance: { y: 386, size: 12 },
  vatSummary: { y: 337.5, vat_r: 405, net_r: 573 },
};

async function renderInvoicePdf(invoice) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const bg = await pdf.embedPng(fs.readFileSync(TEMPLATE_PNG));
  page.drawImage(bg, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // The template PDF we rasterized is itself a filled-in sample invoice, so
  // its sample figures are baked into the background image as pixels. These
  // rectangles cover those pixels before we stamp the real values — nothing
  // here covers text (there is none on this layer), only image pixels, so no
  // hidden/contradictory text objects are ever introduced.
  const wipe = (x, y, w, h = 13) => page.drawRectangle({ x, y: y - 3, width: w, height: h, color: rgb(1, 1, 1) });
  const text = (s, x, y, { f = font, size = C.size } = {}) =>
    page.drawText(String(s), { x, y, font: f, size, color: rgb(0, 0, 0) });
  const rtext = (s, xRight, y, { f = font, size = C.size } = {}) =>
    text(s, xRight - f.widthOfTextAtSize(String(s), size), y, { f, size });

  const dateStr = ddmmyyyy(invoice.invoice_date);
  // header block: INVOICE number, DATE, DUE DATE (TERMS row is static text)
  wipe(C.header.value_x, C.header.invoice_y, C.header.wipe_w);
  text(invoice.number, C.header.value_x, C.header.invoice_y);
  wipe(C.header.value_x, C.header.date_y, C.header.wipe_w);
  text(dateStr, C.header.value_x, C.header.date_y);
  wipe(C.header.value_x, C.header.due_y, C.header.wipe_w);
  text(dateStr, C.header.value_x, C.header.due_y);

  // line rows: qty / rate / amount (descriptions are static template text)
  const rows = [C.rows.line1_y, C.rows.line2_y];
  invoice.lines.forEach((l, i) => {
    wipe(C.cols.qty_r - 60, rows[i], C.cols.amount_r - C.cols.qty_r + 62);
    rtext(String(l.qty), C.cols.qty_r, rows[i]);
    rtext(money(l.rate), C.cols.rate_r, rows[i]);
    rtext(money(l.amount), C.cols.amount_r, rows[i]);
  });

  // totals
  for (const [y, v] of [[C.totals.subtotal_y, invoice.net], [C.totals.vat_y, invoice.vat], [C.totals.total_y, invoice.gross]]) {
    wipe(C.totals.label_wipe_x, y, C.cols.amount_r - C.totals.label_wipe_x + 2);
    rtext(money(v), C.cols.amount_r, y);
  }
  wipe(C.totals.label_wipe_x, C.balance.y, C.cols.amount_r - C.totals.label_wipe_x + 2, 16);
  rtext(gbp(invoice.gross), C.cols.amount_r, C.balance.y, { f: bold, size: C.balance.size });

  // VAT summary row: VAT and NET amounts
  wipe(C.vatSummary.vat_r - 70, C.vatSummary.y, 72);
  rtext(money(invoice.vat), C.vatSummary.vat_r, C.vatSummary.y);
  wipe(C.vatSummary.net_r - 70, C.vatSummary.y, 72);
  rtext(money(invoice.net), C.vatSummary.net_r, C.vatSummary.y);

  return Buffer.from(await pdf.save());
}

module.exports = { renderInvoicePdf };
