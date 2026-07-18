const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema(
  { description: String, qty: Number, rate: Number, amount: Number },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true }, // "BlueLion 001"
    seq: { type: Number, required: true },
    type: { type: String, enum: ['daily', 'confirmation'], default: 'daily' },
    period_start: { type: String, required: true }, // London date "2026-07-18"
    period_end: { type: String, required: true },
    invoice_date: { type: Date, required: true },   // due date = invoice date ("Due on receipt")
    lines: [lineSchema],
    net: { type: Number, required: true },
    vat: { type: Number, required: true },
    gross: { type: Number, required: true },
    email_to: String,
    email_status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
    email_error: String,
    sent_at: Date,
    payment_status: { type: String, enum: ['awaiting', 'paid'], default: 'awaiting' },
    pdf_file: String,  // filename inside backend/storage/invoices/
    xlsx_file: String,
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'last_updated' } }
);

// one daily invoice per reporting day — idempotency anchor
invoiceSchema.index({ type: 1, period_end: 1 }, { unique: true });

module.exports = mongoose.model('Invoice', invoiceSchema);
