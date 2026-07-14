# Replacement Obligations Workflow — Design

**Date:** 2026-07-14
**Status:** Approved
**Origin:** Client feedback (Anthony, Jul 14) — model the dashboard on the Tri-Party MSA v6: track replacement *obligations* to BlueLion, not just lead statuses. Contract facts: failed signatures entitle the Firm to request a replacement within 14 days of receiving the client; the Introducer must supply the replacement within 72 hours of the request.

## Decisions (agreed with user)

1. **SLA clock:** signature-failed event = replacement requested. The 72h countdown starts the moment `signature_status` flips to `failed`. No separate "mark requested" step.
2. **Closing rule:** obligation auto-closes when the linked replacement lead's `initial_status` becomes `accepted`. If the replacement is rejected, the obligation reopens.
3. **Visibility:** Replacements page is visible to admins (all obligations) and affiliates (scoped to their own leads), same scoping model as Leads.
4. **Architecture:** stored `replacement_status` on the Lead, maintained at the existing `statusService.applyStatusChanges` choke point (Option B). No separate obligations collection; no fully-derived reads.

## 1. Data model

Two new fields on `Lead` (backend/models/Lead.js):

```js
replacement_status: {
  type: String,
  enum: ['none', 'required', 'supplied', 'closed'],
  default: 'none',
  index: true,
},
replacement_requested_at: Date,
```

- SLA deadline is always **derived**: `replacement_requested_at + 72h`. Never stored.
- Existing fields reused unchanged: `replaces_lead`, `replaced_by_lead`, `needs_replacement`, `signature_status`, `history`.
- `payable_status` enum unchanged (`replaced` stays as the internal value; UI relabels it — §5).

## 2. Lifecycle transitions

All transitions run inside `statusService.applyStatusChanges` (the single choke point for api/webhook/import/manual mutations), each recorded in `history`:

| Trigger | Effect on original lead |
|---|---|
| `signature_status` → `failed` | `replacement_status = 'required'`, `replacement_requested_at = now` (only if not already set — re-imports must not reset the clock) |
| Replacement linked (`replaces_ref` on ingest, or admin PATCH) | `replacement_status = 'supplied'` |
| Replacement lead's `initial_status` → `accepted` | Original → `'closed'` |
| Replacement lead's `initial_status` → `rejected` | Link cleared (`replaced_by_lead = null`, old link preserved in history on both leads), original reopens as `'required'`; `replacement_requested_at` **unchanged** — a rejected replacement does not reset the contractual clock |

- Cross-document updates (replacement accepted/rejected → mutate the original) happen where the replacement lead's status changes: the handler follows `replaces_lead`, applies the change via `applyStatusChanges` on the original, and saves both.
- Chains: a replacement whose own signature later fails becomes its own obligation through the same first rule. No special casing.
- Money engine untouched. `required` leads remain £0 (`not_payable`); a supplied/closed original keeps `payable_status: 'replaced'` internally.
- Reopened originals are linkable to a new replacement (the double-replacement guard checks `replaced_by_lead`, which is now null again).

## 3. Replacements page (`/replacements`)

New page, both roles, affiliate-scoped by JWT exactly like Leads.

- **Mini-stats row:** Required · Supplied · Closed · Overdue (overdue = `required` and now > deadline). All-time counts, not date-filtered.
- **Table:** all leads with `replacement_status ≠ 'none'`. Columns: Ref · Affiliate (admin only) · Signature failed (date) · SLA · Replacement ref (clickable, opens that lead) · Status badge.
  - SLA cell: `required` rows show live countdown — "67h remaining" (green > 24h, amber ≤ 24h), "OVERDUE" (red) past deadline. `supplied`/`closed` rows show "—".
- **Assign replacement** (admin, `required` rows only): modal with ref input; submits the existing `PATCH /dashboard/leads/:id { replaces_ref }` flow (the *replacement* lead is patched with the original's ref). Modal accepts the replacement lead's ref; validation errors (404/409) surface inline.
- Filters: replacement status, affiliate (admin).
- Backend: `GET /api/v1/dashboard/replacements` returns the scoped list + mini-stat counts. Deadline/overdue computed server-side so CSV/UI agree.

## 4. Summary changes

- KPI card **"Awaiting signature" → "Outstanding replacements"** — count of `replacement_status: 'required'`, **all-time** (obligations don't expire with the date filter; same treatment as the existing `attention` block).
- Attention strip: add "N replacement(s) OVERDUE" (red-worthy wording) as a separate item from the existing "N replacements needed".
- **By-affiliate table** columns become: Affiliate · Submitted · Accepted · Payable · **Required · Supplied · Outstanding** · Owed. Outstanding = required count (obligations still owed). Backed by `$group` on `replacement_status` in statsRoutes.

## 5. Labels, filters, exports

- **Payment status dropdown** (Leads + Export pages), new option list:
  Not payable / Payable (100%) / Part-paid — awaiting law firm / Payable in full / **Replacement required** / **Replacement supplied**.
  - `Replacement required` filter maps to `replacement_status: 'required'` (not a `payable_status` value).
  - `Replacement supplied` maps to `payable_status: 'replaced'` — this intentionally includes `closed` obligations too (both are £0 and beyond the payment question); the label "replaced" disappears from the UI (`LABELS` in StatusBadge.jsx).
- **"Next update" filter** (Export page, and Leads for parity): Awaiting confirmation / Replacement required / Complete. Computed **server-side** in `leadFilter.js`, mirroring the Leads column logic:
  - awaiting confirmation = `partial_pending_confirmation`
  - replacement required = `replacement_status: 'required'`
  - complete = accepted, signature passed, nothing pending (payable or payable_full, or closed replacement)
- **Exports** (CSV + XLSX, shared row builder): new columns `replacement_status`, `replacement_requested_at`, `replacement_sla` (hours remaining, or `OVERDUE`, empty when n/a). Monthly statement XLSX totals row gains outstanding-replacements count for month-end netting-off.

## 6. Backfill & deploy

- Idempotent script `backend/scripts/backfillReplacementStatus.js`:
  - `needs_replacement && !replaced_by_lead` → `required`
  - `replaced_by_lead` set → `supplied`, or `closed` if the replacement lead is `accepted`; if the linked replacement is `rejected` (possible in pre-feature data), clear the link and set `required` — same as the go-forward reopen rule
  - `replacement_requested_at` recovered from the lead's history entry where `signature_status → failed` (fallback: `last_updated`).
- Deploy: rsync → npm install → build → pm2 restart `pcp-affiliate-api` → run backfill → purge CF cache → Playwright live-verify (Summary KPI, Replacements page, Export filters).

## 7. Testing

Backend (on top of existing 65 tests): every lifecycle transition (fail→required; link→supplied; accept→closed; reject→reopen with clock preserved; chained failure), requested_at not reset on re-import, SLA derivation incl. overdue boundary, new leadFilter params (`replacement_status`, next-update), replacements endpoint scoping (affiliate JWT cannot widen), export columns. Frontend verified via Playwright on prod post-deploy (DOM-based checks; screenshots only after animations settle).

## Out of scope (deliberate)

- Replacement mentions in the daily digest email.
- Explicit "replacement requested" webhook event type (signature-failed is the request signal for now).
- Tracking BlueLion's 14-day request window (only needed to dispute late requests).
- Client's "financial obligation state machine" beyond the above — the money engine already encodes it.
