// Calibration helper: renders a sample invoice from the template so stamp
// coordinates in services/invoicePdf.js can be visually verified.
//   node scripts/renderSampleInvoice.js && open ../storage/samples/sample-invoice.pdf
const fs = require('fs');
const path = require('path');
const { renderInvoicePdf } = require('../services/invoicePdf');

const out = path.join(__dirname, '..', 'storage', 'samples');
fs.mkdirSync(out, { recursive: true });

renderInvoicePdf({
  number: 'BlueLion 099',
  invoice_date: new Date(),
  lines: [
    { description: 'PCP Claim Accepted Not Searched', qty: 12, rate: 110, amount: 1320 },
    { description: 'PCP Claim Payable Previous Search', qty: 2, rate: 30, amount: 60 },
  ],
  net: 1380, vat: 276, gross: 1656,
}).then((buf) => {
  const file = path.join(out, 'sample-invoice.pdf');
  fs.writeFileSync(file, buf);
  console.log(`wrote ${file} (${buf.length} bytes)`);
});
