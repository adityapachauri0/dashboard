# Cooling-Off Replacements + API Docs Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track 14-day cooling-off cancellations as a second replacement type (reason tag on the existing lifecycle), render Anthony's 8-option Payment Status list, and remove the API docs page.

**Architecture:** Three new Lead fields (`cancelled`, `cancelled_at`, `replacement_reason`); cancellation becomes a second trigger into the existing reason-agnostic replacement lifecycle inside the `statusService.applyStatusChanges` choke point. The SLA clock, /replacements page mechanics, and propagation service are untouched. UI derives the 8 payment labels from `payable_status` × `replacement_status` × `replacement_reason`.

**Tech Stack:** Express CJS + Mongoose (backend, `node --test` + supertest + mongodb-memory-server), React/Vite/Mantine (frontend, no test runner — `npm run build` is the check).

**Spec:** `docs/superpowers/specs/2026-07-15-cooling-off-replacement-design.md`

## Global Constraints

- Repo root: `~/Desktop/pcp-affiliate-dashboard`. Backend tests: `cd backend && npm test` (84 passing before this work). Frontend check: `cd frontend && npm run build`.
- All status mutations MUST go through `statusService.applyStatusChanges` — never set `replacement_status`/`payable_status`/`cancelled_at` directly in routes.
- `cancelled_at` stamped once, never reset. `replacement_reason` stamped once when obligation first created — first reason wins, never overwritten.
- Missing `replacement_reason` on a lead with an obligation = `signature` (legacy fallback) everywhere it's read.
- Exact UI copy for labels (en dash `–`): `Not Payable` · `Payable (100%)` · `Part-paid – Awaiting Law Firm` · `Payable in Full` · `Replacement Required – Signature` · `Replacement Supplied – Signature` · `Replacement Required – 14 Day Cooling-Off` · `Replacement Supplied – 14 Day Cooling-Off`.
- `replacement_status: 'closed'` renders/filters as **Supplied** (Anthony's list has no closed option).
- Commit after every task; conventional-commit style messages as shown.

---

### Task 1: Lead model fields + webhook normalizer recognition

**Files:**
- Modify: `backend/models/Lead.js` (after `replacement_requested_at`, ~line 45)
- Modify: `backend/services/normalize.js`
- Test: `backend/tests/normalize.test.js` (append)

**Interfaces:**
- Produces: `Lead.cancelled` (Boolean, default false), `Lead.cancelled_at` (Date), `Lead.replacement_reason` (`'signature' | 'cooling_off'`, unset by default). Canonical field `cancelled: true` from `canonicalFromPayload(payload)` / `normalizeField('cancelled', raw)`.

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/normalize.test.js`:

```js
test('cancellation spellings map to cancelled=true', () => {
  for (const raw of ['cancelled', 'canceled', 'cancellation', 'cooling off', 'cooling-off', 'cooling_off', 'cooled off', 'yes', 'true', true]) {
    assert.strictEqual(normalizeField('cancelled', raw), true, `raw=${raw}`);
  }
});

test('cancelled never maps false — un-cancel is manual-only', () => {
  for (const raw of ['false', 'no', false, 'active', 'random']) {
    assert.strictEqual(normalizeField('cancelled', raw), undefined, `raw=${raw}`);
  }
});

test('canonicalFromPayload picks up cancellation from dedicated and main status keys', () => {
  assert.deepStrictEqual(canonicalFromPayload({ cancelled: true }), { cancelled: true });
  assert.deepStrictEqual(canonicalFromPayload({ cancellation_status: 'cooling-off' }), { cancelled: true });
  assert.deepStrictEqual(canonicalFromPayload({ status: 'cancelled' }), { cancelled: true });
  // a cancelled main status must NOT bleed into initial_status
  assert.strictEqual(canonicalFromPayload({ status: 'cancelled' }).initial_status, undefined);
  // accepted status still works and does not set cancelled
  assert.deepStrictEqual(canonicalFromPayload({ status: 'accepted' }), { initial_status: 'accepted' });
});
```

(`normalizeField` and `canonicalFromPayload` are already imported at the top of this test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/normalize.test.js`
Expected: FAIL — `normalizeField('cancelled', …)` returns `undefined` (no `cancelled` map yet).

- [ ] **Step 3: Implement** — in `backend/services/normalize.js`, add to `MAPS` (after `law_firm_confirmed`):

```js
  // 14-day cooling-off cancellation — truthy spellings only; false/unknown →
  // undefined. Un-cancelling is a manual dashboard action, never a payload.
  cancelled: {
    cancelled: true, canceled: true, cancellation: true,
    'cooling off': true, 'cooling-off': true, cooling_off: true, 'cooled off': true,
    true: true, yes: true,
  },
```

In `canonicalFromPayload`, after the `law_firm_confirmed` tryKeys line:

```js
  tryKeys('cancelled', ['cancelled', 'canceled', 'cancellation', 'cancellation_status', 'status', 'result', 'outcome']);
```

(No `normalizeField` change needed — `String(true)` → `'true'` hits the map.)

In `backend/models/Lead.js`, after `replacement_requested_at: Date,`:

```js
    // 14-day cooling-off cancellation (spec 2026-07-15). cancelled_at = when
    // the notification arrived; stamped once in statusService, never reset.
    cancelled: { type: Boolean, default: false },
    cancelled_at: Date,
    // Why the replacement is owed. Stamped when replacement_status first
    // leaves 'none'; first reason wins. Missing (legacy) = 'signature'.
    replacement_reason: { type: String, enum: ['signature', 'cooling_off'] },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/normalize.test.js tests/models.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/models/Lead.js backend/services/normalize.js backend/tests/normalize.test.js
git commit -m "feat: Lead cancellation fields + webhook cancellation recognition"
```

---

### Task 2: Money engine — cancelled lead is £0

**Files:**
- Modify: `backend/services/moneyEngine.js:8` (after the signature-failed line)
- Test: `backend/tests/moneyEngine.test.js` (append)

**Interfaces:**
- Consumes: `lead.cancelled` from Task 1.
- Produces: `computeMoney` returns `{ …zero, payable_status: 'not_payable' }` when `lead.cancelled` is true (unless `replaced_by_lead` — that still wins with `'replaced'`).

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/moneyEngine.test.js` (uses the same `rates`-style constants as existing tests in that file — reuse whatever rate-card constant is already defined there):

```js
test('cooling-off cancellation zeroes a payable lead', () => {
  const lead = { initial_status: 'accepted', search_status: 'virgin', signature_status: 'passed', cancelled: true };
  const m = computeMoney(lead, { virgin_rate: 40 });
  assert.strictEqual(m.payable_status, 'not_payable');
  assert.strictEqual(m.total_due, 0);
});

test('replaced still beats cancelled', () => {
  const lead = { initial_status: 'accepted', search_status: 'virgin', cancelled: true, replaced_by_lead: 'someId' };
  const m = computeMoney(lead, { virgin_rate: 40 });
  assert.strictEqual(m.payable_status, 'replaced');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/moneyEngine.test.js`
Expected: FAIL — first test gets `payable_status: 'payable'`, `total_due: 40`.

- [ ] **Step 3: Implement** — in `backend/services/moneyEngine.js`, directly after `if (lead.signature_status === 'failed') …` (line 8):

```js
  if (lead.cancelled) return { ...zero, payable_status: 'not_payable' };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/moneyEngine.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/moneyEngine.js backend/tests/moneyEngine.test.js
git commit -m "feat: cancelled leads are not payable"
```

---

### Task 3: Status service — cancellation trigger, cancelled_at stamp, reason tagging

**Files:**
- Modify: `backend/services/statusService.js`
- Test: `backend/tests/statusService.test.js` (append)

**Interfaces:**
- Consumes: `computeMoney` (Task 2), Lead fields (Task 1).
- Produces: `'cancelled'` accepted in `UPDATABLE_FIELDS`; `applyStatusChanges` stamps `cancelled_at` once, opens the obligation with `replacement_reason: 'cooling_off'`, and stamps `replacement_reason: 'signature'` on the signature path. `needs_replacement` set for cancellations too.

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/statusService.test.js`:

```js
test('cooling-off cancellation opens an obligation with reason cooling_off and stamps cancelled_at once', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', search_status: 'virgin' }, rates, { source: 'import' });
  assert.strictEqual(lead.payable_status, 'payable');
  applyStatusChanges(lead, { cancelled: true }, rates, { source: 'webhook' });
  assert.strictEqual(lead.cancelled, true);
  assert.ok(lead.cancelled_at instanceof Date);
  assert.strictEqual(lead.replacement_status, 'required');
  assert.strictEqual(lead.replacement_reason, 'cooling_off');
  assert.ok(lead.replacement_requested_at instanceof Date);
  assert.strictEqual(lead.needs_replacement, true);
  assert.strictEqual(lead.payable_status, 'not_payable');
  assert.strictEqual(lead.amounts.total_due, 0);
  const firstStamp = lead.cancelled_at;
  const historyLen = lead.history.length;
  applyStatusChanges(lead, { cancelled: true }, rates, { source: 'import' });
  assert.strictEqual(lead.cancelled_at, firstStamp);
  assert.strictEqual(lead.history.length, historyLen);
});

test('signature failure stamps replacement_reason signature', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', signature_status: 'failed' }, rates, { source: 'webhook' });
  assert.strictEqual(lead.replacement_reason, 'signature');
});

test('first reason wins: cancellation after signature failure keeps reason signature', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', signature_status: 'failed' }, rates, { source: 'webhook' });
  const clock = lead.replacement_requested_at;
  applyStatusChanges(lead, { cancelled: true }, rates, { source: 'webhook' });
  assert.strictEqual(lead.replacement_reason, 'signature');
  assert.strictEqual(lead.replacement_requested_at, clock); // clock never resets
  assert.ok(lead.cancelled_at instanceof Date); // cancellation still recorded
});

test('first reason wins: signature failure after cancellation keeps reason cooling_off', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', cancelled: true }, rates, { source: 'webhook' });
  applyStatusChanges(lead, { signature_status: 'failed' }, rates, { source: 'webhook' });
  assert.strictEqual(lead.replacement_reason, 'cooling_off');
});

test('reason survives supplied transition', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', cancelled: true }, rates, { source: 'webhook' });
  lead.replaced_by_lead = 'someObjectId';
  applyStatusChanges(lead, {}, rates, { source: 'api' });
  assert.strictEqual(lead.replacement_status, 'supplied');
  assert.strictEqual(lead.replacement_reason, 'cooling_off');
});
```

Also update `freshLead()` in that file to include the new field defaults (matches Mongoose defaults):

```js
    cancelled: false,
    cancelled_at: undefined,
    replacement_reason: undefined,
```

And append this end-to-end variant test to `backend/tests/webhooks.test.js` (uses that file's existing `seedLead` helper):

```js
test('webhook cancellation payloads open a cooling-off obligation', async () => {
  for (const payload of [{ status: 'cancelled' }, { cancellation: 'cooling-off' }, { cancelled: true }]) {
    await clearDB();
    const { lead } = await seedLead();
    const res = await request(createApp())
      .post('/api/v1/webhooks/platform')
      .send({ ref: lead.ref, ...payload });
    assert.strictEqual(res.body.matched, true, JSON.stringify(payload));
    const updated = await Lead.findOne({ ref: lead.ref });
    assert.strictEqual(updated.cancelled, true, JSON.stringify(payload));
    assert.ok(updated.cancelled_at instanceof Date);
    assert.strictEqual(updated.replacement_status, 'required');
    assert.strictEqual(updated.replacement_reason, 'cooling_off');
    assert.strictEqual(updated.payable_status, 'not_payable');
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/statusService.test.js`
Expected: FAIL — `cancelled` isn't in `UPDATABLE_FIELDS`, so nothing changes.

- [ ] **Step 3: Implement** — in `backend/services/statusService.js`:

Add `'cancelled'` to `UPDATABLE_FIELDS` (after `'law_firm_confirmed'`):

```js
  'cancelled', // 14-day cooling-off; one-way from payloads, admin can undo manually
```

Replace the two trigger blocks (the `needs_replacement` block at lines 27-30 and the replacement-lifecycle block at lines 34-42) with:

```js
  // Cooling-off cancellation: stamp the notification date once, never reset.
  if (lead.cancelled && !lead.cancelled_at) {
    record('cancelled_at', null, now);
    lead.cancelled_at = now;
  }

  const obligationReason =
    lead.signature_status === 'failed' ? 'signature' : lead.cancelled ? 'cooling_off' : null;

  if (obligationReason && !lead.needs_replacement) {
    record('needs_replacement', false, true);
    lead.needs_replacement = true;
  }

  // Replacement lifecycle — own-lead transitions only. Cross-lead close/reopen
  // (replacement accepted/rejected) lives in replacementService.
  if (!lead.replacement_status) lead.replacement_status = 'none'; // plain objects / pre-backfill docs
  if (obligationReason && lead.replacement_status === 'none') {
    record('replacement_status', 'none', 'required');
    lead.replacement_status = 'required';
    if (!lead.replacement_reason) {
      record('replacement_reason', null, obligationReason);
      lead.replacement_reason = obligationReason; // first reason wins, never overwritten
    }
    if (!lead.replacement_requested_at) {
      record('replacement_requested_at', null, now);
      lead.replacement_requested_at = now; // 72h SLA clock — set once, never reset
    }
  }
```

(The `if (lead.replaced_by_lead …) → 'supplied'` block below it stays exactly as is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/statusService.test.js`
Expected: PASS — all existing + 5 new tests. Note the existing test "signature failure flags needs_replacement and zeroes money" must still pass unchanged.

- [ ] **Step 5: Run the full backend suite (choke-point change — check for ripples)**

Run: `cd backend && npm test`
Expected: PASS (84 + new). If `webhooks.test.js` or `ingest.test.js` fail, the trigger rework broke an invariant — fix before committing.

- [ ] **Step 6: Commit**

```bash
git add backend/services/statusService.js backend/tests/statusService.test.js backend/tests/webhooks.test.js
git commit -m "feat: cooling-off cancellation opens replacement obligation with reason tag"
```

---

### Task 4: Filters + replacements endpoint — reason param, supplied_or_closed, per-reason counts

**Files:**
- Modify: `backend/services/leadFilter.js`
- Modify: `backend/routes/replacementRoutes.js`
- Test: `backend/tests/replacements.test.js` (append), `backend/tests/leadRoutes.test.js` (append)

**Interfaces:**
- Consumes: Lead fields (Task 1), obligation triggers (Task 3).
- Produces: query params `replacement_reason=signature|cooling_off` (signature matches missing-reason legacy rows) and `replacement_status=supplied_or_closed` on every list/export endpoint (all go through `buildLeadFilter`); `GET /dashboard/replacements` rows gain `replacement_reason` (fallback-resolved) and counts gain `signature: {…}` / `cooling_off: {…}` sub-objects `{ required, supplied, closed, overdue }`.

- [ ] **Step 1: Write the failing tests.**

Append to `backend/tests/leadRoutes.test.js` (it already has `createApp`, `signToken`, seeded admin — follow the existing test setup in that file for auth token creation):

```js
test('leads list filters by replacement_reason with legacy signature fallback', async () => {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: {} });
  await Lead.create({ ref: 'KB-2026-000401', affiliate_id: aff._id, replacement_status: 'required', replacement_reason: 'cooling_off' });
  await Lead.create({ ref: 'KB-2026-000402', affiliate_id: aff._id, replacement_status: 'required', replacement_reason: 'signature' });
  await Lead.create({ ref: 'KB-2026-000403', affiliate_id: aff._id, replacement_status: 'supplied' }); // legacy, no reason
  await Lead.create({ ref: 'KB-2026-000404', affiliate_id: aff._id }); // no obligation

  const cooling = await request(app).get('/api/v1/dashboard/leads?replacement_reason=cooling_off').set(auth);
  assert.deepStrictEqual(cooling.body.rows.map((r) => r.ref), ['KB-2026-000401']);

  const sig = await request(app).get('/api/v1/dashboard/leads?replacement_reason=signature&replacement_status=supplied_or_closed').set(auth);
  assert.deepStrictEqual(sig.body.rows.map((r) => r.ref), ['KB-2026-000403']);
});
```

(Adapt `app`/`auth` to the file's existing helper names — every test in that file builds them the same way; reuse, don't reinvent.)

Append to `backend/tests/replacements.test.js` (same adaptation note):

```js
test('replacements endpoint returns per-reason counts and reason on rows', async () => {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: {} });
  await Lead.create({ ref: 'KB-2026-000501', affiliate_id: aff._id, replacement_status: 'required', replacement_reason: 'cooling_off', replacement_requested_at: new Date() });
  await Lead.create({ ref: 'KB-2026-000502', affiliate_id: aff._id, replacement_status: 'required', replacement_requested_at: new Date() }); // legacy → signature

  const res = await request(app).get('/api/v1/dashboard/replacements').set(auth);
  assert.strictEqual(res.body.counts.required, 2);
  assert.strictEqual(res.body.counts.cooling_off.required, 1);
  assert.strictEqual(res.body.counts.signature.required, 1);
  const reasons = Object.fromEntries(res.body.rows.map((r) => [r.ref, r.replacement_reason]));
  assert.strictEqual(reasons['KB-2026-000501'], 'cooling_off');
  assert.strictEqual(reasons['KB-2026-000502'], 'signature');

  const filtered = await request(app).get('/api/v1/dashboard/replacements?replacement_reason=cooling_off').set(auth);
  assert.deepStrictEqual(filtered.body.rows.map((r) => r.ref), ['KB-2026-000501']);
  assert.strictEqual(filtered.body.counts.required, 2); // counts ignore filters (existing behaviour)
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/leadRoutes.test.js tests/replacements.test.js`
Expected: FAIL — unknown params ignored, counts have no reason sub-objects.

- [ ] **Step 3: Implement.**

`backend/services/leadFilter.js` — extend the `replacement_status` block (lines 19-21):

```js
  if (['required', 'supplied', 'closed'].includes(query.replacement_status)) {
    filter.replacement_status = query.replacement_status;
  }
  // Anthony's payment list folds 'closed' into Supplied
  if (query.replacement_status === 'supplied_or_closed') {
    filter.replacement_status = { $in: ['supplied', 'closed'] };
  }
  // signature also matches legacy rows from before the reason existed
  // ($in with null matches missing fields)
  if (query.replacement_reason === 'signature') filter.replacement_reason = { $in: ['signature', null] };
  if (query.replacement_reason === 'cooling_off') filter.replacement_reason = 'cooling_off';
```

`backend/routes/replacementRoutes.js` — add `replacement_reason cancelled_at` to the `.select()` string, then replace the counts/rows block (lines 20-28) with:

```js
  const blank = () => ({ required: 0, supplied: 0, closed: 0, overdue: 0 });
  const counts = { ...blank(), signature: blank(), cooling_off: blank() };
  for (const l of leads) {
    const reason = l.replacement_reason || 'signature';
    counts[l.replacement_status] += 1;
    counts[reason][l.replacement_status] += 1;
    if (slaState(l)?.overdue) { counts.overdue += 1; counts[reason].overdue += 1; }
  }
  const status = req.query.replacement_status;
  const reasonFilter = req.query.replacement_reason;
  const rows = leads
    .filter((l) => (['required', 'supplied', 'closed'].includes(status) ? l.replacement_status === status : true))
    .filter((l) => (['signature', 'cooling_off'].includes(reasonFilter) ? (l.replacement_reason || 'signature') === reasonFilter : true))
    .map((l) => ({ ...l, replacement_reason: l.replacement_reason || 'signature', sla: slaState(l) }));
  res.json({ rows, counts });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/leadRoutes.test.js tests/replacements.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/leadFilter.js backend/routes/replacementRoutes.js backend/tests/leadRoutes.test.js backend/tests/replacements.test.js
git commit -m "feat: replacement_reason filtering + per-reason replacement counts"
```

---

### Task 5: CSV import field + export columns + statement split

**Files:**
- Modify: `backend/routes/importRoutes.js:16`
- Modify: `backend/routes/exportRoutes.js`
- Test: `backend/tests/export.test.js` (append), `backend/tests/imports.test.js` (append)

**Interfaces:**
- Consumes: normalizer `cancelled` (Task 1), choke-point trigger (Task 3).
- Produces: import mapping accepts a `cancelled` column; export `COLUMNS` gains `cancelled_at` and `replacement_reason` (after `replacement_sla`); statement XLSX has `— Signature` / `— 14 Day Cooling-Off` rows under `OUTSTANDING REPLACEMENTS`.

- [ ] **Step 1: Write the failing tests.**

Append to `backend/tests/imports.test.js` (reuse the file's existing app/auth/seed helpers):

```js
test('import with a cancelled column opens a cooling-off obligation', async () => {
  const { lead } = await seedLead(); // or the file's equivalent seeding helper
  const csv = `ref,cancelled\n${lead.ref},cooling-off\n`;
  const res = await request(app)
    .post('/api/v1/imports')
    .set(auth)
    .field('mapping', JSON.stringify({ match_by: 'ref', columns: { ref: 'ref', cancelled: 'cancelled' } }))
    .attach('file', Buffer.from(csv), 'cancel.csv');
  assert.strictEqual(res.body.matched, 1);
  const updated = await Lead.findById(lead._id);
  assert.strictEqual(updated.cancelled, true);
  assert.strictEqual(updated.replacement_status, 'required');
  assert.strictEqual(updated.replacement_reason, 'cooling_off');
});
```

Append to `backend/tests/export.test.js`:

```js
test('export includes cancelled_at and replacement_reason columns', async () => {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: {} });
  await Lead.create({
    ref: 'KB-2026-000601', affiliate_id: aff._id, cancelled: true, cancelled_at: new Date('2026-07-15T10:00:00Z'),
    replacement_status: 'required', replacement_reason: 'cooling_off',
  });
  await Lead.create({ ref: 'KB-2026-000602', affiliate_id: aff._id, replacement_status: 'required' }); // legacy
  const res = await request(app).get('/api/v1/dashboard/export.csv').set(auth);
  const [header, ...lines] = res.text.trim().split('\n');
  assert.ok(header.includes('cancelled_at') && header.includes('replacement_reason'));
  const row601 = lines.find((l) => l.includes('KB-2026-000601'));
  assert.ok(row601.includes('2026-07-15T10:00:00.000Z') && row601.includes('cooling_off'));
  const row602 = lines.find((l) => l.includes('KB-2026-000602'));
  assert.ok(row602.includes('signature')); // legacy fallback
});

test('statement splits outstanding replacements by reason', async () => {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: {} });
  await Lead.create({ ref: 'KB-2026-000603', affiliate_id: aff._id, submitted_at: new Date('2026-07-05'), replacement_status: 'required', replacement_reason: 'cooling_off' });
  await Lead.create({ ref: 'KB-2026-000604', affiliate_id: aff._id, submitted_at: new Date('2026-07-06'), replacement_status: 'required' });
  const res = await request(app).get(`/api/v1/dashboard/statement.xlsx?affiliate_id=${aff._id}&month=2026-07`).set(auth);
  assert.strictEqual(res.status, 200);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  const cells = [];
  wb.getWorksheet('Statement').eachRow((row) => cells.push([row.getCell(1).value, row.getCell(6).value]));
  assert.deepStrictEqual(cells.find(([a]) => a === 'OUTSTANDING REPLACEMENTS'), ['OUTSTANDING REPLACEMENTS', '2']);
  assert.deepStrictEqual(cells.find(([a]) => a === '— Signature'), ['— Signature', '1']);
  assert.deepStrictEqual(cells.find(([a]) => a === '— 14 Day Cooling-Off'), ['— 14 Day Cooling-Off', '1']);
});
```

(Column 6 = `applicant_name` — the statement writes count values into that key, matching the existing `OUTSTANDING REPLACEMENTS` row. Verify against the existing statement test in this file and adjust the cell index to match its style.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/imports.test.js tests/export.test.js`
Expected: FAIL — no `cancelled` in import fields, no new columns, no split rows.

- [ ] **Step 3: Implement.**

`backend/routes/importRoutes.js:16`:

```js
const STATUS_FIELDS = ['initial_status', 'search_status', 'signature_status', 'law_firm_confirmed', 'cancelled'];
```

`backend/routes/exportRoutes.js` — in `COLUMNS`, after `'replacement_sla',`:

```js
  'replacement_reason', 'cancelled_at',
```

In `fetchExportRows`'s row object, after `replacement_sla`:

```js
    replacement_reason:
      l.replacement_status && l.replacement_status !== 'none' ? l.replacement_reason || 'signature' : '',
    cancelled_at: l.cancelled_at?.toISOString() || '',
```

In the statement route, replace the outstanding block (lines 114-116):

```js
  const isCooling = (r) => r.replacement_reason === 'cooling_off';
  const outstanding = rows.filter((r) => r.replacement_status === 'required');
  const outRow = ws.addRow({ ref: 'OUTSTANDING REPLACEMENTS', applicant_name: String(outstanding.length) });
  outRow.font = { bold: true };
  ws.addRow({ ref: '— Signature', applicant_name: String(outstanding.filter((r) => !isCooling(r)).length) });
  ws.addRow({ ref: '— 14 Day Cooling-Off', applicant_name: String(outstanding.filter(isCooling).length) });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/imports.test.js tests/export.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/importRoutes.js backend/routes/exportRoutes.js backend/tests/imports.test.js backend/tests/export.test.js
git commit -m "feat: cancellation in CSV import + reason/cancelled_at export columns + statement split"
```

---

### Task 6: Backfill script — legacy obligations get reason=signature

**Files:**
- Create: `backend/scripts/backfillReplacementReason.js`
- Test: `backend/tests/backfillReplacementReason.test.js` (create)

**Interfaces:**
- Produces: `backfillReplacementReason()` (exported, returns count); CLI `node scripts/backfillReplacementReason.js` (connects via `config/db`, prints count, disconnects). Run once on prod at deploy time.

- [ ] **Step 1: Write the failing test** — create `backend/tests/backfillReplacementReason.test.js`:

```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const { backfillReplacementReason } = require('../scripts/backfillReplacementReason');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

test('stamps signature on legacy obligations only, idempotently', async () => {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: {} });
  const mk = (ref, extra) => Lead.create({ ref, affiliate_id: aff._id, ...extra });
  await mk('KB-2026-000701', { replacement_status: 'required' });   // legacy → signature
  await mk('KB-2026-000702', { replacement_status: 'closed' });     // legacy → signature
  await mk('KB-2026-000703', { replacement_status: 'required', replacement_reason: 'cooling_off' }); // keeps reason
  await mk('KB-2026-000704', {});                                   // no obligation → untouched

  assert.strictEqual(await backfillReplacementReason(), 2);
  assert.strictEqual((await Lead.findOne({ ref: 'KB-2026-000701' })).replacement_reason, 'signature');
  assert.strictEqual((await Lead.findOne({ ref: 'KB-2026-000702' })).replacement_reason, 'signature');
  assert.strictEqual((await Lead.findOne({ ref: 'KB-2026-000703' })).replacement_reason, 'cooling_off');
  assert.strictEqual((await Lead.findOne({ ref: 'KB-2026-000704' })).replacement_reason, undefined);
  assert.ok((await Lead.findOne({ ref: 'KB-2026-000701' })).history.some((h) => h.field === 'replacement_reason' && h.to === 'signature'));

  assert.strictEqual(await backfillReplacementReason(), 0); // idempotent
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/backfillReplacementReason.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `backend/scripts/backfillReplacementReason.js`:

```js
// One-shot, idempotent backfill (spec 2026-07-15): every pre-existing
// replacement obligation came from a signature failure — stamp it as such.
// Usage: node scripts/backfillReplacementReason.js
require('dotenv').config();
const mongoose = require('mongoose');
const Lead = require('../models/Lead');

async function backfillReplacementReason() {
  const candidates = await Lead.find({
    replacement_status: { $in: ['required', 'supplied', 'closed'] },
    replacement_reason: null, // matches missing too
  });
  for (const lead of candidates) {
    lead.replacement_reason = 'signature';
    lead.history.push({ at: new Date(), field: 'replacement_reason', from: null, to: 'signature', source: 'manual', user: 'backfill' });
    await lead.save();
  }
  return candidates.length;
}

if (require.main === module) {
  const { connectDB } = require('../config/db');
  (async () => {
    await connectDB();
    const n = await backfillReplacementReason();
    console.log(`backfilled replacement_reason=signature on ${n} lead(s)`);
    await mongoose.disconnect();
  })();
}

module.exports = { backfillReplacementReason };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/backfillReplacementReason.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/backfillReplacementReason.js backend/tests/backfillReplacementReason.test.js
git commit -m "feat: backfill script stamping legacy obligations as reason=signature"
```

---

### Task 7: StatusBadge — 8-option payment derivation + filter mapping

**Files:**
- Modify: `frontend/src/components/StatusBadge.jsx`

**Interfaces:**
- Consumes: lead objects with `payable_status`, `replacement_status`, `replacement_reason` from the API.
- Produces: `paymentStatus(lead)` → `{ label, color }` (exact copy from Global Constraints); `PAYMENT_FILTER_OPTIONS` (8 options, values `not_payable | payable | partial_pending_confirmation | payable_full | replacement_required_signature | replacement_supplied_signature | replacement_required_cooling_off | replacement_supplied_cooling_off`); `paymentFilterToParams(value)` maps replacement values to `{ replacement_status: 'required' | 'supplied_or_closed', replacement_reason: 'signature' | 'cooling_off' }`. Existing `LABELS` and default `StatusBadge` export unchanged (drawer badges still use them).

- [ ] **Step 1: Implement** — in `frontend/src/components/StatusBadge.jsx`, add after the `LABELS` export:

```js
// Anthony's 8-option Payment Status (spec 2026-07-15). Replacement labels win
// over money labels while an obligation exists; 'closed' renders as Supplied;
// missing reason (legacy) = Signature.
export function paymentStatus(l) {
  const reason = l.replacement_reason === 'cooling_off' ? '14 Day Cooling-Off' : 'Signature';
  if (l.replacement_status === 'required') return { label: `Replacement Required – ${reason}`, color: 'red' };
  if (['supplied', 'closed'].includes(l.replacement_status)) return { label: `Replacement Supplied – ${reason}`, color: 'blue' };
  if (l.payable_status === 'payable') return { label: 'Payable (100%)', color: 'green' };
  if (l.payable_status === 'partial_pending_confirmation') return { label: 'Part-paid – Awaiting Law Firm', color: 'orange' };
  if (l.payable_status === 'payable_full') return { label: 'Payable in Full', color: 'green' };
  return { label: 'Not Payable', color: 'gray' };
}
```

Replace `PAYMENT_FILTER_OPTIONS` and `paymentFilterToParams` with:

```js
export const PAYMENT_FILTER_OPTIONS = [
  { value: 'not_payable', label: 'Not Payable' },
  { value: 'payable', label: 'Payable (100%)' },
  { value: 'partial_pending_confirmation', label: 'Part-paid – Awaiting Law Firm' },
  { value: 'payable_full', label: 'Payable in Full' },
  { value: 'replacement_required_signature', label: 'Replacement Required – Signature' },
  { value: 'replacement_supplied_signature', label: 'Replacement Supplied – Signature' },
  { value: 'replacement_required_cooling_off', label: 'Replacement Required – 14 Day Cooling-Off' },
  { value: 'replacement_supplied_cooling_off', label: 'Replacement Supplied – 14 Day Cooling-Off' },
];
export function paymentFilterToParams(value) {
  if (!value) return {};
  if (value.startsWith('replacement_')) {
    return {
      replacement_status: value.includes('required') ? 'required' : 'supplied_or_closed',
      replacement_reason: value.endsWith('cooling_off') ? 'cooling_off' : 'signature',
    };
  }
  return { payable_status: value };
}
```

- [ ] **Step 2: Verify the frontend builds**

Run: `cd frontend && npm run build`
Expected: build succeeds (Leads/ExportPage still import the same names).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/StatusBadge.jsx
git commit -m "feat: 8-option payment status derivation and filter mapping"
```

---

### Task 8: Leads page — payment column + drawer cancellation display/switch

**Files:**
- Modify: `frontend/src/pages/Leads.jsx`

**Interfaces:**
- Consumes: `paymentStatus` from Task 7 (add to the existing StatusBadge import); lead fields `cancelled`, `cancelled_at`.
- Produces: table Payment column renders the 8 labels; admin drawer switch PATCHes `{ cancelled: boolean }`.

- [ ] **Step 1: Implement.**

Import (line 9): add `paymentStatus`:

```js
import StatusBadge, { PAYMENT_FILTER_OPTIONS, paymentFilterToParams, paymentStatus } from '../components/StatusBadge';
```

Table payment cell (line 138) — replace `<Table.Td><StatusBadge field="payable_status" value={l.payable_status} /></Table.Td>` with:

```js
              <Table.Td>
                {(() => { const p = paymentStatus(l); return <Badge color={p.color} variant="light">{p.label}</Badge>; })()}
              </Table.Td>
```

Payment filter Select (line 97): widen `w={230}` → `w={300}` (new labels are longer).

Drawer — after the "Submitted … Signature deadline …" `<Text>` (line 174), add:

```js
            {selected.cancelled && (
              <Alert color="red" p="xs">
                14-day cooling-off cancellation
                {selected.cancelled_at ? ` — notified ${dayjs(selected.cancelled_at).format('DD MMM YYYY HH:mm')}` : ''}
              </Alert>
            )}
```

Drawer admin controls — in the `<Group grow align="end">` containing the law-firm switch (line 198), add after the possible-duplicate switch:

```js
                  <Switch label="Cooling-off cancelled" checked={edit.cancelled ?? selected.cancelled ?? false} onChange={(ev) => setEdit((e) => ({ ...e, cancelled: ev.currentTarget.checked }))} />
```

- [ ] **Step 2: Verify the frontend builds**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Leads.jsx
git commit -m "feat: Leads page 8-option payment labels + cooling-off drawer controls"
```

---

### Task 9: Replacements page — reason badge, reason filter, per-reason counts, Triggered header

**Files:**
- Modify: `frontend/src/pages/Replacements.jsx`

**Interfaces:**
- Consumes: endpoint rows with `replacement_reason` + counts with `signature`/`cooling_off` sub-objects (Task 4).
- Produces: visible reason column and per-reason stat breakdowns.

- [ ] **Step 1: Implement.**

Extend `Stat` to take an optional breakdown line:

```js
function Stat({ label, value, detail, accent = 'var(--mantine-color-emerald-5)' }) {
  return (
    <Card withBorder p="md" style={{ borderLeft: `3px solid ${accent}` }}>
      <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
      <Text fz={24} fw={700}>{value}</Text>
      {detail && <Text size="xs" c="dimmed">{detail}</Text>}
    </Card>
  );
}
```

Add a reason state + default counts shape. Initial state (line 27) becomes:

```js
  const blank = { required: 0, supplied: 0, closed: 0, overdue: 0 };
  const [data, setData] = useState({ rows: [], counts: { ...blank, signature: blank, cooling_off: blank } });
```

Add `const [reason, setReason] = useState(null);` beside `status`, include it in the fetch params (`if (reason) params.set('replacement_reason', reason);`) and in the effect deps (`[status, reason, affiliateId, refreshKey]`).

Stat cards — add per-reason detail (guard against a stale API during rolling deploy):

```js
      <SimpleGrid cols={{ base: 2, md: 4 }} mb="lg">
        {['required', 'supplied', 'closed', 'overdue'].map((k) => (
          <Stat key={k} label={k} value={counts[k]}
            detail={counts.signature ? `${counts.signature[k]} sig / ${counts.cooling_off[k]} cooling-off` : undefined}
            accent={{ required: 'var(--mantine-color-red-6)', supplied: 'var(--mantine-color-blue-6)', closed: 'var(--mantine-color-green-6)', overdue: 'var(--mantine-color-red-9)' }[k]} />
        ))}
      </SimpleGrid>
```

(The `label` prop is rendered uppercase by the existing `tt="uppercase"`, so lowercase keys are fine.)

Reason filter Select next to the status Select:

```js
        <Select placeholder="Reason" clearable w={190}
          data={[
            { value: 'signature', label: 'Signature' },
            { value: 'cooling_off', label: '14 Day Cooling-Off' },
          ]}
          value={reason} onChange={setReason} />
```

Table: rename the `<Table.Th>Signature failed</Table.Th>` header to `Triggered`, and add a Reason column header after it: `<Table.Th>Reason</Table.Th>`. In the body, after the triggered-date cell, add:

```js
              <Table.Td>
                <Badge color={l.replacement_reason === 'cooling_off' ? 'grape' : 'red'} variant="outline">
                  {l.replacement_reason === 'cooling_off' ? '14-Day Cooling-Off' : 'Signature'}
                </Badge>
              </Table.Td>
```

- [ ] **Step 2: Verify the frontend builds**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Replacements.jsx
git commit -m "feat: Replacements page reason badges, filter and per-reason counts"
```

---

### Task 10: Remove the API docs page

**Files:**
- Delete: `frontend/src/pages/ApiDocs.jsx`
- Modify: `frontend/src/App.jsx`

- [ ] **Step 1: Implement.** In `frontend/src/App.jsx`: remove the `import ApiDocs …` line (11), the `'/docs': IconCode,` entry (20) and `IconCode` from the tabler import (3), the `{ to: '/docs', label: 'API docs' },` link (35), and the `/docs` Route (76). Then:

```bash
rm frontend/src/pages/ApiDocs.jsx
```

- [ ] **Step 2: Verify no dangling references and the build passes**

Run: `grep -rn "ApiDocs\|'/docs'" frontend/src/ ; cd frontend && npm run build`
Expected: grep finds nothing; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add -A frontend/src
git commit -m "feat: remove API docs page (law firm distributes API documentation)"
```

---

### Task 11: Full regression + build

- [ ] **Step 1: Run the complete backend suite**

Run: `cd backend && npm test`
Expected: PASS — 84 pre-existing + all new tests, zero failures.

- [ ] **Step 2: Production frontend build**

Run: `cd frontend && npm run build`
Expected: clean build.

- [ ] **Step 3: Commit anything outstanding** (there should be nothing — if `git status` shows changes, investigate before committing).

**Not in this plan (deliberately):** deployment. Deploy per spec §7 when the user asks: rsync → npm install → build → pm2 restart pcp-affiliate-api → `node scripts/backfillReplacementReason.js` on prod → purge CF cache → live-verify.
