# PCP Affiliate Dashboard — Design Spec

**Date:** 2026-07-08
**Status:** Approved by user (brainstorming session)

## Purpose

Internal dashboard + lead gateway for the PCP claims project. Tracks affiliate
lead supply, platform API responses, acceptance/rejection, signature status,
search status (virgin vs already-searched), payment tiers, and payment
reconciliation across multiple affiliates. Replaces "raw API response only"
visibility with a persistent, auditable record for us and our suppliers.

## Decisions made

| Question | Decision |
|---|---|
| System scope | **Full gateway** — affiliates POST leads to our API; we forward to the platform and record everything |
| Users | **Admin + affiliate logins** from day one; affiliates scoped to own data |
| Downstream platform | **Different platform** (not PCP247); docs pending → pluggable adapter, manual mode first |
| Hosting | Existing VPS (31.97.57.193), new subdomain, Nginx + PM2 + MongoDB |
| Pricing | **Per-affiliate rate card** (virgin rate, searched upfront rate, searched confirmation rate) |
| Stack | Express backend (port 5005) + React/Vite/Mantine SPA (static via Nginx) |

## Architecture

```
Affiliate systems ──POST /api/v1/leads (X-API-Key)──▶ ┌──────────────────────┐
Platform webhook ──POST /api/v1/webhooks/platform──▶ │  Express API :5005    │──▶ MongoDB
Admin CSV upload ──POST /api/v1/imports───────────▶ │  (pcp-affiliate-api)  │      (pcp-affiliates)
                                                     │  platform adapter ────┼──▶ Platform API (docs pending)
                                                     └──────────────────────┘
Browser (admin + affiliate) ──▶ Nginx: React SPA static + /api proxy
```

- One PM2 process (`pcp-affiliate-api`). SPA is a static Vite build served by
  Nginx directly — no frontend node process.
- Subdomain default: `leads.click2leads.co.uk` (changeable at deploy time);
  Cloudflare DNS + certbot per existing VPS pattern.

## Data model (MongoDB)

### `affiliates`
- `name`, `brands[]` (domains/brand names they send under)
- `lead_source` — unique slug, used when submitting on the shared key
- `api_key_hash` (SHA-256) + `api_key_prefix` (first 8 chars, for display)
- `rate_card`: `{ virgin_rate, searched_upfront_rate, searched_confirmation_rate, currency: 'GBP' }`
- `active`, timestamps

### `users`
- `email`, `password_hash` (bcrypt), `role: 'admin' | 'affiliate'`
- `affiliate_id` (required for affiliate role)

### `leads`
- `ref` — our reference ID, `KB-YYYY-NNNNNN`, sequential
- `affiliate_id`, `lead_source`, `brand`
- `submitted_at`, `payload` (raw JSON exactly as received), applicant display
  fields extracted (name etc.) for list views
- `platform_ref` — the platform's ID for this lead, once known
- **Status layer 1 — initial:** `initial_status: 'pending' | 'accepted' | 'rejected'`,
  `rejection_reason`
- **Status layer 2 — search:** `search_status: 'virgin' | 'searched' | 'unknown'`
- **Status layer 3 — signature:** `signature_status: 'pending' | 'passed' | 'failed'`,
  `signature_deadline` = submitted_at + 48h (display flags weekend overrun; no
  hard auto-fail)
- **Status layer 4 — payable:** `payable_status: 'not_payable' | 'payable' |
  'partial_pending_confirmation' | 'payable_full' | 'replaced'`
- **Replacement:** `needs_replacement` (bool), `replaces_lead` (ObjectId),
  `replaced_by_lead` (ObjectId)
- **Money:** `amounts: { upfront_due, confirmation_due, total_due }` — computed
  and stored on every status change (stable snapshots for export)
- **Audit:** `history[]: { at, field, from, to, source: 'api'|'webhook'|'import'|'manual', user? }`
- `last_updated`

### `imports`
- `filename`, `uploaded_by`, `at`, `row_count`, `matched`, `unmatched`,
  `mapping_template_used`

### `webhook_events`
- Raw payload of every webhook received, `matched_lead` (nullable), `at`.
  Unmatched events appear in an admin review queue.

## Lead flow

1. **Ingest:** `POST /api/v1/leads` with per-affiliate `X-API-Key`, or shared
   key + `lead_source` body field. Validate → store as `pending` → assign `ref`.
2. **Forward:** platform adapter `submitLead(lead)` returns canonical
   `{ initial_status, rejection_reason, search_status, platform_ref, raw }`.
   Ships in **manual mode** (docs pending): leads stay `pending`; statuses
   arrive via webhook/import/manual. Real adapter = one module swap later.
3. **Respond** to affiliate with our `ref` + current status.

### Status update channels (all live from day one)
- **Webhook** `POST /api/v1/webhooks/platform` — store raw, match by
  `platform_ref` (fallback: name + date), unmatched → review queue.
- **CSV import** — admin uploads platform report; first import runs a
  column-mapping step saved as a reusable template; matches and updates
  statuses in bulk.
- **Manual adjustment** — admin edits any status from the lead detail view.
- Every change from every channel appends to `history[]`.

## Money engine

Computed from the affiliate's rate card on each status change:

| Condition | Result |
|---|---|
| accepted + virgin | `upfront_due = virgin_rate`, payable |
| accepted + searched | `upfront_due = searched_upfront_rate`, status `partial_pending_confirmation` |
| searched lead later confirmed by law firm | `confirmation_due = searched_confirmation_rate`, status `payable_full` |
| rejected | £0, `not_payable` |
| signature failed | £0, `payable_status = 'not_payable'`, `needs_replacement = true` |
| replacement submitted | new lead links `replaces_lead`; original → `replaced` (never double-billed) |

Replacement SLA: the platform's exact replacement window is not yet documented,
so the system links replacements whenever they arrive and displays an
"within 48h of signature failure" flag; the commercial call stays with admin.

`total_due = upfront_due + confirmation_due`. Affiliate breakdown sums stored
amounts — no live recomputation at read time.

## Views

### Admin
- **Summary** — today + arbitrary date range: total submitted, accepted,
  rejected, pending, acceptance %, rejection %, awaiting signature, awaiting
  confirmation.
- **Affiliates** — per-affiliate rollups (volume, accepted, rejected, pending,
  acceptance %, payable, non-payable/replacement, estimated owed); rate card
  editor; API key generate/revoke.
- **Leads** — filterable table (affiliate, brand, date range, all status
  layers); columns per brief (ref, date/time, affiliate, brand, API response,
  rejection reason, signature, search status, payment tier, payable status,
  last updated); row opens detail drawer: full payload, full history, manual
  status controls.
- **Imports** — upload CSV, view import history, unmatched-webhook review queue.
- **Export** — CSV filtered by affiliate / date range / lead status / payable
  status / weekly-monthly reconciliation period. CSV only (opens in Excel).

### Affiliate
Same Summary, Leads, Export — hard-scoped server-side to their `affiliate_id`.
They see their own owed amounts. No rate card editing, no other affiliates,
no imports.

## Auth & security

- JWT sessions, bcrypt passwords, server-side role enforcement.
- Affiliate-role queries forcibly filtered by `affiliate_id` in middleware —
  never trusted from the client.
- API keys stored hashed; shown once at creation.
- Rate limiting on ingest endpoint; raw payloads retained for audit.
- HTTPS via Cloudflare + certbot (existing VPS pattern).

## Testing

- Unit tests: money engine (every rate-card branch, replacement/no-double-bill)
  and status-transition rules.
- Integration self-check: ingest endpoint end-to-end (submit → stored →
  response shape), auth scoping (affiliate cannot read another's leads).

## Out of scope (v1)

- Automated payouts / invoice PDFs
- Email notifications
- xlsx export (CSV covers Excel)
- Multi-currency
- Additional buyer platforms (adapter interface allows later)
- Real platform adapter implementation (blocked on API docs; manual mode ships)
