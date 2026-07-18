# Automated Daily Invoicing & Affiliate Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily 09:00 Europe/London run that emails BlueLion a VAT invoice PDF + Excel reconciliation for yesterday's leads, emails each active affiliate their reconciliation, and stores every invoice for a new dashboard Invoices page.

**Architecture:** New `Invoice`/`ReconSend` mongoose models; pure calculation + orchestration services following the existing `digest.js`/`sendDigest.js` cron-script pattern; PDF made by stamping values onto the client-approved template PDF with `pdf-lib`; Excel via already-installed ExcelJS; email via nodemailer through GoDaddy SMTP (`accounts@click2leads.co.uk`).

**Tech Stack:** Node 18+ (CommonJS), Express, Mongoose 8, ExcelJS, nodemailer, `pdf-lib` (new dep), node:test + supertest + mongodb-memory-server, React + Mantine frontend.

## Global Constraints

- Repo: `~/Desktop/pcp-affiliate-dashboard`. Backend cwd for all backend commands: `backend/`.
- Spec: `docs/superpowers/specs/2026-07-19-automated-invoicing-design.md`. Read it before starting.
- All money values are pounds with 2-dp rounding: `Math.round(n * 100) / 100`. VAT rate 0.20.
- Billing day = **Europe/London calendar day**; leads assigned by `submitted_at` within London-midnight UTC bounds (BST-safe). Never use `new Date('YYYY-MM-DD')` for day boundaries.
- Invoice line wording (exact): `PCP Claim Accepted Not Searched` (£110 default), `PCP Claim Payable Previous Search` (£30 default). Rates via env `BLUELION_VIRGIN_RATE` / `BLUELION_SEARCHED_RATE`.
- Invoice number format: `BlueLion ` + seq zero-padded to 3 (`BlueLion 001`); from existing `Counter` collection, id `invoice_bluelion`.
- Billable lead: `initial_status='accepted'`, not `cancelled`, `signature_status!='failed'`, no `replaced_by_lead`, `search_status` in `virgin|searched`.
- No LLM anywhere. All values computed arithmetically.
- Tests: node:test, run as `node --test tests/<file>.test.js` from `backend/`. Follow `tests/helpers.js` setup pattern.
- Commit after every task (conventional commits, as in git log).
- Never commit real SMTP credentials; env only.

---

### Task 1: Invoice + ReconSend models

**Files:**
- Create: `backend/models/Invoice.js`
- Create: `backend/models/ReconSend.js`
- Test: `backend/tests/invoiceModels.test.js`

**Interfaces:**
- Produces: `Invoice` (mongoose model, fields below), `ReconSend` (fields: `affiliate_id`, `day`, `sent_at`; unique per affiliate+day). Later tasks import via `require('../models/Invoice')`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/invoiceModels.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Invoice = require('../models/Invoice');
const ReconSend = require('../models/ReconSend');
const mongoose = require('mongoose');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

const base = {
  number: 'BlueLion 001', seq: 1, period_start: '2026-07-18', period_end: '2026-07-18',
  invoice_date: new Date(), lines: [{ description: 'PCP Claim Accepted Not Searched', qty: 2, rate: 110, amount: 220 }],
  net: 220, vat: 44, gross: 264,
};

test('invoice defaults and duplicate period rejected', async () => {
  const inv = await Invoice.create(base);
  assert.strictEqual(inv.type, 'daily');
  assert.strictEqual(inv.email_status, 'pending');
  assert.strictEqual(inv.payment_status, 'awaiting');
  await Invoice.syncIndexes();
  await assert.rejects(Invoice.create({ ...base, number: 'BlueLion 002', seq: 2 }), /duplicate/i);
});

test('same period allowed for different type', async () => {
  await Invoice.syncIndexes();
  await Invoice.create(base);
  const conf = await Invoice.create({ ...base, number: 'BlueLion 002', seq: 2, type: 'confirmation' });
  assert.strictEqual(conf.type, 'confirmation');
});

test('recon send unique per affiliate+day', async () => {
  const aid = new mongoose.Types.ObjectId();
  await ReconSend.syncIndexes();
  await ReconSend.create({ affiliate_id: aid, day: '2026-07-18', sent_at: new Date() });
  await assert.rejects(ReconSend.create({ affiliate_id: aid, day: '2026-07-18' }), /duplicate/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Desktop/pcp-affiliate-dashboard/backend && node --test tests/invoiceModels.test.js`
Expected: FAIL — `Cannot find module '../models/Invoice'`

- [ ] **Step 3: Write the models**

```js
// backend/models/Invoice.js
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
```

```js
// backend/models/ReconSend.js
const mongoose = require('mongoose');

// one reconciliation email per affiliate per reporting day
const reconSendSchema = new mongoose.Schema({
  affiliate_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true },
  day: { type: String, required: true }, // London date "2026-07-18"
  sent_at: Date,
});
reconSendSchema.index({ affiliate_id: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('ReconSend', reconSendSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/invoiceModels.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/models/Invoice.js backend/models/ReconSend.js backend/tests/invoiceModels.test.js
git commit -m "feat: Invoice and ReconSend models with per-period idempotency indexes"
```

---

### Task 2: Affiliate contact fields (backend)

**Files:**
- Modify: `backend/models/Affiliate.js` (add 2 fields after `lead_source`)
- Modify: `backend/routes/affiliateRoutes.js:17` (create) and `:33` (patch allowed list)
- Test: extend `backend/tests/affiliates.test.js`

**Interfaces:**
- Produces: `Affiliate.contact_name`, `Affiliate.contact_email` — used by affiliateRecon (Task 6) and frontend (Task 11).

- [ ] **Step 1: Write the failing test** — append to `backend/tests/affiliates.test.js`:

```js
test('contact fields settable on create and patch', async () => {
  const app = createApp();
  const token = await adminToken();
  const created = await request(app).post('/api/v1/affiliates').set('Authorization', `Bearer ${token}`)
    .send({ name: 'C3K', lead_source: 'claim3000', contact_name: 'Ali', contact_email: 'ali@claim3000.co.uk' });
  assert.strictEqual(created.body.affiliate.contact_email, 'ali@claim3000.co.uk');
  const patched = await request(app).patch(`/api/v1/affiliates/${created.body.affiliate._id}`)
    .set('Authorization', `Bearer ${token}`).send({ contact_name: 'Ali B' });
  assert.strictEqual(patched.body.contact_name, 'Ali B');
  assert.strictEqual(patched.body.contact_email, 'ali@claim3000.co.uk');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/affiliates.test.js`
Expected: the new test FAILS (`contact_email` undefined); existing tests PASS.

- [ ] **Step 3: Implement**

In `backend/models/Affiliate.js`, after the `lead_source` line add:

```js
    contact_name: { type: String, trim: true },
    contact_email: { type: String, trim: true, lowercase: true },
```

In `backend/routes/affiliateRoutes.js`:
- line 17: `const { name, lead_source, brands, rate_card, contact_name, contact_email } = req.body || {};` and pass both into the `Affiliate.create({...})` call in that handler.
- line 33: change to `for (const f of ['name', 'brands', 'active', 'contact_name', 'contact_email']) {`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/affiliates.test.js` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/models/Affiliate.js backend/routes/affiliateRoutes.js backend/tests/affiliates.test.js
git commit -m "feat: affiliate contact_name/contact_email for reconciliation emails"
```

---

### Task 3: invoiceService — London bounds, billable query, lines, generate

**Files:**
- Create: `backend/services/invoiceService.js`
- Test: `backend/tests/invoiceService.test.js`

**Interfaces:**
- Consumes: `Invoice` (Task 1), existing `Counter`, `Lead`.
- Produces (all exported):
  - `round2(n) -> number`, `money(n) -> "140.00"` (string, 2 dp, no separators), `gbp(n) -> "£1,400.00"` (en-GB separators)
  - `londonDay(date) -> "YYYY-MM-DD"`, `periodBounds(dayStr) -> { start: Date, end: Date }` (UTC instants of London midnights; end exclusive)
  - `billableFilter(bounds) -> mongo filter object`
  - `bluelionRates() -> { virgin, searched }`
  - `buildLines({virgin, searched}, rates) -> { lines: [{description, qty, rate, amount}], net, vat, gross }` (always both lines, even qty 0)
  - `previewDailyInvoice(now) -> { day, counts, calc, leads }` (no DB writes; leads populated with affiliate name)
  - `generateDailyInvoice(now) -> { invoice, created, leads }` (idempotent: returns existing invoice with `created:false, leads:null`; returns `{invoice:null}` on zero leads)
  - `LINE_VIRGIN`, `LINE_SEARCHED`, `PAY_LABELS` (map payable_status -> human label)
  - `STORAGE_DIR` (absolute path `backend/storage/invoices`), `ensureStorage()`

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/invoiceService.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const svc = require('../services/invoiceService');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

// 09:00 London on 19 Jul 2026 (BST) = 08:00Z
const NOW = new Date('2026-07-19T08:00:00Z');

async function seed(overrides = {}) {
  const aff = overrides.affiliate || await Affiliate.create({ name: 'Acme', lead_source: `a${Math.random().toString(36).slice(2, 8)}` });
  return Lead.create({
    ref: overrides.ref || `KB-${Math.random().toString(36).slice(2, 10)}`,
    affiliate_id: aff._id,
    submitted_at: overrides.submitted_at || new Date('2026-07-18T10:00:00Z'),
    initial_status: overrides.initial_status || 'accepted',
    search_status: overrides.search_status || 'virgin',
    signature_status: overrides.signature_status || 'passed',
    cancelled: overrides.cancelled || false,
    replaced_by_lead: overrides.replaced_by_lead || null,
  });
}

test('periodBounds handles BST: London midnight is 23:00Z previous day', () => {
  const b = svc.periodBounds('2026-07-18');
  assert.strictEqual(b.start.toISOString(), '2026-07-17T23:00:00.000Z');
  assert.strictEqual(b.end.toISOString(), '2026-07-18T23:00:00.000Z');
});

test('periodBounds handles GMT: London midnight equals UTC midnight', () => {
  const b = svc.periodBounds('2026-01-15');
  assert.strictEqual(b.start.toISOString(), '2026-01-15T00:00:00.000Z');
});

test('buildLines always emits both lines and computes VAT to 2dp', () => {
  const r = svc.buildLines({ virgin: 12, searched: 2 }, { virgin: 110, searched: 30 });
  assert.deepStrictEqual(r.lines.map((l) => l.amount), [1320, 60]);
  assert.strictEqual(r.net, 1380);
  assert.strictEqual(r.vat, 276);
  assert.strictEqual(r.gross, 1656);
  const zero = svc.buildLines({ virgin: 3, searched: 0 }, { virgin: 110, searched: 30 });
  assert.strictEqual(zero.lines.length, 2);
  assert.strictEqual(zero.lines[1].qty, 0);
});

test('billable rules: excludes pending, cancelled, sig-failed, replaced, unknown', async () => {
  await seed({ search_status: 'virgin' });                                  // billable
  await seed({ search_status: 'searched' });                                // billable
  await seed({ initial_status: 'pending' });
  await seed({ initial_status: 'rejected' });
  await seed({ cancelled: true });
  await seed({ signature_status: 'failed' });
  await seed({ search_status: 'unknown' });
  const other = await seed({ search_status: 'virgin' });
  await Lead.updateOne({ _id: other._id }, { replaced_by_lead: other._id }); // replaced
  await seed({ submitted_at: new Date('2026-07-17T22:00:00Z') });            // 17 Jul London (23:00 London bound)
  const p = await svc.previewDailyInvoice(NOW);
  assert.strictEqual(p.day, '2026-07-18');
  assert.deepStrictEqual(p.counts, { virgin: 1, searched: 1 });
  assert.strictEqual(p.calc.net, 140);
  assert.strictEqual(p.calc.vat, 28);
  assert.strictEqual(p.calc.gross, 168);
});

test('lead submitted 23:30 London lands on that London day (BST edge)', async () => {
  await seed({ submitted_at: new Date('2026-07-18T22:30:00Z') }); // 23:30 London 18 Jul
  const p = await svc.previewDailyInvoice(NOW);
  assert.strictEqual(p.counts.virgin, 1);
});

test('generateDailyInvoice numbers sequentially, idempotent, zero-day null', async () => {
  const empty = await svc.generateDailyInvoice(NOW);
  assert.strictEqual(empty.invoice, null);
  await seed({});
  const first = await svc.generateDailyInvoice(NOW);
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.invoice.number, 'BlueLion 001');
  assert.strictEqual(first.invoice.period_end, '2026-07-18');
  assert.strictEqual(first.leads.length, 1);
  const again = await svc.generateDailyInvoice(NOW);
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.invoice._id.toString(), first.invoice._id.toString());
  assert.strictEqual(await Invoice.countDocuments(), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/invoiceService.test.js`
Expected: FAIL — `Cannot find module '../services/invoiceService'`

- [ ] **Step 3: Implement**

```js
// backend/services/invoiceService.js
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

async function previewDailyInvoice(now = new Date()) {
  const day = londonDay(new Date(now.getTime() - 24 * 3600 * 1000));
  const leads = await Lead.find(billableFilter(periodBounds(day)))
    .sort({ submitted_at: 1 }).populate('affiliate_id', 'name rate_card').lean();
  const counts = {
    virgin: leads.filter((l) => l.search_status === 'virgin').length,
    searched: leads.filter((l) => l.search_status === 'searched').length,
  };
  return { day, counts, calc: buildLines(counts, bluelionRates()), leads };
}

async function nextInvoiceNumber() {
  const c = await Counter.findByIdAndUpdate('invoice_bluelion', { $inc: { seq: 1 } }, { new: true, upsert: true });
  return { seq: c.seq, number: `BlueLion ${String(c.seq).padStart(3, '0')}` };
}

async function generateDailyInvoice(now = new Date()) {
  const day = londonDay(new Date(now.getTime() - 24 * 3600 * 1000));
  const existing = await Invoice.findOne({ type: 'daily', period_end: day });
  if (existing) return { invoice: existing, created: false, leads: null };
  const { counts, calc, leads } = await previewDailyInvoice(now);
  if (!leads.length) return { invoice: null, created: false, leads: [] };
  const { seq, number } = await nextInvoiceNumber();
  const invoice = await Invoice.create({
    number, seq, type: 'daily', period_start: day, period_end: day, invoice_date: now,
    lines: calc.lines, net: calc.net, vat: calc.vat, gross: calc.gross,
    email_to: process.env.INVOICE_TO_EMAIL || '',
  });
  return { invoice, created: true, leads };
}

const STORAGE_DIR = path.join(__dirname, '..', 'storage', 'invoices');
const ensureStorage = () => fs.mkdirSync(STORAGE_DIR, { recursive: true });

module.exports = {
  LINE_VIRGIN, LINE_SEARCHED, PAY_LABELS, VAT_RATE,
  round2, money, gbp, londonDay, ddmmyyyy, periodBounds, billableFilter,
  bluelionRates, buildLines, previewDailyInvoice, generateDailyInvoice,
  nextInvoiceNumber, STORAGE_DIR, ensureStorage,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/invoiceService.test.js` — Expected: PASS (6 tests). Also run the full suite: `npm test` — no regressions.

- [ ] **Step 5: Commit**

```bash
git add backend/services/invoiceService.js backend/tests/invoiceService.test.js
git commit -m "feat: invoice service — London-day billing rules, VAT calc, atomic numbering"
```

---

### Task 4: PDF rendering (pdf-lib overlay on approved template)

**Files:**
- Create: `backend/services/invoicePdf.js`
- Create: `backend/scripts/renderSampleInvoice.js`
- Modify: `backend/package.json` (add `pdf-lib`)
- Test: `backend/tests/invoicePdf.test.js`
- Template (already committed): `backend/assets/invoice-template-bluelion.pdf`

**Interfaces:**
- Consumes: invoice-shaped object `{ number, invoice_date, lines: [v, s], net, vat, gross }` (Task 3 shapes).
- Produces: `renderInvoicePdf(invoice) -> Promise<Buffer>`.

- [ ] **Step 1: Install pdf-lib**

Run: `cd ~/Desktop/pcp-affiliate-dashboard/backend && npm install pdf-lib`
Expected: added to dependencies, no vulnerabilities blocking.

- [ ] **Step 2: Write the failing test**

```js
// backend/tests/invoicePdf.test.js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/invoicePdf.test.js`
Expected: FAIL — `Cannot find module '../services/invoicePdf'`

- [ ] **Step 4: Implement**

```js
// backend/services/invoicePdf.js
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { money, gbp, ddmmyyyy } = require('./invoiceService');

const TEMPLATE = path.join(__dirname, '..', 'assets', 'invoice-template-bluelion.pdf');

// Stamp coordinates in PDF points (origin bottom-left), calibrated against the
// client-approved template via scripts/renderSampleInvoice.js. If the template
// is ever regenerated, re-run that script and adjust here.
const C = {
  size: 9,
  header: { value_x: 470, wipe_w: 110, invoice_y: 626, date_y: 613, due_y: 588 },
  cols: { qty_r: 490, rate_r: 537, amount_r: 575 }, // right edges
  rows: { line1_y: 527, line2_y: 498 },
  totals: { label_wipe_x: 500, subtotal_y: 456, vat_y: 437, total_y: 418 },
  balance: { y: 386, size: 12 },
  vatSummary: { y: 335, vat_r: 400, net_r: 575 },
};

async function renderInvoicePdf(invoice) {
  const pdf = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  const page = pdf.getPage(0);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

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
```

```js
// backend/scripts/renderSampleInvoice.js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/invoicePdf.test.js` — Expected: PASS.

- [ ] **Step 6: CALIBRATE (mandatory, visual)**

Run: `node scripts/renderSampleInvoice.js`, then open `backend/storage/samples/sample-invoice.pdf` (Read tool renders PDFs). Compare against `backend/assets/invoice-template-bluelion.pdf`:
- old values fully covered (no "BlueLion 001"/"18/07/2026"/old numbers peeking out)
- new values aligned with their labels/columns (right-aligned numerics)
Adjust the `C` constants and re-run until aligned. Typical fix is ±3–6 pt per group.

- [ ] **Step 7: Commit**

```bash
git add backend/services/invoicePdf.js backend/scripts/renderSampleInvoice.js backend/tests/invoicePdf.test.js backend/package.json backend/package-lock.json
git commit -m "feat: invoice PDF renderer stamping values onto approved BlueLion template"
```

---

### Task 5: Excel workbooks (BlueLion + affiliate)

**Files:**
- Create: `backend/services/reconExcel.js`
- Test: `backend/tests/reconExcel.test.js`

**Interfaces:**
- Consumes: lead docs populated with `affiliate_id.name` (+ `rate_card` for affiliate workbook); `PAY_LABELS`, `LINE_VIRGIN`, `LINE_SEARCHED`, `bluelionRates`, `ddmmyyyy` from invoiceService.
- Produces:
  - `buildBlueLionWorkbook(leads) -> Promise<Buffer>` — tabs `Leads`, `Affiliate Summary`
  - `buildAffiliateWorkbook({ affiliate, dayLeads, openReplacements, suppliedReplacements, confirmedLeads }) -> Promise<Buffer>` — tabs `Payable Leads`, `Replacements Required`, `Replacements Supplied`, `Confirmed After Lender Check`

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/reconExcel.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { buildBlueLionWorkbook, buildAffiliateWorkbook } = require('../services/reconExcel');

const lead = (over = {}) => ({
  ref: 'KB-2026-000001', submitted_at: new Date('2026-07-18T10:00:00Z'),
  affiliate_id: { name: 'Claim3000', rate_card: { virgin_rate: 40, searched_upfront_rate: 15 } },
  search_status: 'virgin', payable_status: 'payable', ...over,
});

async function load(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

test('bluelion workbook: lead rows, category, affiliate summary with totals', async () => {
  const buf = await buildBlueLionWorkbook([
    lead(), lead({ ref: 'KB-2026-000002', search_status: 'searched', payable_status: 'partial_pending_confirmation' }),
    lead({ ref: 'KB-2026-000003', affiliate_id: { name: 'Acme' } }),
  ]);
  const wb = await load(buf);
  const leads = wb.getWorksheet('Leads');
  assert.strictEqual(leads.rowCount, 4); // header + 3
  assert.strictEqual(leads.getRow(2).getCell(6).value, 'PCP Claim Accepted Not Searched');
  assert.strictEqual(leads.getRow(3).getCell(7).value, 30); // searched at BlueLion rate
  const summary = wb.getWorksheet('Affiliate Summary');
  const rows = [];
  summary.eachRow((r) => rows.push(r.values.slice(1)));
  assert.deepStrictEqual(rows[0], ['Affiliate', 'Non Search', 'Previous Search', 'Total']);
  assert.ok(rows.some((r) => r[0] === 'Claim3000' && r[1] === 1 && r[2] === 1 && r[3] === 2));
  assert.deepStrictEqual(rows.at(-1), ['TOTAL', 2, 1, 3]);
});

test('affiliate workbook: four tabs, affiliate rates, 72h deadline', async () => {
  const requested = new Date('2026-07-18T09:00:00Z');
  const buf = await buildAffiliateWorkbook({
    affiliate: { name: 'Claim3000', rate_card: { virgin_rate: 40, searched_upfront_rate: 15 } },
    dayLeads: [lead(), lead({ ref: 'KB-2026-000002', search_status: 'searched' })],
    openReplacements: [lead({ ref: 'KB-2026-000009', replacement_reason: 'cooling_off', replacement_requested_at: requested })],
    suppliedReplacements: [lead({ ref: 'KB-2026-000010', replaced_by_lead: { ref: 'KB-2026-000011' } })],
    confirmedLeads: [lead({ ref: 'KB-2026-000012', payable_status: 'payable_full' })],
  });
  const wb = await load(buf);
  for (const name of ['Payable Leads', 'Replacements Required', 'Replacements Supplied', 'Confirmed After Lender Check']) {
    assert.ok(wb.getWorksheet(name), `missing tab ${name}`);
  }
  const pay = wb.getWorksheet('Payable Leads');
  assert.strictEqual(pay.getRow(2).getCell(6).value, 40);  // virgin at affiliate rate
  assert.strictEqual(pay.getRow(3).getCell(6).value, 15);  // searched at affiliate rate
  const req = wb.getWorksheet('Replacements Required');
  assert.strictEqual(req.getRow(2).getCell(2).value, 'cooling_off');
  assert.strictEqual(req.getRow(2).getCell(4).value, new Date('2026-07-21T09:00:00Z').toISOString());
  const sup = wb.getWorksheet('Replacements Supplied');
  assert.strictEqual(sup.getRow(2).getCell(2).value, 'KB-2026-000011');
});

test('formula injection neutralised in text cells', async () => {
  const buf = await buildBlueLionWorkbook([lead({ ref: '=HYPERLINK("http://x")', affiliate_id: { name: '+SUM(A1)' } })]);
  const wb = await load(buf);
  const row = wb.getWorksheet('Leads').getRow(2);
  assert.ok(String(row.getCell(1).value).startsWith("'="));
  assert.ok(String(row.getCell(3).value).startsWith("'+"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/reconExcel.test.js`
Expected: FAIL — `Cannot find module '../services/reconExcel'`

- [ ] **Step 3: Implement**

```js
// backend/services/reconExcel.js
const ExcelJS = require('exceljs');
const { PAY_LABELS, LINE_VIRGIN, LINE_SEARCHED, bluelionRates } = require('./invoiceService');

// same guard as exportRoutes: neutralise spreadsheet formula prefixes
const safe = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};
const iso = (d) => (d ? new Date(d).toISOString() : '');
const category = (l) => (l.search_status === 'virgin' ? LINE_VIRGIN : LINE_SEARCHED);

function sheet(wb, name, columns) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map((c) => ({ header: c[0], key: c[0], width: c[1] }));
  ws.getRow(1).font = { bold: true };
  return ws;
}

async function buildBlueLionWorkbook(leads) {
  const rates = bluelionRates();
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'Leads', [
    ['Lead Reference', 20], ['Submission Date', 22], ['Affiliate', 18], ['Search Status', 14],
    ['Payment Status', 28], ['Invoice Category', 34], ['Invoice Value', 13],
  ]);
  const byAff = new Map();
  for (const l of leads) {
    const name = l.affiliate_id?.name || 'unknown';
    ws.addRow([safe(l.ref), iso(l.submitted_at), safe(name), l.search_status,
      PAY_LABELS[l.payable_status] || l.payable_status, category(l),
      l.search_status === 'virgin' ? rates.virgin : rates.searched]);
    const a = byAff.get(name) || { virgin: 0, searched: 0 };
    a[l.search_status] += 1;
    byAff.set(name, a);
  }
  const sum = sheet(wb, 'Affiliate Summary', [['Affiliate', 24], ['Non Search', 12], ['Previous Search', 15], ['Total', 10]]);
  let tv = 0, ts = 0;
  for (const [name, a] of [...byAff.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    sum.addRow([safe(name), a.virgin, a.searched, a.virgin + a.searched]);
    tv += a.virgin; ts += a.searched;
  }
  const totalRow = sum.addRow(['TOTAL', tv, ts, tv + ts]);
  totalRow.font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const H72 = 72 * 3600 * 1000;

async function buildAffiliateWorkbook({ affiliate, dayLeads, openReplacements, suppliedReplacements, confirmedLeads }) {
  const rc = affiliate.rate_card || {};
  const wb = new ExcelJS.Workbook();

  const pay = sheet(wb, 'Payable Leads', [
    ['Lead Reference', 20], ['Submission Date', 22], ['Search Status', 14],
    ['Payment Status', 28], ['Invoice Category', 34], ['Value', 10],
  ]);
  for (const l of dayLeads) {
    pay.addRow([safe(l.ref), iso(l.submitted_at), l.search_status,
      PAY_LABELS[l.payable_status] || l.payable_status, category(l),
      l.search_status === 'virgin' ? rc.virgin_rate || 0 : rc.searched_upfront_rate || 0]);
  }

  const req = sheet(wb, 'Replacements Required', [
    ['Lead Reference', 20], ['Reason', 14], ['Requested At', 22], ['Replace By (72h)', 22],
  ]);
  for (const l of openReplacements) {
    req.addRow([safe(l.ref), l.replacement_reason || 'signature', iso(l.replacement_requested_at),
      l.replacement_requested_at ? new Date(new Date(l.replacement_requested_at).getTime() + H72).toISOString() : '']);
  }

  const sup = sheet(wb, 'Replacements Supplied', [
    ['Original Lead', 20], ['Replacement Lead', 20], ['Reason', 14], ['Requested At', 22],
  ]);
  for (const l of suppliedReplacements) {
    sup.addRow([safe(l.ref), safe(l.replaced_by_lead?.ref || ''), l.replacement_reason || 'signature', iso(l.replacement_requested_at)]);
  }

  const conf = sheet(wb, 'Confirmed After Lender Check', [
    ['Lead Reference', 20], ['Submission Date', 22], ['Payment Status', 28],
  ]);
  for (const l of confirmedLeads) {
    conf.addRow([safe(l.ref), iso(l.submitted_at), PAY_LABELS[l.payable_status] || l.payable_status]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildBlueLionWorkbook, buildAffiliateWorkbook };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/reconExcel.test.js` — Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/reconExcel.js backend/tests/reconExcel.test.js
git commit -m "feat: BlueLion and affiliate Excel reconciliation workbooks"
```

---

### Task 6: Affiliate reconciliation builder

**Files:**
- Create: `backend/services/affiliateRecon.js`
- Test: `backend/tests/affiliateRecon.test.js`

**Interfaces:**
- Consumes: `billableFilter`, `periodBounds`, `londonDay`, `ddmmyyyy`, `round2`, `money`, `VAT_RATE` (Task 3); `buildAffiliateWorkbook` (Task 5); `Affiliate`, `Lead`, `ReconSend` models.
- Produces: `buildAffiliateRecons(now) -> Promise<Array<{ affiliate_id, name, to, day, subject, text, html, xlsx }>>` — one entry per affiliate that (a) has billable leads yesterday OR a replacement obligation opened yesterday, (b) has `contact_email`, and (c) has no `ReconSend` row for that day yet. Affiliates matching (a) but missing contact_email are logged with `console.warn` and skipped.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/affiliateRecon.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const ReconSend = require('../models/ReconSend');
const { buildAffiliateRecons } = require('../services/affiliateRecon');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

const NOW = new Date('2026-07-19T08:00:00Z'); // 09:00 London, reporting day 2026-07-18

async function mkAff(name, email) {
  return Affiliate.create({
    name, lead_source: name.toLowerCase(), contact_name: 'Ali', contact_email: email,
    rate_card: { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 },
  });
}
const mkLead = (aff, over = {}) => Lead.create({
  ref: `KB-${Math.random().toString(36).slice(2, 10)}`, affiliate_id: aff._id,
  submitted_at: new Date('2026-07-18T10:00:00Z'), initial_status: 'accepted',
  search_status: 'virgin', signature_status: 'passed', ...over,
});

test('builds recon with affiliate rates and VAT; skips no-activity and no-email affiliates', async () => {
  const a = await mkAff('Claim3000', 'ali@claim3000.co.uk');
  await mkLead(a);
  await mkLead(a, { search_status: 'searched' });
  const idle = await mkAff('Idle', 'idle@x.com');       // no leads — no email
  const noEmail = await mkAff('NoMail', undefined);      // leads but no address — skipped
  await mkLead(noEmail);
  const recons = await buildAffiliateRecons(NOW);
  assert.strictEqual(recons.length, 1);
  const r = recons[0];
  assert.strictEqual(r.to, 'ali@claim3000.co.uk');
  assert.strictEqual(r.day, '2026-07-18');
  assert.match(r.subject, /Daily Lead Reconciliation – Claim3000 – 18\/07\/2026/);
  assert.match(r.text, /Fully Payable Leads: 1/);
  assert.match(r.text, /Part-Payable Leads: 1/);
  assert.match(r.text, /Net Amount: £55\.00/);       // 40 + 15
  assert.match(r.text, /VAT at 20%: £11\.00/);
  assert.match(r.text, /Total Including VAT: £66\.00/);
  assert.ok(Buffer.isBuffer(r.xlsx));
});

test('replacement obligation opened yesterday triggers email even with no leads', async () => {
  const a = await mkAff('Claim3000', 'ali@claim3000.co.uk');
  await mkLead(a, {
    submitted_at: new Date('2026-07-10T10:00:00Z'), signature_status: 'failed',
    replacement_status: 'required', replacement_reason: 'signature',
    replacement_requested_at: new Date('2026-07-18T11:00:00Z'),
  });
  const recons = await buildAffiliateRecons(NOW);
  assert.strictEqual(recons.length, 1);
  assert.match(recons[0].text, /Fully Payable Leads: 0/);
});

test('already-sent day (ReconSend row) is not rebuilt', async () => {
  const a = await mkAff('Claim3000', 'ali@claim3000.co.uk');
  await mkLead(a);
  await ReconSend.create({ affiliate_id: a._id, day: '2026-07-18', sent_at: new Date() });
  assert.strictEqual((await buildAffiliateRecons(NOW)).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/affiliateRecon.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// backend/services/affiliateRecon.js
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const ReconSend = require('../models/ReconSend');
const { billableFilter, periodBounds, londonDay, round2, money, VAT_RATE } = require('./invoiceService');
const { buildAffiliateWorkbook } = require('./reconExcel');

const ddmmyyyyFromDay = (day) => day.split('-').reverse().join('/');

function reconEmail({ affiliate, day, counts, amounts }) {
  const dateStr = ddmmyyyyFromDay(day);
  const net = round2(amounts.full + amounts.part);
  const vat = round2(net * VAT_RATE);
  const gross = round2(net + vat);
  const subject = `Daily Lead Reconciliation – ${affiliate.name} – ${dateStr}`;
  const text = `Hi ${affiliate.contact_name || affiliate.name},

Please find below your daily lead reconciliation for leads processed on ${dateStr}.
It confirms the figures currently recorded in our system so that you can prepare and submit your invoice to Kickbyte Media Ltd.

KICKBYTE MEDIA LTD
71-75 Shelton Street, Covent Garden, London, United Kingdom, WC2H 9JQ
VAT Registration No.: 511270734
Company Registration No. 16487857

Lead Summary
- Fully Payable Leads: ${counts.full} × £${money(amounts.fullRate)} = £${money(amounts.full)}
- Part-Payable Leads: ${counts.part} × £${money(amounts.partRate)} = £${money(amounts.part)}

Total Accepted Leads: ${counts.full + counts.part}
Net Amount: £${money(net)}
VAT at 20%: £${money(vat)}
Total Including VAT: £${money(gross)}

Please use the above figures when preparing your invoice to Kickbyte Media Ltd.
A detailed breakdown is included in the attached Excel reconciliation workbook, including:

- All payable leads included in the figures above.
- Any signature replacements currently required.
- Any replacements required because a client cancelled within the 14-day cooling-off period.
- Any replacements already supplied and matched to the original lead.
- Any leads that become fully payable after lender check.

Signature replacements must be supplied within 72 hours of notification.

If you believe any of the figures or replacement requirements are incorrect, please contact us before submitting your invoice.

Kind regards,
Kickbyte Media Ltd (Trading as Click2Leads)
`;
  const html = text
    .split('\n\n')
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return { subject, text, html };
}

async function buildAffiliateRecons(now = new Date()) {
  const day = londonDay(new Date(now.getTime() - 24 * 3600 * 1000));
  const bounds = periodBounds(day);
  const affiliates = await Affiliate.find({ active: true }).lean();
  const out = [];

  for (const a of affiliates) {
    if (await ReconSend.findOne({ affiliate_id: a._id, day })) continue;

    const dayLeads = await Lead.find({ ...billableFilter(bounds), affiliate_id: a._id })
      .sort({ submitted_at: 1 }).lean();
    const newObligations = await Lead.countDocuments({
      affiliate_id: a._id, replacement_status: 'required',
      replacement_requested_at: { $gte: bounds.start, $lt: bounds.end },
    });
    if (!dayLeads.length && !newObligations) continue;
    if (!a.contact_email) {
      console.warn(`recon: affiliate ${a.name} has activity but no contact_email — skipped`);
      continue;
    }

    const openReplacements = await Lead.find({ affiliate_id: a._id, replacement_status: 'required' })
      .sort({ replacement_requested_at: 1 }).lean();
    const suppliedReplacements = await Lead.find({
      affiliate_id: a._id, replacement_status: { $in: ['supplied', 'closed'] },
      replacement_requested_at: { $gte: new Date(now.getTime() - 30 * 24 * 3600 * 1000) },
    }).populate('replaced_by_lead', 'ref').lean();
    const confirmedLeads = await Lead.find({
      affiliate_id: a._id, payable_status: 'payable_full',
      last_updated: { $gte: bounds.start, $lt: bounds.end },
    }).lean();

    const rc = a.rate_card || {};
    const counts = {
      full: dayLeads.filter((l) => l.search_status === 'virgin').length,
      part: dayLeads.filter((l) => l.search_status === 'searched').length,
    };
    const amounts = {
      fullRate: rc.virgin_rate || 0, partRate: rc.searched_upfront_rate || 0,
      full: round2(counts.full * (rc.virgin_rate || 0)),
      part: round2(counts.part * (rc.searched_upfront_rate || 0)),
    };
    const { subject, text, html } = reconEmail({ affiliate: a, day, counts, amounts });
    const xlsx = await buildAffiliateWorkbook({
      affiliate: a, dayLeads, openReplacements, suppliedReplacements, confirmedLeads,
    });
    out.push({ affiliate_id: a._id, name: a.name, to: a.contact_email, day, subject, text, html, xlsx });
  }
  return out;
}

module.exports = { buildAffiliateRecons };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/affiliateRecon.test.js` — Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/affiliateRecon.js backend/tests/affiliateRecon.test.js
git commit -m "feat: per-affiliate daily reconciliation email builder with idempotent send log"
```

---

### Task 7: Mailer + daily runner (orchestration)

**Files:**
- Create: `backend/services/mailer.js`
- Create: `backend/services/invoiceRunner.js`
- Test: `backend/tests/invoiceRunner.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `mailer.sendAccountsMail({ to, cc, subject, text, html, attachments }) -> Promise` (throws if `ACCOUNTS_SMTP_USER/PASS` unset); `mailer.accountsConfigured() -> boolean`
  - `invoiceRunner.runDaily(now, { send } = {}) -> Promise<summary>` where `send` defaults to `sendAccountsMail` (injectable for tests/dry-run). Summary: `{ day, invoice: {number, net, vat, gross, email_status} | null, retried: number, recons_sent: number, recons_failed: number }`.
  - Behaviour: (1) retry invoices with `email_status != 'sent'` using stored artifact files; (2) generate today's invoice if absent and leads exist — write `BlueLion-<seq3>.pdf`/`.xlsx` into `STORAGE_DIR`, store filenames, email with both attachments, mark `sent`/`failed` (+`email_error`); (3) send affiliate recons, create `ReconSend` row only on successful send. BlueLion recipient: `INVOICE_TO_EMAIL`, else fallback `INVOICE_CC`, else `DIGEST_TO`; `INVOICE_CC` added as cc when it isn't the recipient. A send failure never throws out of `runDaily` — it's recorded and counted.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/invoiceRunner.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const ReconSend = require('../models/ReconSend');
const { runDaily } = require('../services/invoiceRunner');
const { STORAGE_DIR } = require('../services/invoiceService');

before(setupDB);
after(teardownDB);
beforeEach(async () => {
  await clearDB();
  process.env.INVOICE_TO_EMAIL = 'accounts@bluelion.test';
  process.env.INVOICE_CC = 'anthony@click2leads.co.uk';
});

const NOW = new Date('2026-07-19T08:00:00Z');

async function seedDay() {
  const aff = await Affiliate.create({
    name: 'Claim3000', lead_source: 'claim3000', contact_email: 'ali@claim3000.co.uk',
    rate_card: { virgin_rate: 40, searched_upfront_rate: 15 },
  });
  await Lead.create({
    ref: 'KB-2026-000201', affiliate_id: aff._id, submitted_at: new Date('2026-07-18T10:00:00Z'),
    initial_status: 'accepted', search_status: 'virgin', signature_status: 'passed',
  });
  return aff;
}

test('full run: invoice emailed with 2 attachments, artifacts on disk, recon sent+logged', async () => {
  await seedDay();
  const sent = [];
  const summary = await runDaily(NOW, { send: async (m) => { sent.push(m); } });
  assert.strictEqual(summary.invoice.number, 'BlueLion 001');
  assert.strictEqual(summary.invoice.email_status, 'sent');
  assert.strictEqual(summary.recons_sent, 1);
  const invMail = sent.find((m) => m.to === 'accounts@bluelion.test');
  assert.strictEqual(invMail.cc, 'anthony@click2leads.co.uk');
  assert.match(invMail.subject, /Invoice BlueLion 001/);
  assert.match(invMail.text, /18\/07\/2026 00:00 – 18\/07\/2026 23:59/);
  assert.match(invMail.text, /Net Total: £110\.00/);
  assert.deepStrictEqual(invMail.attachments.map((a) => a.filename), ['Invoice BlueLion 001.pdf', 'Reconciliation BlueLion 001.xlsx']);
  const inv = await Invoice.findOne({ number: 'BlueLion 001' });
  assert.ok(fs.existsSync(path.join(STORAGE_DIR, inv.pdf_file)));
  assert.ok(fs.existsSync(path.join(STORAGE_DIR, inv.xlsx_file)));
  assert.strictEqual(await ReconSend.countDocuments(), 1);
});

test('send failure marks invoice failed, next run retries without regenerating', async () => {
  await seedDay();
  const s1 = await runDaily(NOW, { send: async () => { throw new Error('smtp down'); } });
  assert.strictEqual(s1.invoice.email_status, 'failed');
  assert.strictEqual(s1.recons_sent, 0);
  assert.strictEqual(await Invoice.countDocuments(), 1);
  const sent = [];
  const s2 = await runDaily(NOW, { send: async (m) => { sent.push(m); } });
  assert.strictEqual(s2.retried, 1);
  assert.strictEqual(await Invoice.countDocuments(), 1); // no duplicate
  assert.strictEqual((await Invoice.findOne()).email_status, 'sent');
  assert.strictEqual(s2.recons_sent, 1); // recon also recovered
});

test('zero-lead day: no invoice, no recons, no crash', async () => {
  const sent = [];
  const summary = await runDaily(NOW, { send: async (m) => { sent.push(m); } });
  assert.strictEqual(summary.invoice, null);
  assert.strictEqual(sent.length, 0);
});

test('second same-day run is a no-op', async () => {
  await seedDay();
  await runDaily(NOW, { send: async () => {} });
  const sent = [];
  await runDaily(NOW, { send: async (m) => { sent.push(m); } });
  assert.strictEqual(sent.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/invoiceRunner.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// backend/services/mailer.js
const nodemailer = require('nodemailer');

const accountsConfigured = () => !!(process.env.ACCOUNTS_SMTP_USER && process.env.ACCOUNTS_SMTP_PASS);

function accountsTransport() {
  const port = Number(process.env.ACCOUNTS_SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host: process.env.ACCOUNTS_SMTP_HOST || 'smtpout.secureserver.net',
    port,
    secure: port === 465,
    auth: { user: process.env.ACCOUNTS_SMTP_USER, pass: process.env.ACCOUNTS_SMTP_PASS },
  });
}

async function sendAccountsMail(msg) {
  if (!accountsConfigured()) throw new Error('accounts SMTP not configured (ACCOUNTS_SMTP_USER/PASS)');
  return accountsTransport().sendMail({
    from: `"Kickbyte Media Ltd (Click2Leads)" <${process.env.ACCOUNTS_SMTP_USER}>`,
    ...msg,
  });
}

module.exports = { sendAccountsMail, accountsConfigured };
```

```js
// backend/services/invoiceRunner.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/invoiceRunner.test.js` — Expected: PASS (4 tests). Full suite `npm test` — no regressions.

- [ ] **Step 5: Commit**

```bash
git add backend/services/mailer.js backend/services/invoiceRunner.js backend/tests/invoiceRunner.test.js
git commit -m "feat: daily invoice runner — generate, persist artifacts, email, retry, recons"
```

---

### Task 8: Cron script + gitignore

**Files:**
- Create: `backend/scripts/sendInvoices.js`
- Modify: `.gitignore` (repo root — check it exists; add `backend/storage/`)

**Interfaces:**
- Consumes: `runDaily` (Task 7), `previewDailyInvoice`/`renderInvoicePdf`/`buildBlueLionWorkbook` for dry-run.
- Produces: CLI. Flags: `--dry-run` (render artifacts to `storage/samples/`, print email previews, send nothing, create nothing), `--force` (skip the London-hour guard for manual live runs).

- [ ] **Step 1: Write the script**

```js
// backend/scripts/sendInvoices.js
// Daily BlueLion invoice + affiliate reconciliations — run from cron.
// Server crontab runs it at 8 AND 9 UTC; the London-hour guard makes exactly
// one of them fire year-round (BST/GMT safe without CRON_TZ support):
//   0 8,9 * * * cd /var/www/pcp-affiliate-dashboard/backend && node scripts/sendInvoices.js >> /var/log/pcp-invoices.log 2>&1
// Manual live run: node scripts/sendInvoices.js --force
// Rehearsal:       node scripts/sendInvoices.js --dry-run
// Needs in .env: ACCOUNTS_SMTP_USER, ACCOUNTS_SMTP_PASS (INVOICE_TO_EMAIL for live BlueLion delivery)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { connectDB } = require('../config/db');
const { accountsConfigured } = require('../services/mailer');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const now = new Date();
  const londonHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(now));
  if (!dryRun && !force && londonHour !== 9) {
    console.log(`${now.toISOString()} not 09:00 London (hour=${londonHour}) — exiting`);
    process.exit(0);
  }
  if (!dryRun && !accountsConfigured()) {
    console.error('invoices: ACCOUNTS_SMTP_USER/PASS not configured — skipping (no invoice generated)');
    process.exit(0);
  }
  await connectDB();

  if (dryRun) {
    const { previewDailyInvoice, bluelionRates, money } = require('../services/invoiceService');
    const { renderInvoicePdf } = require('../services/invoicePdf');
    const { buildBlueLionWorkbook } = require('../services/reconExcel');
    const { buildAffiliateRecons } = require('../services/affiliateRecon');
    const p = await previewDailyInvoice(now);
    console.log(`DRY RUN — reporting day ${p.day}: virgin=${p.counts.virgin} searched=${p.counts.searched} net=£${money(p.calc.net)} vat=£${money(p.calc.vat)} gross=£${money(p.calc.gross)}`);
    if (p.leads.length) {
      const out = path.join(__dirname, '..', 'storage', 'samples');
      fs.mkdirSync(out, { recursive: true });
      const fake = { number: 'BlueLion DRY', invoice_date: now, lines: p.calc.lines, net: p.calc.net, vat: p.calc.vat, gross: p.calc.gross, period_end: p.day };
      fs.writeFileSync(path.join(out, 'dry-invoice.pdf'), await renderInvoicePdf(fake));
      fs.writeFileSync(path.join(out, 'dry-reconciliation.xlsx'), await buildBlueLionWorkbook(p.leads));
      console.log(`artifacts written to ${out}`);
    }
    for (const r of await buildAffiliateRecons(now)) {
      console.log(`--- recon → ${r.name} <${r.to}> ---\n${r.subject}\n${r.text}`);
    }
    process.exit(0);
  }

  const { runDaily } = require('../services/invoiceRunner');
  const s = await runDaily(now);
  console.log(`${now.toISOString()} invoices day=${s.day} invoice=${s.invoice ? `${s.invoice.number} £${s.invoice.gross} ${s.invoice.email_status}` : 'none'} retried=${s.retried} recons=${s.recons_sent}/${s.recons_sent + s.recons_failed}`);
  if (process.env.INVOICE_HEARTBEAT_URL && s.invoice?.email_status !== 'failed' && !s.recons_failed) {
    await fetch(process.env.INVOICE_HEARTBEAT_URL).catch(() => {});
  }
  process.exit(s.invoice?.email_status === 'failed' || s.recons_failed ? 1 : 0);
}

main().catch((e) => { console.error('invoices failed:', e); process.exit(1); });
```

- [ ] **Step 2: Add storage to gitignore**

Check repo root `.gitignore`; append line: `backend/storage/`

- [ ] **Step 3: Verify dry-run locally**

Requires a local Mongo with some leads, or accept the zero-day path: `node scripts/sendInvoices.js --dry-run` with local `MONGODB_URI`. Expected: prints `DRY RUN — reporting day ... virgin=0 searched=0` (or real counts) and exits 0. No Invoice rows created (`db.invoices.countDocuments()` unchanged).

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/sendInvoices.js .gitignore
git commit -m "feat: sendInvoices cron script with London-hour guard, dry-run and heartbeat"
```

---

### Task 9: Invoice API routes

**Files:**
- Create: `backend/routes/invoiceRoutes.js`
- Modify: `backend/server.js:20` (mount after exportRoutes)
- Test: `backend/tests/invoiceRoutes.test.js`

**Interfaces:**
- Consumes: `Invoice` model, `requireAuth`/`requireAdmin` middleware, `STORAGE_DIR`, `invoiceEmail` + `sendAccountsMail`.
- Produces (all admin-only, mounted under `/api/v1`):
  - `GET /invoices` → `[{ _id, number, type, period_end, net, vat, gross, email_status, payment_status, sent_at, email_to }]` sorted seq desc
  - `GET /invoices/:id/pdf`, `GET /invoices/:id/xlsx` → file download
  - `PATCH /invoices/:id` body `{ payment_status: 'awaiting'|'paid' }`
  - `POST /invoices/:id/resend` → re-sends stored artifacts, updates email_status

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/invoiceRoutes.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');
const Invoice = require('../models/Invoice');
const { signToken } = require('../middleware/auth');
const { STORAGE_DIR, ensureStorage } = require('../services/invoiceService');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

async function tokenFor(role) {
  const u = await User.create({ email: `${role}@x.com`, password_hash: bcrypt.hashSync('p', 10), role });
  return signToken(u);
}

const mkInvoice = (over = {}) => Invoice.create({
  number: over.number || 'BlueLion 001', seq: over.seq || 1, period_start: '2026-07-18', period_end: over.period_end || '2026-07-18',
  invoice_date: new Date(), lines: [], net: 110, vat: 22, gross: 132, email_status: 'sent', ...over,
});

test('list is admin-only and sorted newest first', async () => {
  const app = createApp();
  await mkInvoice();
  await mkInvoice({ number: 'BlueLion 002', seq: 2, period_end: '2026-07-19' });
  const forbidden = await request(app).get('/api/v1/invoices').set('Authorization', `Bearer ${await tokenFor('affiliate')}`);
  assert.strictEqual(forbidden.status, 403);
  const res = await request(app).get('/api/v1/invoices').set('Authorization', `Bearer ${await tokenFor('admin')}`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.map((i) => i.number), ['BlueLion 002', 'BlueLion 001']);
});

test('pdf download streams stored file; 404 when file missing', async () => {
  const app = createApp();
  ensureStorage();
  fs.writeFileSync(path.join(STORAGE_DIR, 'BlueLion-001.pdf'), '%PDF-test');
  const withFile = await mkInvoice({ pdf_file: 'BlueLion-001.pdf' });
  const without = await mkInvoice({ number: 'BlueLion 002', seq: 2, period_end: '2026-07-19' });
  const token = await tokenFor('admin');
  const ok = await request(app).get(`/api/v1/invoices/${withFile._id}/pdf`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(ok.status, 200);
  assert.match(ok.headers['content-disposition'], /Invoice BlueLion 001\.pdf/);
  const missing = await request(app).get(`/api/v1/invoices/${without._id}/pdf`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(missing.status, 404);
});

test('patch payment_status validates value', async () => {
  const app = createApp();
  const inv = await mkInvoice();
  const token = await tokenFor('admin');
  const ok = await request(app).patch(`/api/v1/invoices/${inv._id}`).set('Authorization', `Bearer ${token}`).send({ payment_status: 'paid' });
  assert.strictEqual(ok.body.payment_status, 'paid');
  const bad = await request(app).patch(`/api/v1/invoices/${inv._id}`).set('Authorization', `Bearer ${token}`).send({ payment_status: 'nonsense' });
  assert.strictEqual(bad.status, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/invoiceRoutes.test.js` — Expected: FAIL (404s — router not mounted).

- [ ] **Step 3: Implement**

```js
// backend/routes/invoiceRoutes.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const Invoice = require('../models/Invoice');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { STORAGE_DIR } = require('../services/invoiceService');

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
  const { invoiceEmail } = require('../services/invoiceRunner');
  const { sendAccountsMail } = require('../services/mailer');
  const { subject, text, html } = invoiceEmail(inv);
  const to = process.env.INVOICE_TO_EMAIL || process.env.INVOICE_CC || process.env.DIGEST_TO;
  try {
    await sendAccountsMail({
      to, subject, text, html,
      attachments: [
        { filename: `Invoice ${inv.number}.pdf`, path: path.join(STORAGE_DIR, path.basename(inv.pdf_file)) },
        { filename: `Reconciliation ${inv.number}.xlsx`, path: path.join(STORAGE_DIR, path.basename(inv.xlsx_file)) },
      ],
    });
    inv.email_to = to; inv.email_status = 'sent'; inv.sent_at = new Date(); inv.email_error = undefined;
  } catch (e) {
    inv.email_status = 'failed'; inv.email_error = e.message;
  }
  await inv.save();
  res.json(inv);
});

module.exports = router;
```

In `backend/server.js` after line 20 (`exportRoutes`): `app.use('/api/v1', require('./routes/invoiceRoutes'));`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/invoiceRoutes.test.js` — Expected: PASS (3 tests). Full suite: `npm test`.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/invoiceRoutes.js backend/server.js backend/tests/invoiceRoutes.test.js
git commit -m "feat: admin invoice API — list, artifact downloads, paid toggle, resend"
```

---

### Task 10: Frontend Invoices page

**Files:**
- Create: `frontend/src/pages/Invoices.jsx`
- Modify: `frontend/src/App.jsx` (import, ICONS entry, admin nav link, route)

**Interfaces:**
- Consumes: `GET /invoices`, `PATCH /invoices/:id`, `POST /invoices/:id/resend`, downloads (Task 9); `api`/`download` helpers from `frontend/src/api.js`.

- [ ] **Step 1: Write the page**

```jsx
// frontend/src/pages/Invoices.jsx
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Group, Select, Table, Title } from '@mantine/core';
import { api, download } from '../api';

const fmtGBP = (n) => `£${(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDay = (d) => (d ? d.split('-').reverse().join('/') : '');
const EMAIL_COLORS = { sent: 'green', failed: 'red', pending: 'yellow' };

export default function Invoices() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    api('/invoices').then(setRows).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function setPayment(inv, payment_status) {
    try { await api(`/invoices/${inv._id}`, { method: 'PATCH', body: { payment_status } }); load(); }
    catch (e) { setError(e.message); }
  }

  async function resend(inv) {
    if (!window.confirm(`Re-send ${inv.number} by email?`)) return;
    setBusy(inv._id);
    try { await api(`/invoices/${inv._id}/resend`, { method: 'POST' }); load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  return (
    <>
      <Group justify="space-between" mb="md"><Title order={3}>Invoices</Title></Group>
      {error && <Alert color="red" mb="md" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
      <Table striped withTableBorder highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Invoice</Table.Th><Table.Th>Period</Table.Th><Table.Th>Net</Table.Th>
            <Table.Th>VAT</Table.Th><Table.Th>Total</Table.Th><Table.Th>Email</Table.Th>
            <Table.Th>Payment</Table.Th><Table.Th></Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((i) => (
            <Table.Tr key={i._id}>
              <Table.Td>{i.number}</Table.Td>
              <Table.Td>{fmtDay(i.period_end)}</Table.Td>
              <Table.Td>{fmtGBP(i.net)}</Table.Td>
              <Table.Td>{fmtGBP(i.vat)}</Table.Td>
              <Table.Td>{fmtGBP(i.gross)}</Table.Td>
              <Table.Td>
                <Badge color={EMAIL_COLORS[i.email_status] || 'gray'} variant="light" title={i.email_error || ''}>
                  {i.email_status}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Select size="xs" w={110} data={['awaiting', 'paid']} value={i.payment_status} onChange={(v) => v && setPayment(i, v)} />
              </Table.Td>
              <Table.Td>
                <Group gap={4}>
                  <Button size="compact-xs" variant="default" onClick={() => download(`/invoices/${i._id}/pdf`, `Invoice ${i.number}.pdf`)}>PDF</Button>
                  <Button size="compact-xs" variant="default" onClick={() => download(`/invoices/${i._id}/xlsx`, `Reconciliation ${i.number}.xlsx`)}>Excel</Button>
                  <Button size="compact-xs" variant="default" loading={busy === i._id} onClick={() => resend(i)}>Resend</Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
```

- [ ] **Step 2: Wire into App.jsx**

- Import: `import Invoices from './pages/Invoices';` and add `IconFileInvoice` to the `@tabler/icons-react` import.
- `ICONS`: add `'/invoices': IconFileInvoice,`
- Admin links array (the `user.role === 'admin'` spread): append `{ to: '/invoices', label: 'Invoices' }` after Imports.
- Routes: `<Route path="/invoices" element={<RequireAuth><Invoices /></RequireAuth>} />`

- [ ] **Step 3: Verify build**

Run: `cd ~/Desktop/pcp-affiliate-dashboard/frontend && npm run build`
Expected: build succeeds. Then `npm run dev`, log in as admin, confirm Invoices nav renders the (empty) table.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Invoices.jsx frontend/src/App.jsx
git commit -m "feat: admin Invoices page — history table, downloads, paid toggle, resend"
```

---

### Task 11: Frontend affiliate contact fields

**Files:**
- Modify: `frontend/src/pages/Affiliates.jsx` (emptyForm line 8, edit-button form seed line 88, modal inputs after Name line 101)

- [ ] **Step 1: Implement**

- Line 8 `emptyForm`: add `contact_name: '', contact_email: '',` after `brands: []`.
- Edit button `setForm({...})` (line 88): add `contact_name: a.contact_name || '', contact_email: a.contact_email || '',`.
- In the create/edit modal `Stack`, after the Name `TextInput` add:

```jsx
          <TextInput label="Contact name" description="used in reconciliation email greeting" value={form.contact_name} onChange={(e) => setForm((f) => ({ ...f, contact_name: e.target.value }))} />
          <TextInput label="Contact email" description="daily reconciliation email recipient — leave empty to disable" value={form.contact_email} onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))} />
```

- [ ] **Step 2: Verify build**

Run: `cd frontend && npm run build` — Expected: success. In dev UI: edit an affiliate, set contact email, save, reopen — value persists.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Affiliates.jsx
git commit -m "feat: affiliate contact name/email fields in dashboard form"
```

---

### Task 12: Deploy & go-live checklist

**Files:**
- Modify: `deploy/DEPLOY.md` (append an "Invoicing" section documenting everything below)

- [ ] **Step 1: Document + execute on the server** (VPS details in `deploy/DEPLOY.md` / memory `project_server.md`):

1. `git pull` in `/var/www/pcp-affiliate-dashboard`, `npm install --omit=dev` in `backend/` (pulls `pdf-lib`), rebuild frontend, restart service.
2. Append to `/var/www/pcp-affiliate-dashboard/backend/.env`:
   ```
   ACCOUNTS_SMTP_HOST=smtpout.secureserver.net
   ACCOUNTS_SMTP_PORT=465
   ACCOUNTS_SMTP_USER=accounts@click2leads.co.uk
   ACCOUNTS_SMTP_PASS=<from client — GoDaddy mailbox>
   INVOICE_CC=<internal copy address, e.g. anthony@click2leads.co.uk>
   # INVOICE_TO_EMAIL=<BlueLion accounts address — client provides Monday; until set, invoices go to INVOICE_CC>
   # BLUELION_VIRGIN_RATE=110   BLUELION_SEARCHED_RATE=30  (defaults; only set to override)
   # INVOICE_HEARTBEAT_URL=<optional Uptime Kuma push URL>
   ```
3. Crontab (`crontab -e`, alongside the existing digest line):
   ```
   0 8,9 * * * cd /var/www/pcp-affiliate-dashboard/backend && node scripts/sendInvoices.js >> /var/log/pcp-invoices.log 2>&1
   ```
   (Double schedule + in-script London-hour guard = exactly one 09:00-London run in both GMT and BST.)
4. Set `contact_email` for Claim3000 → `ali@claim3000.co.uk` via the dashboard Affiliates form.
5. Rehearse: `node scripts/sendInvoices.js --dry-run` — inspect printed summary, `storage/samples/dry-invoice.pdf` (visual check against approved template), `dry-reconciliation.xlsx`, and recon email previews. Show output to client.
6. First live send (before `INVOICE_TO_EMAIL` is set) delivers to `INVOICE_CC` only — verify received email, attachments open, figures match dashboard. Then add `INVOICE_TO_EMAIL` when client supplies it.
7. Optional: create Uptime Kuma push monitor, set `INVOICE_HEARTBEAT_URL`.
8. Verify DNS: GoDaddy SPF include for click2leads.co.uk (`v=spf1 include:secureserver.net ~all`) so invoices don't land in spam; check with the client's Cloudflare DNS (zone IDs in memory `reference_cloudflare_api.md`).

- [ ] **Step 2: Commit**

```bash
git add deploy/DEPLOY.md
git commit -m "docs: invoicing deploy runbook — env, cron, SPF, go-live rehearsal"
```

---

## Out of scope (per spec)

- Confirmation/top-up invoices (phase 2 — `type: 'confirmation'` slot reserved; awaiting client template and corrected amount: £30 + £90 ≠ £110 flagged).
- Affiliate payment automation; BlueLion bank-payment reconciliation.
