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
// assets/invoice-template-bluelion*.pdf remain the source of truth. Regenerate
// the PNGs whenever a template changes:
//   pdftoppm -r 300 -png -singlefile assets/invoice-template-bluelion.pdf assets/invoice-template-bluelion
//   pdftoppm -r 300 -png -singlefile assets/invoice-template-bluelion-confirmation.pdf assets/invoice-template-bluelion-confirmation
const PAGE_WIDTH = 594.95996;
const PAGE_HEIGHT = 841.91998;

// Stamp coordinates in PDF points (origin bottom-left), calibrated against the
// client-approved template via scripts/renderSampleInvoice.js. If a template
// is ever regenerated, re-run that script and adjust here.
//
// The confirmation template (client "Invoice BlueLion 0002") drops the second
// line row, so its totals/balance/VAT-summary blocks sit 22.5pt higher —
// measured via pdftotext -bbox against both template PDFs, applied as a delta
// to the visually-calibrated daily values so both stay anchored to the same
// approved calibration.
const C = {
  size: 9,
  header: { value_x: 470, wipe_w: 110, invoice_y: 626, date_y: 613, due_y: 588 },
  cols: { qty_r: 428, rate_r: 484, amount_r: 573 }, // right edges
};

const TYPE_LAYOUT = {
  daily: {
    template: 'invoice-template-bluelion.png',
    rows: [532.5, 502.5],
    totals: { label_wipe_x: 500, subtotal_y: 456, vat_y: 437, total_y: 418 },
    balance: { y: 386, size: 12 },
    vatSummary: { y: 337.5, vat_r: 405, net_r: 573 },
  },
  confirmation: {
    template: 'invoice-template-bluelion-confirmation.png',
    rows: [532.5],
    totals: { label_wipe_x: 500, subtotal_y: 478.5, vat_y: 459.5, total_y: 440.5 },
    balance: { y: 408.5, size: 12 },
    vatSummary: { y: 360, vat_r: 405, net_r: 573 },
  },
};

async function renderInvoicePdf(invoice) {
  const L = TYPE_LAYOUT[invoice.type] || TYPE_LAYOUT.daily;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const bg = await pdf.embedPng(fs.readFileSync(path.join(__dirname, '..', 'assets', L.template)));
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
  invoice.lines.forEach((l, i) => {
    wipe(C.cols.qty_r - 60, L.rows[i], C.cols.amount_r - C.cols.qty_r + 62);
    rtext(String(l.qty), C.cols.qty_r, L.rows[i]);
    rtext(money(l.rate), C.cols.rate_r, L.rows[i]);
    rtext(money(l.amount), C.cols.amount_r, L.rows[i]);
  });

  // totals
  for (const [y, v] of [[L.totals.subtotal_y, invoice.net], [L.totals.vat_y, invoice.vat], [L.totals.total_y, invoice.gross]]) {
    wipe(L.totals.label_wipe_x, y, C.cols.amount_r - L.totals.label_wipe_x + 2);
    rtext(money(v), C.cols.amount_r, y);
  }
  wipe(L.totals.label_wipe_x, L.balance.y, C.cols.amount_r - L.totals.label_wipe_x + 2, 16);
  rtext(gbp(invoice.gross), C.cols.amount_r, L.balance.y, { f: bold, size: L.balance.size });

  // VAT summary row: VAT and NET amounts
  wipe(L.vatSummary.vat_r - 70, L.vatSummary.y, 72);
  rtext(money(invoice.vat), L.vatSummary.vat_r, L.vatSummary.y);
  wipe(L.vatSummary.net_r - 70, L.vatSummary.y, 72);
  rtext(money(invoice.net), L.vatSummary.net_r, L.vatSummary.y);

  return Buffer.from(await pdf.save());
}

module.exports = { renderInvoicePdf };
