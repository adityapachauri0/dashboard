const fs = require('fs');
const path = require('path');
const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const { Counter } = require('../models/Counter');

const LINE_VIRGIN = 'PCP Claim Accepted Not Searched';
const LINE_SEARCHED = 'PCP Claim Payable Previous Search';
const VAT_RATE = 0.2;

const PAY_LABELS = {
  not_payable: 'Not payable',
  payable: 'Payable',
  partial_pending_confirmation: 'Part-paid — awaiting confirmation',
  payable_full: 'Payable in full',
  replaced: 'Replaced',
};

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => round2(n).toFixed(2);
const gbp = (n) => `£${round2(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const londonDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
const ddmmyyyy = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London' }).format(d);

// UTC instant of London midnight for a London date string. UTC midnight of the
// same date formats in London as 00 (GMT) or 01 (BST); subtract that hour.
function londonMidnightUtc(dayStr) {
  const guess = new Date(`${dayStr}T00:00:00Z`);
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(guess));
  return new Date(guess.getTime() - h * 3600 * 1000);
}

function periodBounds(dayStr) {
  const nextDay = londonDay(new Date(new Date(`${dayStr}T12:00:00Z`).getTime() + 24 * 3600 * 1000));
  return { start: londonMidnightUtc(dayStr), end: londonMidnightUtc(nextDay) };
}

function billableFilter(bounds) {
  return {
    submitted_at: { $gte: bounds.start, $lt: bounds.end },
    initial_status: 'accepted',
    cancelled: { $ne: true },
    signature_status: { $ne: 'failed' },
    replaced_by_lead: null,
    search_status: { $in: ['virgin', 'searched'] },
  };
}

const bluelionRates = () => ({
  virgin: Number(process.env.BLUELION_VIRGIN_RATE || 110),
  searched: Number(process.env.BLUELION_SEARCHED_RATE || 30),
});

function buildLines(counts, rates) {
  const lines = [
    { description: LINE_VIRGIN, qty: counts.virgin, rate: rates.virgin, amount: round2(counts.virgin * rates.virgin) },
    { description: LINE_SEARCHED, qty: counts.searched, rate: rates.searched, amount: round2(counts.searched * rates.searched) },
  ];
  const net = round2(lines.reduce((s, l) => s + l.amount, 0));
  const vat = round2(net * VAT_RATE);
  return { lines, net, vat, gross: round2(net + vat) };
}

async function previewInvoiceForDay(day) {
  const leads = await Lead.find(billableFilter(periodBounds(day)))
    .sort({ submitted_at: 1 }).populate('affiliate_id', 'name rate_card').lean();
  const counts = {
    virgin: leads.filter((l) => l.search_status === 'virgin').length,
    searched: leads.filter((l) => l.search_status === 'searched').length,
  };
  return { day, counts, calc: buildLines(counts, bluelionRates()), leads };
}

async function previewDailyInvoice(now = new Date()) {
  return previewInvoiceForDay(londonDay(new Date(now.getTime() - 24 * 3600 * 1000)));
}

async function nextInvoiceNumber() {
  const c = await Counter.findByIdAndUpdate('invoice_bluelion', { $inc: { seq: 1 } }, { new: true, upsert: true });
  return { seq: c.seq, number: `BlueLion ${String(c.seq).padStart(3, '0')}` };
}

async function generateInvoiceForDay(day, invoiceDate = new Date()) {
  const existing = await Invoice.findOne({ type: 'daily', period_end: day });
  if (existing) return { invoice: existing, created: false, leads: null };
  const { calc, leads } = await previewInvoiceForDay(day);
  if (!leads.length) return { invoice: null, created: false, leads: [] };
  const { seq, number } = await nextInvoiceNumber();
  let invoice;
  try {
    invoice = await Invoice.create({
      number, seq, type: 'daily', period_start: day, period_end: day, invoice_date: invoiceDate,
      lines: calc.lines, net: calc.net, vat: calc.vat, gross: calc.gross,
      email_to: process.env.INVOICE_TO_EMAIL || '',
    });
  } catch (err) {
    // ponytail: lost the race to a concurrent invocation for the same day — fall back to
    // the winner's doc instead of transactions/locking.
    if (err.code === 11000) {
      const raced = await Invoice.findOne({ type: 'daily', period_end: day });
      return { invoice: raced, created: false, leads: null };
    }
    throw err;
  }
  return { invoice, created: true, leads };
}

async function generateDailyInvoice(now = new Date()) {
  return generateInvoiceForDay(londonDay(new Date(now.getTime() - 24 * 3600 * 1000)), now);
}

const STORAGE_DIR = path.join(__dirname, '..', 'storage', 'invoices');
const ensureStorage = () => fs.mkdirSync(STORAGE_DIR, { recursive: true });

module.exports = {
  LINE_VIRGIN, LINE_SEARCHED, PAY_LABELS, VAT_RATE,
  round2, money, gbp, londonDay, ddmmyyyy, periodBounds, billableFilter,
  bluelionRates, buildLines, previewDailyInvoice, previewInvoiceForDay,
  generateDailyInvoice, generateInvoiceForDay,
  nextInvoiceNumber, STORAGE_DIR, ensureStorage,
};
