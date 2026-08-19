const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const { Counter } = require('../models/Counter');

const LINE_VIRGIN = 'PCP Claim Accepted Not Searched';
const LINE_SEARCHED = 'PCP Claim Payable Previous Search';
const LINE_CONFIRMATION = 'PCP Claim Payable Lender Confirmation';
const VAT_RATE = 0.2;

// How many past London days self-heal on each run: a stranded invoice/recon
// (SMTP down, crash) from day D is retried on every run for the next
// LOOKBACK_DAYS days after D, then given up on. Shared by invoiceRunner's
// backfill loop, affiliateRecon's resend loop, and sendInvoices --dry-run.
const LOOKBACK_DAYS = 3;

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
  return { seq: c.seq, number: `BlueLion ${String(c.seq).padStart(4, '0')}` };
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

// ---- Deferred "Lender Confirmation" invoices (client spec 2026-07-29) ----
// Searched claims that BlueLion later confirms with the lender flip to
// payable_full; statusService stamps payable_full_at at that moment. The 9am
// run bills every stamped-but-unbilled claim from before today — normally
// just yesterday's, but a missed run's claims are swept up automatically.
// Leads with no stamp (transitions before this feature deployed) never bill.

const confirmationRate = () => Number(process.env.BLUELION_CONFIRMATION_RATE || 80);

function confirmationFilter(now) {
  return {
    payable_full_at: { $lt: londonMidnightUtc(londonDay(now)) },
    confirmation_invoice: null,
    payable_status: 'payable_full',
    search_status: 'searched',
    cancelled: { $ne: true },
    replaced_by_lead: null,
  };
}

function buildConfirmationLines(qty, rate) {
  const lines = [{ description: LINE_CONFIRMATION, qty, rate, amount: round2(qty * rate) }];
  const net = lines[0].amount;
  const vat = round2(net * VAT_RATE);
  return { lines, net, vat, gross: round2(net + vat) };
}

async function previewConfirmationInvoice(now = new Date()) {
  const leads = await Lead.find(confirmationFilter(now))
    .sort({ payable_full_at: 1 }).populate('affiliate_id', 'name rate_card').lean();
  return { counts: { confirmed: leads.length }, calc: buildConfirmationLines(leads.length, confirmationRate()), leads };
}

// A lead claimed by an invoice _id that was never created (crash between the
// claim below and Invoice.create) would otherwise be stranded unbilled —
// release such claims so the next run re-bills them.
async function releaseOrphanConfirmationClaims() {
  const claimed = await Lead.distinct('confirmation_invoice', { confirmation_invoice: { $ne: null } });
  if (!claimed.length) return 0;
  const known = await Invoice.find({ _id: { $in: claimed } }).distinct('_id');
  const knownSet = new Set(known.map(String));
  const orphans = claimed.filter((id) => !knownSet.has(String(id)));
  if (!orphans.length) return 0;
  const r = await Lead.updateMany({ confirmation_invoice: { $in: orphans } }, { $unset: { confirmation_invoice: 1 } });
  return r.modifiedCount;
}

async function generateConfirmationInvoice(now = new Date()) {
  const day = londonDay(new Date(now.getTime() - 24 * 3600 * 1000));
  const existing = await Invoice.findOne({ type: 'confirmation', period_end: day });
  if (existing) return { invoice: existing, created: false, leads: null };
  await releaseOrphanConfirmationClaims();
  // Claim-first idempotency: atomically tag the billable leads with the id the
  // invoice will be created under. A concurrent run claims nothing and exits;
  // a crash after claiming is healed by releaseOrphanConfirmationClaims.
  const invId = new mongoose.Types.ObjectId();
  await Lead.updateMany(confirmationFilter(now), { $set: { confirmation_invoice: invId } });
  const leads = await Lead.find({ confirmation_invoice: invId })
    .sort({ payable_full_at: 1 }).populate('affiliate_id', 'name rate_card').lean();
  if (!leads.length) return { invoice: null, created: false, leads: [] };
  const calc = buildConfirmationLines(leads.length, confirmationRate());
  const { seq, number } = await nextInvoiceNumber();
  const invoice = await Invoice.create({
    _id: invId, number, seq, type: 'confirmation',
    period_start: londonDay(leads[0].payable_full_at), period_end: day, invoice_date: now,
    lines: calc.lines, net: calc.net, vat: calc.vat, gross: calc.gross,
    email_to: process.env.INVOICE_TO_EMAIL || '',
  });
  return { invoice, created: true, leads };
}

const STORAGE_DIR = path.join(__dirname, '..', 'storage', 'invoices');
const ensureStorage = () => fs.mkdirSync(STORAGE_DIR, { recursive: true });

module.exports = {
  LINE_VIRGIN, LINE_SEARCHED, LINE_CONFIRMATION, PAY_LABELS, VAT_RATE, LOOKBACK_DAYS,
  round2, money, gbp, londonDay, ddmmyyyy, periodBounds, billableFilter,
  bluelionRates, buildLines, previewDailyInvoice, previewInvoiceForDay,
  generateDailyInvoice, generateInvoiceForDay,
  confirmationRate, confirmationFilter, buildConfirmationLines,
  previewConfirmationInvoice, generateConfirmationInvoice, releaseOrphanConfirmationClaims,
  nextInvoiceNumber, STORAGE_DIR, ensureStorage,
};
