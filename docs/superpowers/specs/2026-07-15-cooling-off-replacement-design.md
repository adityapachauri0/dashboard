# Cooling-Off Replacements + API Docs Removal — Design

**Date:** 2026-07-15
**Status:** Approved
**Origin:** Client feedback (Anthony, Jul 15) — (1) remove the API docs page: the law firm distributes API documentation, we don't need to. (2) The law firm also requires replacements when a client exercises their 14-day statutory cooling-off right and cancels. These cancellations arrive via the API and must be tracked and reconciled the same way as failed-signature replacements, but the two contractual replacement types must be distinguishable. Anthony's requested Payment Status option list: Not Payable · Payable (100%) · Part-paid – Awaiting Law Firm · Payable in Full · Replacement Required – Signature · Replacement Supplied – Signature · Replacement Required – 14 Day Cooling-Off · Replacement Supplied – 14 Day Cooling-Off. The dashboard must track the submission date and the date the cancellation notification arrived.

## Decisions (agreed with user)

1. **Identical behaviour, different label:** a cooling-off cancellation behaves exactly like a failed signature — lead becomes £0/`not_payable`, the 72h supply clock starts, the obligation appears on /replacements and flows through the same supplied/closed/reopen lifecycle. The ONLY difference is the reason tag, so the two types reconcile separately.
2. **Trust the law firm on the 14-day window:** any cancellation notification triggers the obligation regardless of arrival timing. We record `submitted_at` (exists) and `cancelled_at` (new) so timing can be verified manually during reconciliation. No validation, no warning badges.
3. **Best-effort payload recognition:** no platform payload spec exists yet. Recognize common cancellation spellings in the webhook normalizer (same pattern as signature/search statuses); CSV import and a manual admin control are the fallback channels. Extend mappings when real payloads arrive.
4. **Architecture (Approach A):** one `replacement_reason` tag on the existing single `replacement_status` lifecycle. No parallel lifecycle (B), no reason-in-enum encoding (C) — the deployed SLA clock, /replacements page, and propagation service are reason-agnostic and stay untouched.

## 1. Data model

Three new fields on `Lead` (backend/models/Lead.js):

```js
cancelled: { type: Boolean, default: false },   // 14-day cooling-off cancellation
cancelled_at: Date,                              // when the cancellation notification arrived
replacement_reason: { type: String, enum: ['signature', 'cooling_off'] }, // unset until required
```

- `cancelled_at` is stamped once, when `cancelled` first flips true (webhook/import/manual), and never reset — it is the notification date Anthony wants tracked alongside `submitted_at`.
- `replacement_reason` is stamped when `replacement_status` first leaves `none`. **First reason wins, never overwritten** — a lead cannot meaningfully fail signature *and* cancel (no signed agreement → nothing to cool off from); if both events ever arrive, the first to trigger the obligation defines the reconciliation bucket and the second is still visible in `history`.
- All other replacement fields (`replacement_status`, `replacement_requested_at`, `replaces_lead`, `replaced_by_lead`) reused unchanged. SLA deadline stays derived (`replacement_requested_at + 72h`), never stored.

## 2. Status flow

All inside `statusService.applyStatusChanges` (single choke point), each change recorded in `history`:

| Trigger | Effect |
|---|---|
| `cancelled` → `true` | `cancelled_at = now` (only if unset); then `replacement_status = 'required'` + clock start via the same rule as signature failure, with `replacement_reason = 'cooling_off'` |
| `signature_status` → `failed` (existing rule) | unchanged, now also stamps `replacement_reason = 'signature'` |
| Supplied / closed / reopen transitions | unchanged — reason-agnostic |

- `cancelled` joins `UPDATABLE_FIELDS` so webhook, CSV import, and manual PATCH all flow through the choke point. `cancelled` is one-way in practice (no un-cancel mapping in the normalizer); an admin CAN manually flip it back off via the drawer switch if set in error — the replacement obligation stays (history preserves the audit trail) and can be resolved by the existing lifecycle.
- **Money** (backend/services/moneyEngine.js): `cancelled` → £0/`not_payable`, checked at the same precedence as `signature_status === 'failed'` (`replaced_by_lead` still beats everything). A previously payable lead that cancels drops to £0 — same as the signature rule.
- **Webhook normalizer** (backend/services/normalize.js): new `cancelled` canonical field. Keys tried: `cancelled`, `canceled`, `cancellation`, `cancellation_status`, plus the main `status`/`result`/`outcome` keys. Values mapped true: `cancelled`, `canceled`, `cancellation`, `cooling off`, `cooling-off`, `cooling_off`, `cooled off`, `true`, `yes`. Unrecognized → undefined (never guess). NOTE: `initial_status` mapping is untouched — a `status: "cancelled"` payload maps to the new `cancelled` field, not to `rejected`.
- **Backfill** (scripts/backfillReplacementReason.js): every existing lead with `replacement_status ≠ 'none'` and no `replacement_reason` gets `replacement_reason = 'signature'` (the only trigger that existed before this change). Idempotent, history-logged, run once on prod after deploy.

## 3. Payment Status — the 8 options

One shared derivation (frontend, exported from StatusBadge.jsx; mirrored in the export row builder) maps each lead to exactly one label:

| Condition (first match wins) | Label |
|---|---|
| `replacement_status = 'required'` + reason `signature` | Replacement Required – Signature |
| `replacement_status = 'required'` + reason `cooling_off` | Replacement Required – 14 Day Cooling-Off |
| `replacement_status ∈ {'supplied','closed'}` + reason `signature` | Replacement Supplied – Signature |
| `replacement_status ∈ {'supplied','closed'}` + reason `cooling_off` | Replacement Supplied – 14 Day Cooling-Off |
| `payable_status = 'payable'` | Payable (100%) |
| `payable_status = 'partial_pending_confirmation'` | Part-paid – Awaiting Law Firm |
| `payable_status = 'payable_full'` | Payable in Full |
| otherwise (`not_payable`) | Not Payable |

- Replacement labels win over money labels while an obligation exists (such leads are £0 anyway); `closed` renders as Supplied — the obligation was met, and Anthony's list has no "closed" option.
- Missing `replacement_reason` (pre-backfill legacy row) falls back to `signature` everywhere labels/filters/exports derive from it — deterministic during the deploy→backfill window.
- **Filters** (Leads + Export "Payment status" select): the same 8 options. The four replacement options map to query params `replacement_status=required|supplied` (+`closed` for supplied) and `replacement_reason=signature|cooling_off` via `paymentFilterToParams`; the money options map to `payable_status` as today. Backend list endpoints accept the new `replacement_reason` param. The old combined "replacement required/supplied" options are replaced by the split ones.

## 4. UI changes

- **/replacements page:** reason badge column (Signature / 14-Day Cooling-Off); mini-stat cards (Required · Supplied · Closed · Overdue) show per-reason counts (e.g. "3 — 2 sig / 1 cooling-off"); reason filter. SLA countdown, assign-replacement modal, scoping unchanged. For cooling-off rows the "Signature failed" date column generalizes to "Triggered" (= signature-failed or cancelled date).
- **Lead drawer:** shows Cancelled badge + `cancelled_at` when set; admin-only "14-day cooling-off cancellation" Switch (mirrors the possible-duplicate switch pattern) as the manual channel.
- **Summary page:** unchanged — "Outstanding replacements" KPI stays a single total; by-affiliate Required/Supplied/Outstanding columns stay unsplit. The reason split lives on /replacements and in exports where reconciliation happens. (Cheap to split later if requested.)
- **Exports (CSV/XLSX):** two new columns — `cancelled_at`, `replacement_reason`. Monthly statement XLSX: OUTSTANDING REPLACEMENTS row splits into "— Signature" and "— 14 Day Cooling-Off" subtotal rows.
- **CSV import:** recognizes a `cancelled` column through the same normalizer.

## 5. API docs page removal

Delete `frontend/src/pages/ApiDocs.jsx`; remove its route, nav link, and icon entry from `App.jsx`. Both roles. Backend untouched (there is no docs endpoint). The law firm distributes API documentation.

## 6. Testing

Extend the existing suite (84 tests, `cd backend && npm test`):

- Cancellation via webhook payload variants (`status: "cancelled"`, `cancellation: "cooling-off"`, boolean forms) → `cancelled`, `cancelled_at` stamped once, obligation required with reason `cooling_off`, money £0.
- Cancellation via import and manual PATCH → same outcome (choke-point equivalence).
- First-reason-wins: signature-failed lead that later receives a cancellation keeps reason `signature` (and vice versa); `cancelled_at`/history still recorded.
- Clock: cancellation on a lead whose clock already runs does not reset `replacement_requested_at`.
- Supplied/closed/reopen propagation preserves `replacement_reason`.
- Previously payable lead (virgin, accepted) cancels → £0 `not_payable`; replaced-by-lead still wins.
- `replacement_reason` filter param on leads/replacements/export endpoints; 8-option filter mapping.
- Export row builder: new columns present; statement subtotal split sums correctly.
- Backfill: legacy required/supplied leads get `signature`; leads with `none` untouched; idempotent re-run.
- Regression: full existing suite green — signature-path behaviour unchanged.

## 7. Deploy

Standard: rsync → npm install → build → pm2 restart pcp-affiliate-api → run backfill script on prod → purge CF cache → live-verify (JWT mint + DOM assert, screenshots flaky on this app).
