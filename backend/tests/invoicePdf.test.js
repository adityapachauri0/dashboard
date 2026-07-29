const { test } = require('node:test');
const assert = require('node:assert');
const { renderInvoicePdf } = require('../services/invoicePdf');

const invoice = {
  number: 'BlueLion 007',
  invoice_date: new Date('2026-07-19T08:00:00Z'),
  lines: [
    { description: 'PCP Claim Accepted Not Searched', qty: 12, rate: 110, amount: 1320 },
    { description: 'PCP Claim Payable Previous Search', qty: 2, rate: 30, amount: 60 },
  ],
  net: 1380, vat: 276, gross: 1656,
};

test('renders a one-page PDF buffer from the template', async () => {
  const buf = await renderInvoicePdf(invoice);
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 10_000, `unexpectedly small: ${buf.length}`);
});

test('renders the confirmation template for type confirmation', async () => {
  const buf = await renderInvoicePdf({
    number: 'BlueLion 008', type: 'confirmation',
    invoice_date: new Date('2026-07-19T08:00:00Z'),
    lines: [{ description: 'PCP Claim Payable Lender Confirmation', qty: 3, rate: 80, amount: 240 }],
    net: 240, vat: 48, gross: 288,
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 10_000, `unexpectedly small: ${buf.length}`);
});
