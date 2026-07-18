# Automated Daily Invoicing & Affiliate Reconciliation — Design

Date: 2026-07-19
Status: awaiting approval

## Purpose

Every morning at 09:00 Europe/London the system:

1. Generates the **BlueLion VAT invoice** (PDF) for the previous calendar day
   (00:00–23:59 London time), attaches an **Excel reconciliation workbook**,
   and emails both to BlueLion from `accounts@click2leads.co.uk`.
2. Sends each affiliate that had activity a **Daily Lead Reconciliation
   email** with their own Excel workbook, so they can invoice Kickbyte.
3. Stores every invoice in MongoDB for the dashboard's Invoices page.

Lead-driven: no leads yesterday → no BlueLion invoice; an affiliate with no
leads yesterday gets no email — unless they have a newly-opened replacement
obligation (the 72-hour SLA starts at notification, so they must be told).

## Billing rules (BlueLion daily invoice)

A lead is billed on the invoice for day D when:

- `submitted_at` falls on day D (Europe/London)
- `initial_status = accepted`
- not `cancelled`, `signature_status != failed`, not `replaced_by_lead`

Line mapping (rates configurable via env, defaults fixed):

| Lead                      | Invoice line                     | Rate |
|---------------------------|----------------------------------|------|
| `search_status = virgin`  | PCP Claim Accepted Not Searched  | £110 |
| `search_status = searched`| PCP Claim Payable Previous Search| £30  |

`unknown` search status = not billed (consistent with moneyEngine).

Totals: `net = Σ qty × rate`, `vat = net × 0.20` (2 dp), `gross = net + vat`.

Leads still `pending` at generation time are never billed later (no
catch-up) — client confirmed same-day acceptance via API.

**Phase 2 (not in this build):** when BlueLion's API later flags a searched
lead billable after lender confirmation, a separate top-up invoice
(`type: 'confirmation'`) is generated — never merged into the daily one.
The data model reserves the slot. Top-up amount TBC (client said £90 "to
complete £110", but 30+90=120 — flagged, awaiting template).

## Invoice identity

- Number: `BlueLion NNN`, zero-padded to 3, from the existing atomic
  `Counter` collection (`_id: 'invoice_bluelion'`) — never repeats, safe
  under concurrency, grows past 999 naturally.
- Invoice date = due date = generation date (template shows "Due on
  receipt"; the requirement's 15/07→16/07 example is read as "invoice date
  is the generation morning, the day after the reporting period").
- Idempotent: unique index on `(type, period_end)`. Re-running the script
  the same morning is a no-op; a failed email send is retried on the next
  run without creating a duplicate invoice.

## Components

### 1. `models/Invoice.js` (new)

```
number        String  (unique)         "BlueLion 007"
seq           Number
type          String  enum daily|confirmation   (default daily)
period_start  String  "2026-07-18"  (London date)
period_end    String  "2026-07-18"  (unique with type)
invoice_date  Date
lines         [{ description, qty, rate, amount }]
net, vat, gross   Number
email_to      String
email_status  String  enum pending|sent|failed
sent_at       Date
payment_status String enum awaiting|paid   (manual, dashboard-set)
pdf_path, xlsx_path  String   (files on disk under backend/storage/invoices/)
```

Artifacts are written to disk and paths stored; the dashboard serves them
for download and "resend" re-attaches the same files (an invoice's PDF is
immutable once sent).

### 2. `services/invoicePdf.js` (new) — pdf-lib overlay

Loads `backend/assets/invoice-template-bluelion.pdf` (the client-approved
QuickBooks PDF, committed to the repo), draws white rectangles over the
variable regions, stamps new values at fixed coordinates:

- INVOICE number, DATE, DUE DATE
- line 1/2: QTY, RATE, AMOUNT
- SUBTOTAL, VAT TOTAL, TOTAL, BALANCE DUE
- VAT SUMMARY row (VAT, NET)

Layout is fixed (always exactly two lines), so output is pixel-identical
to the approved invoice. New dependency: `pdf-lib` (pure JS). No LLM
anywhere in the money path — all values computed arithmetically.

### 3. `services/reconExcel.js` (new) — ExcelJS

**BlueLion workbook** (attached to invoice email):

- Tab "Leads": Lead Reference, Submission Date, Affiliate, Search Status,
  Payment Status, Invoice Category, Invoice Value — one row per billed lead.
- Tab "Affiliate Summary": Affiliate, Non Search, Previous Search, Total.

**Affiliate workbook** (attached to each reconciliation email):

- Tab "Payable Leads": the affiliate's billed leads for the day, at *their*
  rate_card rates.
- Tab "Replacements Required": open obligations, split by reason
  (signature / cooling-off), with requested-at and 72h deadline.
- Tab "Replacements Supplied": supplied replacements matched to originals.
- Tab "Confirmed After Lender Check": leads that became fully payable
  (`law_firm_confirmed`) — informational.

Formula-injection guard (`csvSafe`) reused from exportRoutes.

### 4. `services/invoiceService.js` (new)

Orchestrates: query leads for the period (same London-day filtering the
digest uses) → build lines/totals → create Invoice doc (counter) → render
PDF → build workbook → return artifacts. Pure functions where possible;
unit-tested against mongodb-memory-server like existing tests.

### 5. `services/affiliateRecon.js` (new)

Per affiliate with (leads yesterday OR replacement obligations opened
yesterday): builds the client-supplied email body with Fully Payable /
Part-Payable quantities at the affiliate's own `rate_card` rates, VAT 20%,
plus their workbook.

### 6. `models/Affiliate.js` (edit)

Add `contact_name`, `contact_email`. Surface both in the dashboard's
affiliate edit form. Seed: ali@claim3000.co.uk (claim3000 affiliate).
Affiliates without a contact_email are skipped with a logged warning.

### 7. `scripts/sendInvoices.js` (new) — cron entry

```
0 9 * * *  CRON_TZ/TZ=Europe/London  node scripts/sendInvoices.js
```

Same pattern as `sendDigest.js`. Flow: connect → idempotency check →
generate invoice + workbook → email BlueLion → record → affiliate emails
→ record each. Exit non-zero on failure; log to /var/log. Optional
`INVOICE_HEARTBEAT_URL` pinged on success (Uptime Kuma pattern). Server TZ
handling verified at deploy time; if the cron daemon lacks CRON_TZ the
script self-guards by checking London hour.

`--dry-run` flag: generates PDF + Excel to disk, prints email preview,
sends nothing — used for client sign-off before go-live.

### 8. Email sending

Nodemailer via GoDaddy: `smtpout.secureserver.net:465` SSL, user
`accounts@click2leads.co.uk`. New env vars:

```
ACCOUNTS_SMTP_HOST=smtpout.secureserver.net
ACCOUNTS_SMTP_PORT=465
ACCOUNTS_SMTP_USER=accounts@click2leads.co.uk
ACCOUNTS_SMTP_PASS=            # pending from client
INVOICE_TO_EMAIL=              # BlueLion recipient, pending Monday
INVOICE_CC=                    # optional internal copy
BLUELION_VIRGIN_RATE=110
BLUELION_SEARCHED_RATE=30
```

Until `INVOICE_TO_EMAIL` is set, invoices go to `INVOICE_CC`/`DIGEST_TO`
(internal) so the system runs end-to-end from day one. Email bodies: the
two client-supplied templates (BlueLion invoice email; affiliate
reconciliation email), rendered as minimal HTML tables + plain-text alt.

### 9. `routes/invoiceRoutes.js` + frontend Invoices page (new)

- `GET /api/invoices` — list (number, period, net, vat, gross,
  email_status, payment_status)
- `GET /api/invoices/:id/pdf` and `/:id/xlsx` — download stored artifacts
- `POST /api/invoices/:id/resend` — re-send stored artifacts
- `PATCH /api/invoices/:id` — set payment_status (awaiting/paid)

Frontend: Invoices page (admin-only) — table matching the client's
mock: Invoice | Period | Net | VAT | Total | Status, with download links
and a paid/awaiting toggle.

## Error handling

- Email failure → invoice stored `email_status: failed`; next morning's
  run retries unsent invoices before generating the new one; failure also
  visible on the Invoices page.
- SMTP unconfigured → script logs and exits 0 (digest pattern), generates
  nothing (no invoice numbers consumed on a misconfigured box).
- Zero leads → no invoice, log line only; affiliates notified only if
  replacement obligations opened.

## Testing

- Unit: line building, VAT rounding (2 dp), zero-day behaviour,
  exclusion rules (cancelled / failed signature / replaced / pending /
  unknown search), counter uniqueness, idempotency on re-run.
- Integration: full generate-and-record flow against
  mongodb-memory-server (existing harness).
- Manual: `--dry-run` output (PDF + Excel) reviewed by client before the
  cron goes live.

## Out of scope (explicit)

- Confirmation/top-up invoices (phase 2 — awaiting template + amount).
- Payment reconciliation with BlueLion's actual bank payments.
- Affiliate payment automation (the reconciliation email exists so
  affiliates invoice Kickbyte manually).
