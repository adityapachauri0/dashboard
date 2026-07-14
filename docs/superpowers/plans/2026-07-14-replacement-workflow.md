# Replacement Obligations Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track replacement obligations to BlueLion as a first-class lifecycle (`required → supplied → closed`) with a 72h SLA countdown, a Replacements page, reconciliation columns, and relabelled payment filters.

**Architecture:** Two new fields on `Lead` (`replacement_status`, `replacement_requested_at`), own-lead transitions inside the existing `statusService.applyStatusChanges` choke point, cross-lead close/reopen in a new `replacementService.propagateReplacementOutcome` called by the four routes that mutate lead status. SLA is always derived (`requested_at + 72h`), never stored. Spec: `docs/superpowers/specs/2026-07-14-replacement-workflow-design.md`.

**Tech Stack:** Node/Express CommonJS, Mongoose, node:test + supertest + mongodb-memory-server (backend); React/Vite/Mantine 7 + dayjs (frontend). No new dependencies.

## Global Constraints

- Working directory: `~/Desktop/pcp-affiliate-dashboard`. Backend tests: `cd backend && npm test` (runs `node --test tests/*.test.js`). Currently 65 passing — must stay green.
- Enum values exactly: `replacement_status: 'none' | 'required' | 'supplied' | 'closed'`. SLA constant: `SLA_HOURS = 72`.
- Every status mutation goes through `applyStatusChanges` or records to `lead.history` with `{ at, field, from, to, source, user }` — `source` must be one of `'api' | 'webhook' | 'import' | 'manual'`.
- The money engine (`backend/services/moneyEngine.js`) is NOT modified.
- UI copy: "Replacement required", "Replacement supplied" — the word "replaced" must not appear in any user-facing label after this work.
- Frontend has no unit tests; frontend tasks are verified with `cd frontend && npm run build` (must exit 0).
- Commit after every task (messages given per task).

---

### Task 1: Lead model fields

**Files:**
- Modify: `backend/models/Lead.js` (after `needs_replacement`, line ~36)
- Test: `backend/tests/models.test.js` (append)

**Interfaces:**
- Produces: `lead.replacement_status` (String enum, default `'none'`, indexed), `lead.replacement_requested_at` (Date, optional). All later tasks rely on these exact names.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/models.test.js`:

```js
test('lead has replacement lifecycle fields with safe defaults', async () => {
  const aff = await Affiliate.create({ name: 'R', lead_source: 'rrr' });
  const lead = await Lead.create({ ref: 'KB-2026-900001', affiliate_id: aff._id });
  assert.strictEqual(lead.replacement_status, 'none');
  assert.strictEqual(lead.replacement_requested_at, undefined);
  await assert.rejects(
    Lead.create({ ref: 'KB-2026-900002', affiliate_id: aff._id, replacement_status: 'bogus' }),
    /replacement_status/
  );
});
```

(If `models.test.js` doesn't already import `Affiliate`, add `const Affiliate = require('../models/Affiliate');` alongside the existing requires.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/models.test.js`
Expected: FAIL — `replacement_status` is `undefined`, not `'none'`.

- [ ] **Step 3: Implement** — in `backend/models/Lead.js`, directly after the `needs_replacement` line:

```js
    // Replacement obligation lifecycle (spec 2026-07-14). SLA deadline is always
    // derived as replacement_requested_at + 72h — never stored.
    replacement_status: {
      type: String,
      enum: ['none', 'required', 'supplied', 'closed'],
      default: 'none',
      index: true,
    },
    replacement_requested_at: Date,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/models.test.js`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add backend/models/Lead.js backend/tests/models.test.js
git commit -m "feat: replacement_status + replacement_requested_at on Lead"
```

---

### Task 2: Own-lead lifecycle transitions in statusService

**Files:**
- Modify: `backend/services/statusService.js` (inside `applyStatusChanges`, after the `needs_replacement` rule at line ~30)
- Test: `backend/tests/statusService.test.js` (append)

**Interfaces:**
- Consumes: Task 1 fields.
- Produces: `applyStatusChanges` guarantees — signature failure sets `replacement_status='required'` + `replacement_requested_at` (once, never reset); a linked `replaced_by_lead` moves `'none'|'required'` → `'supplied'`. Both recorded in history.

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/statusService.test.js` (note: `freshLead()` there returns a plain object without `replacement_status`; the implementation must normalise a missing value to `'none'`):

```js
test('signature failure opens a replacement obligation and starts the 72h clock', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', search_status: 'virgin' }, rates, { source: 'import' });
  applyStatusChanges(lead, { signature_status: 'failed' }, rates, { source: 'webhook' });
  assert.strictEqual(lead.replacement_status, 'required');
  assert.ok(lead.replacement_requested_at instanceof Date);
  assert.strictEqual(lead.payable_status, 'not_payable');
  const fields = lead.history.map((h) => h.field);
  assert.ok(fields.includes('replacement_status'));
  assert.ok(fields.includes('replacement_requested_at'));
});

test('re-applying a failed signature does not reset the clock or duplicate history', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', signature_status: 'failed' }, rates, { source: 'webhook' });
  const firstClock = lead.replacement_requested_at;
  const historyLen = lead.history.length;
  applyStatusChanges(lead, { signature_status: 'failed' }, rates, { source: 'import' });
  assert.strictEqual(lead.replacement_requested_at, firstClock);
  assert.strictEqual(lead.history.length, historyLen);
});

test('linking a replacement moves the original to supplied', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', signature_status: 'failed' }, rates, { source: 'webhook' });
  lead.replaced_by_lead = 'someObjectId'; // linking is done by the route; choke point reacts
  applyStatusChanges(lead, {}, rates, { source: 'api' });
  assert.strictEqual(lead.replacement_status, 'supplied');
  assert.strictEqual(lead.payable_status, 'replaced');
});

test('a linked lead that was never required still becomes supplied (pre-feature data)', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', search_status: 'virgin' }, rates, { source: 'import' });
  lead.replaced_by_lead = 'someObjectId';
  applyStatusChanges(lead, {}, rates, { source: 'manual' });
  assert.strictEqual(lead.replacement_status, 'supplied');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/statusService.test.js`
Expected: FAIL — `replacement_status` stays `undefined`.

- [ ] **Step 3: Implement** — in `backend/services/statusService.js`, insert directly after the `needs_replacement` block (after line `lead.needs_replacement = true; }`):

```js
  // Replacement lifecycle — own-lead transitions only. Cross-lead close/reopen
  // (replacement accepted/rejected) lives in replacementService.
  if (!lead.replacement_status) lead.replacement_status = 'none'; // plain objects / pre-backfill docs
  if (lead.signature_status === 'failed' && lead.replacement_status === 'none') {
    record('replacement_status', 'none', 'required');
    lead.replacement_status = 'required';
    if (!lead.replacement_requested_at) {
      record('replacement_requested_at', null, now);
      lead.replacement_requested_at = now; // 72h SLA clock — set once, never reset
    }
  }
  if (lead.replaced_by_lead && ['none', 'required'].includes(lead.replacement_status)) {
    record('replacement_status', lead.replacement_status, 'supplied');
    lead.replacement_status = 'supplied';
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/statusService.test.js`
Expected: PASS. Then run the full suite: `npm test` — all green (existing tests unaffected: they never set `signature_status: 'failed'` with assertions on history length except via their own flows).

- [ ] **Step 5: Commit**

```bash
git add backend/services/statusService.js backend/tests/statusService.test.js
git commit -m "feat: replacement lifecycle transitions in status choke point"
```

---

### Task 3: replacementService — SLA derivation + cross-lead propagation

**Files:**
- Create: `backend/services/replacementService.js`
- Test: `backend/tests/replacementService.test.js` (new, DB-backed)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `SLA_HOURS` (number, 72)
  - `slaState(lead, now = new Date())` → `null` unless `replacement_status === 'required'` with a `replacement_requested_at`; else `{ deadline: Date, overdue: boolean, hours_remaining: number, label: string }` where `label` is `'OVERDUE'` or `` `${h}h remaining` ``.
  - `async propagateReplacementOutcome(lead, meta)` → the updated original Lead doc or `null`. Call after saving any lead whose `initial_status` may have changed.

- [ ] **Step 1: Write the failing tests** — create `backend/tests/replacementService.test.js`:

```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const { slaState, propagateReplacementOutcome, SLA_HOURS } = require('../services/replacementService');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

const HOUR = 3600 * 1000;

test('slaState derives countdown, overdue and null cases', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const fresh = { replacement_status: 'required', replacement_requested_at: new Date(now - 5 * HOUR) };
  const s = slaState(fresh, now);
  assert.strictEqual(s.overdue, false);
  assert.strictEqual(s.hours_remaining, SLA_HOURS - 5);
  assert.strictEqual(s.label, `${SLA_HOURS - 5}h remaining`);
  const old = { replacement_status: 'required', replacement_requested_at: new Date(now - 80 * HOUR) };
  assert.strictEqual(slaState(old, now).overdue, true);
  assert.strictEqual(slaState(old, now).label, 'OVERDUE');
  assert.strictEqual(slaState({ replacement_status: 'supplied', replacement_requested_at: new Date() }, now), null);
  assert.strictEqual(slaState({ replacement_status: 'required' }, now), null);
});

async function seedPair() {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: { virgin_rate: 40 } });
  const original = await Lead.create({
    ref: 'KB-2026-000001', affiliate_id: aff._id, initial_status: 'accepted',
    signature_status: 'failed', needs_replacement: true, payable_status: 'not_payable',
    replacement_status: 'required', replacement_requested_at: new Date('2026-07-10T10:00:00Z'),
  });
  const replacement = await Lead.create({
    ref: 'KB-2026-000002', affiliate_id: aff._id, initial_status: 'pending',
    replaces_lead: original._id,
  });
  original.replaced_by_lead = replacement._id;
  original.replacement_status = 'supplied';
  original.payable_status = 'replaced';
  await original.save();
  return { original, replacement };
}

test('replacement accepted closes the original', async () => {
  const { original, replacement } = await seedPair();
  replacement.initial_status = 'accepted';
  const updated = await propagateReplacementOutcome(replacement, { source: 'webhook' });
  assert.strictEqual(updated.replacement_status, 'closed');
  assert.strictEqual(String(updated._id), String(original._id));
  assert.ok(updated.history.some((h) => h.field === 'replacement_status' && h.to === 'closed'));
});

test('replacement rejected reopens the original without resetting the clock', async () => {
  const { original, replacement } = await seedPair();
  replacement.initial_status = 'rejected';
  const updated = await propagateReplacementOutcome(replacement, { source: 'webhook' });
  assert.strictEqual(updated.replacement_status, 'required');
  assert.strictEqual(updated.replaced_by_lead, null);
  assert.strictEqual(updated.replacement_requested_at.toISOString(), '2026-07-10T10:00:00.000Z');
  assert.strictEqual(updated.payable_status, 'not_payable'); // money recomputed — no longer 'replaced'
  assert.ok(updated.history.some((h) => h.field === 'replaced_by_lead' && h.to === null));
});

test('a stale replacement (original re-linked elsewhere) is a no-op', async () => {
  const { original, replacement } = await seedPair();
  const other = await Lead.create({ ref: 'KB-2026-000003', affiliate_id: original.affiliate_id });
  original.replaced_by_lead = other._id;
  await original.save();
  replacement.initial_status = 'accepted';
  assert.strictEqual(await propagateReplacementOutcome(replacement, { source: 'webhook' }), null);
});

test('pending replacement and non-replacement leads are no-ops', async () => {
  const { replacement } = await seedPair();
  assert.strictEqual(await propagateReplacementOutcome(replacement, { source: 'api' }), null); // still pending
  const plain = await Lead.create({ ref: 'KB-2026-000009', affiliate_id: replacement.affiliate_id, initial_status: 'accepted' });
  assert.strictEqual(await propagateReplacementOutcome(plain, { source: 'api' }), null); // no replaces_lead
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/replacementService.test.js`
Expected: FAIL — `Cannot find module '../services/replacementService'`.

- [ ] **Step 3: Implement** — create `backend/services/replacementService.js`:

```js
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const { applyStatusChanges } = require('./statusService');

const SLA_HOURS = 72;
const HOUR = 3600 * 1000;

// SLA is derived, never stored: contract gives 72h from the replacement request
// (= signature-failed event) to supply the replacement.
function slaState(lead, now = new Date()) {
  if (lead.replacement_status !== 'required' || !lead.replacement_requested_at) return null;
  const deadline = new Date(new Date(lead.replacement_requested_at).getTime() + SLA_HOURS * HOUR);
  const overdue = now > deadline;
  const hours_remaining = overdue ? 0 : Math.floor((deadline - now) / HOUR);
  return { deadline, overdue, hours_remaining, label: overdue ? 'OVERDUE' : `${hours_remaining}h remaining` };
}

// Cross-lead transition: a replacement lead's acceptance closes the original's
// obligation; its rejection reopens it (link cleared, clock unchanged).
// Call after saving any lead whose initial_status may have changed.
async function propagateReplacementOutcome(lead, meta = {}) {
  if (!lead.replaces_lead || lead.initial_status === 'pending') return null;
  const original = await Lead.findById(lead.replaces_lead);
  // only the CURRENT replacement may affect the original (stale/rejected ones can't)
  if (!original || String(original.replaced_by_lead) !== String(lead._id)) return null;

  const now = new Date();
  const rec = (field, from, to) =>
    original.history.push({ at: now, field, from, to, source: meta.source || 'webhook', user: meta.user });

  if (lead.initial_status === 'accepted') {
    if (original.replacement_status === 'closed') return null;
    rec('replacement_status', original.replacement_status, 'closed');
    original.replacement_status = 'closed';
  } else if (lead.initial_status === 'rejected') {
    rec('replaced_by_lead', lead.ref, null);
    original.replaced_by_lead = null;
    rec('replacement_status', original.replacement_status, 'required');
    original.replacement_status = 'required'; // replacement_requested_at intentionally untouched
  } else {
    return null;
  }

  const affiliate = await Affiliate.findById(original.affiliate_id);
  applyStatusChanges(original, {}, affiliate?.rate_card || {}, meta); // money recompute + payable history
  await original.save();
  return original;
}

module.exports = { SLA_HOURS, slaState, propagateReplacementOutcome };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/replacementService.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/replacementService.js backend/tests/replacementService.test.js
git commit -m "feat: replacementService — SLA derivation + close/reopen propagation"
```

---

### Task 4: Wire propagation into the four status-mutating routes

**Files:**
- Modify: `backend/routes/webhookRoutes.js` (`applyEventToLead`, line ~22)
- Modify: `backend/routes/importRoutes.js` (after `await lead.save()`, line ~65)
- Modify: `backend/routes/leadRoutes.js` (PATCH handler, after `await lead.save()`)
- Modify: `backend/routes/leadIngest.js` (after `await lead.save()`, line ~93)
- Test: `backend/tests/webhooks.test.js`, `backend/tests/ingest.test.js` (append)

**Interfaces:**
- Consumes: `propagateReplacementOutcome(lead, meta)` from Task 3.

- [ ] **Step 1: Write the failing tests.** Append to `backend/tests/webhooks.test.js` (reuse that file's existing seeding helpers/conventions — it already creates affiliates and leads and POSTs to `/api/v1/webhooks/platform`; the payload shape below relies on `canonicalFromPayload` mapping `status: 'accepted'|'rejected'` to `initial_status`, which the existing webhook tests demonstrate — copy the exact payload field names used there):

```js
test('webhook accepting a replacement lead closes the original obligation', async () => {
  const aff = await Affiliate.create({ name: 'W', lead_source: 'www', rate_card: { virgin_rate: 40 } });
  const original = await Lead.create({
    ref: 'KB-2026-000031', affiliate_id: aff._id, initial_status: 'accepted', signature_status: 'failed',
    needs_replacement: true, replacement_status: 'required', replacement_requested_at: new Date(),
  });
  const repl = await Lead.create({ ref: 'KB-2026-000032', affiliate_id: aff._id, replaces_lead: original._id });
  original.replaced_by_lead = repl._id;
  original.replacement_status = 'supplied';
  await original.save();

  const res = await request(createApp())
    .post(`/api/v1/webhooks/platform?token=${process.env.WEBHOOK_TOKEN || ''}`)
    .send({ ref: 'KB-2026-000032', status: 'accepted' });
  assert.strictEqual(res.status, 200);
  const after = await Lead.findById(original._id);
  assert.strictEqual(after.replacement_status, 'closed');
});

test('webhook rejecting a replacement lead reopens the original obligation', async () => {
  const aff = await Affiliate.create({ name: 'W2', lead_source: 'ww2', rate_card: { virgin_rate: 40 } });
  const original = await Lead.create({
    ref: 'KB-2026-000033', affiliate_id: aff._id, initial_status: 'accepted', signature_status: 'failed',
    needs_replacement: true, replacement_status: 'required', replacement_requested_at: new Date('2026-07-10T10:00:00Z'),
  });
  const repl = await Lead.create({ ref: 'KB-2026-000034', affiliate_id: aff._id, replaces_lead: original._id });
  original.replaced_by_lead = repl._id;
  original.replacement_status = 'supplied';
  await original.save();

  await request(createApp())
    .post(`/api/v1/webhooks/platform?token=${process.env.WEBHOOK_TOKEN || ''}`)
    .send({ ref: 'KB-2026-000034', status: 'rejected', rejection_reason: 'duplicate claim' });
  const after = await Lead.findById(original._id);
  assert.strictEqual(after.replacement_status, 'required');
  assert.strictEqual(after.replaced_by_lead, null);
  assert.strictEqual(after.replacement_requested_at.toISOString(), '2026-07-10T10:00:00.000Z');
});
```

Append to `backend/tests/ingest.test.js` (uses that file's existing `makeAffiliate()` helper, which returns `{ aff, key }` with a rate card and API key):

```js
test('ingesting a replacement marks the original supplied', async () => {
  const { key } = await makeAffiliate('repl1');
  const app = createApp();
  const first = await request(app).post('/api/v1/leads').set('X-API-Key', key)
    .send({ first_name: 'Orig', last_name: 'Lead', email: 'orig@x.com' });
  const original = await Lead.findOne({ ref: first.body.ref });
  original.initial_status = 'accepted';
  original.signature_status = 'failed';
  original.needs_replacement = true;
  original.replacement_status = 'required';
  original.replacement_requested_at = new Date();
  await original.save();

  const res = await request(app).post('/api/v1/leads').set('X-API-Key', key)
    .send({ first_name: 'Repl', last_name: 'Lead', email: 'repl@x.com', replaces_ref: first.body.ref });
  assert.strictEqual(res.status, 201);
  const after = await Lead.findOne({ ref: first.body.ref });
  assert.strictEqual(after.replacement_status, 'supplied');
  assert.strictEqual(after.payable_status, 'replaced');
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd backend && node --test tests/webhooks.test.js tests/ingest.test.js`
Expected: new tests FAIL (`replacement_status` stays `'supplied'` after webhook; ingest test fails only if the choke-point rule from Task 2 somehow didn't fire — it should actually pass already since Task 2 handles the supplied transition; if it passes, keep it as a regression guard).

- [ ] **Step 3: Implement.** Four one-line-plus-import edits:

`backend/routes/webhookRoutes.js` — add to requires: `const { propagateReplacementOutcome } = require('../services/replacementService');`, and in `applyEventToLead` after `await lead.save();`:

```js
  await propagateReplacementOutcome(lead, { source: 'webhook' });
```

`backend/routes/importRoutes.js` — same require; after the `await lead.save();` that follows `applyStatusChanges(lead, changes, ...)` (line ~65):

```js
    await propagateReplacementOutcome(lead, { source: 'import', user: req.user.email });
```

`backend/routes/leadRoutes.js` — same require; in the PATCH handler after `await lead.save();`:

```js
  await propagateReplacementOutcome(lead, meta);
```

`backend/routes/leadIngest.js` — same require; after `await lead.save();` (line ~93):

```js
  if (platformResponse) await propagateReplacementOutcome(lead, { source: 'api' });
```

- [ ] **Step 4: Run the full suite**

Run: `cd backend && npm test`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/webhookRoutes.js backend/routes/importRoutes.js backend/routes/leadRoutes.js backend/routes/leadIngest.js backend/tests/webhooks.test.js backend/tests/ingest.test.js
git commit -m "feat: propagate replacement outcome from all status-mutation routes"
```

---

### Task 5: leadFilter — replacement_status and next_update params

**Files:**
- Modify: `backend/services/leadFilter.js`
- Test: `backend/tests/export.test.js` (append — the filter is exercised through the export route, matching how this codebase tests filters)

**Interfaces:**
- Produces: query params `replacement_status` (`required|supplied|closed`) and `next_update` (`awaiting_confirmation|replacement_required|complete`) usable on every list/stats/export endpoint.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/export.test.js` (reuse its existing seed/auth conventions):

```js
test('replacement_status and next_update filters narrow the export', async () => {
  const aff = await Affiliate.create({ name: 'F', lead_source: 'fff' });
  const admin = await User.create({ email: 'f@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  await Lead.create({ ref: 'KB-2026-000041', affiliate_id: aff._id, initial_status: 'accepted', signature_status: 'failed', replacement_status: 'required', replacement_requested_at: new Date() });
  await Lead.create({ ref: 'KB-2026-000042', affiliate_id: aff._id, initial_status: 'accepted', payable_status: 'payable' });
  await Lead.create({ ref: 'KB-2026-000043', affiliate_id: aff._id, initial_status: 'accepted', payable_status: 'partial_pending_confirmation' });

  const auth = ['Authorization', `Bearer ${signToken(admin)}`];
  let res = await request(createApp()).get('/api/v1/dashboard/export.csv?replacement_status=required').set(...auth);
  assert.ok(res.text.includes('KB-2026-000041'));
  assert.ok(!res.text.includes('KB-2026-000042'));

  res = await request(createApp()).get('/api/v1/dashboard/export.csv?next_update=replacement_required').set(...auth);
  assert.ok(res.text.includes('KB-2026-000041'));
  assert.ok(!res.text.includes('KB-2026-000043'));

  res = await request(createApp()).get('/api/v1/dashboard/export.csv?next_update=awaiting_confirmation').set(...auth);
  assert.ok(res.text.includes('KB-2026-000043'));
  assert.ok(!res.text.includes('KB-2026-000041'));

  res = await request(createApp()).get('/api/v1/dashboard/export.csv?next_update=complete').set(...auth);
  assert.ok(res.text.includes('KB-2026-000042'));
  assert.ok(!res.text.includes('KB-2026-000041'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/export.test.js`
Expected: FAIL — unknown params are ignored, so the first assertion set sees both refs.

- [ ] **Step 3: Implement** — in `backend/services/leadFilter.js`, after the `needs_replacement` line:

```js
  if (['required', 'supplied', 'closed'].includes(query.replacement_status)) {
    filter.replacement_status = query.replacement_status;
  }
  // "Next update" mirrors the Leads-page column: what is this lead waiting on?
  if (query.next_update === 'awaiting_confirmation') filter.payable_status = 'partial_pending_confirmation';
  if (query.next_update === 'replacement_required') filter.replacement_status = 'required';
  if (query.next_update === 'complete') {
    // nothing pending: payable now, or the obligation fully closed
    filter.$and = [
      ...(filter.$and || []),
      { $or: [{ payable_status: { $in: ['payable', 'payable_full'] } }, { replacement_status: 'closed' }] },
    ];
  }
```

(`$and` wrapping keeps it compatible with the free-text `q` filter, which already uses top-level `$or`.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && node --test tests/export.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/leadFilter.js backend/tests/export.test.js
git commit -m "feat: replacement_status + next_update lead filters"
```

---

### Task 6: GET /dashboard/replacements endpoint

**Files:**
- Create: `backend/routes/replacementRoutes.js`
- Modify: `backend/server.js` (mount after statsRoutes, line ~18)
- Test: `backend/tests/replacements.test.js` (new)

**Interfaces:**
- Consumes: `buildLeadFilter`, `slaState`.
- Produces: `GET /api/v1/dashboard/replacements?replacement_status=&affiliate_id=` → `{ rows: [{ _id, ref, affiliate_id: {name}, submitted_at, signature_status, replacement_status, replacement_requested_at, replaced_by_lead: {ref}|null, sla }], counts: { required, supplied, closed, overdue } }`. Counts are all-time and ignore the status filter; rows respect it. Affiliate JWTs are pinned to their own leads.

- [ ] **Step 1: Write the failing test** — create `backend/tests/replacements.test.js`:

```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const { signToken } = require('../middleware/auth');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

const HOUR = 3600 * 1000;

async function seed() {
  const affA = await Affiliate.create({ name: 'A', lead_source: 'aaa' });
  const affB = await Affiliate.create({ name: 'B', lead_source: 'bbb' });
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const affUser = await User.create({ email: 'a@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: affA._id });
  await Lead.create({ ref: 'KB-2026-000051', affiliate_id: affA._id, signature_status: 'failed', replacement_status: 'required', replacement_requested_at: new Date(Date.now() - 80 * HOUR) }); // overdue
  await Lead.create({ ref: 'KB-2026-000052', affiliate_id: affA._id, signature_status: 'failed', replacement_status: 'required', replacement_requested_at: new Date(Date.now() - 5 * HOUR) });
  await Lead.create({ ref: 'KB-2026-000053', affiliate_id: affB._id, signature_status: 'failed', replacement_status: 'supplied', replacement_requested_at: new Date() });
  await Lead.create({ ref: 'KB-2026-000054', affiliate_id: affB._id, initial_status: 'accepted' }); // none — excluded
  return { admin, affUser };
}

test('admin sees all obligations with counts and SLA', async () => {
  const { admin } = await seed();
  const res = await request(createApp()).get('/api/v1/dashboard/replacements').set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.rows.length, 3);
  assert.deepStrictEqual(res.body.counts, { required: 2, supplied: 1, closed: 0, overdue: 1 });
  const overdueRow = res.body.rows.find((r) => r.ref === 'KB-2026-000051');
  assert.strictEqual(overdueRow.sla.label, 'OVERDUE');
  const freshRow = res.body.rows.find((r) => r.ref === 'KB-2026-000052');
  assert.strictEqual(freshRow.sla.overdue, false);
  const suppliedRow = res.body.rows.find((r) => r.ref === 'KB-2026-000053');
  assert.strictEqual(suppliedRow.sla, null);
});

test('status filter narrows rows but not counts', async () => {
  const { admin } = await seed();
  const res = await request(createApp()).get('/api/v1/dashboard/replacements?replacement_status=supplied').set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(res.body.rows.length, 1);
  assert.strictEqual(res.body.rows[0].ref, 'KB-2026-000053');
  assert.strictEqual(res.body.counts.required, 2);
});

test('affiliate users only see their own obligations', async () => {
  const { affUser } = await seed();
  const res = await request(createApp()).get('/api/v1/dashboard/replacements').set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.body.rows.length, 2);
  assert.ok(res.body.rows.every((r) => r.ref.startsWith('KB-2026-00005') && r.ref !== 'KB-2026-000053'));
  assert.deepStrictEqual(res.body.counts, { required: 2, supplied: 0, closed: 0, overdue: 1 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/replacements.test.js`
Expected: FAIL — 404 (route not mounted).

- [ ] **Step 3: Implement.** Create `backend/routes/replacementRoutes.js`:

```js
const express = require('express');
const Lead = require('../models/Lead');
const { requireAuth } = require('../middleware/auth');
const { buildLeadFilter } = require('../services/leadFilter');
const { slaState } = require('../services/replacementService');

const router = express.Router();

// Replacement obligations control centre: scoped rows + all-time mini-stat counts.
// Counts ignore the status filter so the header cards stay stable while filtering.
router.get('/dashboard/replacements', requireAuth, async (req, res) => {
  const base = buildLeadFilter({ affiliate_id: req.query.affiliate_id }, req.user);
  const leads = await Lead.find({ ...base, replacement_status: { $ne: 'none' } })
    .sort({ replacement_requested_at: 1 })
    .select('ref affiliate_id submitted_at signature_status replacement_status replacement_requested_at replaced_by_lead')
    .populate('affiliate_id', 'name')
    .populate('replaced_by_lead', 'ref')
    .lean();

  const counts = { required: 0, supplied: 0, closed: 0, overdue: 0 };
  for (const l of leads) {
    counts[l.replacement_status] += 1;
    if (slaState(l)?.overdue) counts.overdue += 1;
  }
  const status = req.query.replacement_status;
  const rows = (['required', 'supplied', 'closed'].includes(status) ? leads.filter((l) => l.replacement_status === status) : leads)
    .map((l) => ({ ...l, sla: slaState(l) }));
  res.json({ rows, counts });
});

module.exports = router;
```

In `backend/server.js`, after the statsRoutes line:

```js
  app.use('/api/v1', require('./routes/replacementRoutes'));
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && node --test tests/replacements.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/replacementRoutes.js backend/server.js backend/tests/replacements.test.js
git commit -m "feat: /dashboard/replacements endpoint with SLA + counts"
```

---

### Task 7: statsRoutes — outstanding/overdue KPIs + reconciliation columns

**Files:**
- Modify: `backend/routes/statsRoutes.js`
- Test: `backend/tests/stats.test.js` (append)

**Interfaces:**
- Produces: summary response gains top-level `outstanding_replacements` (all-time count of `required`) and `attention.overdue_replacements`; `attention.needs_replacement` now counts `replacement_status: 'required'`. Affiliate-breakdown rows swap `replacements` for `replacement_required` (ever raised: status ≠ none), `replacement_supplied` (supplied or closed), `outstanding` (currently required) — matching the client's "Required 9 / Supplied 7 / Outstanding 2" semantics.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/stats.test.js`:

```js
test('summary exposes outstanding + overdue replacements; breakdown has reconciliation columns', async () => {
  const { admin } = await seed();
  const HOUR = 3600 * 1000;
  const aff = await Affiliate.findOne({ lead_source: 'aaa' });
  await Lead.create({ ref: 'KB-2026-000061', affiliate_id: aff._id, submitted_at: new Date('2026-07-05T10:00:00Z'), initial_status: 'accepted', signature_status: 'failed', replacement_status: 'required', replacement_requested_at: new Date(Date.now() - 80 * HOUR) }); // overdue
  await Lead.create({ ref: 'KB-2026-000062', affiliate_id: aff._id, submitted_at: new Date('2026-07-05T10:00:00Z'), initial_status: 'accepted', signature_status: 'failed', replacement_status: 'supplied', replacement_requested_at: new Date() });
  await Lead.create({ ref: 'KB-2026-000063', affiliate_id: aff._id, submitted_at: new Date('2026-07-05T10:00:00Z'), initial_status: 'accepted', signature_status: 'failed', replacement_status: 'closed', replacement_requested_at: new Date() });

  const auth = ['Authorization', `Bearer ${signToken(admin)}`];
  const s = await request(createApp()).get('/api/v1/dashboard/summary?from=2026-07-05&to=2026-07-05').set(...auth);
  assert.strictEqual(s.body.outstanding_replacements, 1);
  assert.strictEqual(s.body.attention.needs_replacement, 1);
  assert.strictEqual(s.body.attention.overdue_replacements, 1);

  const b = await request(createApp()).get('/api/v1/dashboard/affiliate-breakdown?from=2026-07-05&to=2026-07-05').set(...auth);
  const rowA = b.body.find((r) => r.lead_source === 'aaa');
  assert.strictEqual(rowA.replacement_required, 3); // ever raised
  assert.strictEqual(rowA.replacement_supplied, 2); // supplied + closed
  assert.strictEqual(rowA.outstanding, 1);          // still owed
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/stats.test.js`
Expected: FAIL — `outstanding_replacements` undefined.

- [ ] **Step 3: Implement** in `backend/routes/statsRoutes.js`:

Add to requires: `const { SLA_HOURS } = require('../services/replacementService');`

In the **attention** `$group` (second aggregate): replace the `needs_replacement` accumulator and add `overdue_replacements`:

```js
          needs_replacement: { $sum: is('replacement_status', 'required') },
          overdue_replacements: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$replacement_status', 'required'] },
                    { $eq: [{ $type: '$replacement_requested_at' }, 'date'] },
                    { $lt: ['$replacement_requested_at', new Date(Date.now() - SLA_HOURS * 3600 * 1000)] },
                  ],
                },
                1, 0,
              ],
            },
          },
```

Update the attention default object and response:

```js
  const at = a || { overdue_signature: 0, needs_replacement: 0, overdue_replacements: 0, awaiting_confirmation: 0, possible_duplicates: 0 };
```

```js
    outstanding_replacements: at.needs_replacement, // all-time, like the rest of attention
    attention: {
      overdue_signature: at.overdue_signature,
      needs_replacement: at.needs_replacement,
      overdue_replacements: at.overdue_replacements,
      awaiting_confirmation: at.awaiting_confirmation,
      possible_duplicates: at.possible_duplicates,
    },
```

(`outstanding_replacements` goes at the top level of the response JSON, next to `awaiting_signature`, which stays for API compatibility.)

In the **affiliate-breakdown** `$group`, replace `replacements: ...` with:

```js
        replacement_required: { $sum: { $cond: [{ $in: ['$replacement_status', ['required', 'supplied', 'closed']] }, 1, 0] } },
        replacement_supplied: { $sum: { $cond: [{ $in: ['$replacement_status', ['supplied', 'closed']] }, 1, 0] } },
        outstanding: { $sum: is('replacement_status', 'required') },
```

And in the breakdown response mapping, replace `replacements: r.replacements,` with:

```js
      replacement_required: r.replacement_required,
      replacement_supplied: r.replacement_supplied,
      outstanding: r.outstanding,
```

- [ ] **Step 4: Run the stats tests — expect one existing test to need a seed tweak**

Run: `cd backend && node --test tests/stats.test.js`
The existing test `summary attention block is all-time...` seeds a `needs_replacement: true` lead; with the accumulator now reading `replacement_status`, update that seed lead to also set `replacement_status: 'required'` (and keep `needs_replacement: true`). Same for any breakdown test asserting `replacements`. Fix seeds/assertions, re-run until PASS. Then `npm test` for the full suite.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/statsRoutes.js backend/tests/stats.test.js
git commit -m "feat: outstanding/overdue replacement KPIs + reconciliation breakdown"
```

---

### Task 8: Export columns + statement outstanding row

**Files:**
- Modify: `backend/routes/exportRoutes.js`
- Test: `backend/tests/export.test.js` (append)

**Interfaces:**
- Produces: CSV/XLSX columns `replacement_status`, `replacement_requested_at`, `replacement_sla` (label `'OVERDUE'` / `'67h remaining'` / `''`); statement XLSX gains a bold `OUTSTANDING REPLACEMENTS` row after totals.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/export.test.js`:

```js
test('export includes replacement columns with SLA label', async () => {
  const aff = await Affiliate.create({ name: 'E', lead_source: 'eee' });
  const admin = await User.create({ email: 'e@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const HOUR = 3600 * 1000;
  await Lead.create({ ref: 'KB-2026-000071', affiliate_id: aff._id, signature_status: 'failed', replacement_status: 'required', replacement_requested_at: new Date(Date.now() - 80 * HOUR) });
  const res = await request(createApp()).get('/api/v1/dashboard/export.csv').set('Authorization', `Bearer ${signToken(admin)}`);
  const [header, row] = res.text.trim().split('\n');
  assert.ok(header.includes('replacement_status'));
  assert.ok(header.includes('replacement_requested_at'));
  assert.ok(header.includes('replacement_sla'));
  assert.ok(row.includes('required'));
  assert.ok(row.includes('OVERDUE'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/export.test.js`
Expected: FAIL — header lacks `replacement_status`.

- [ ] **Step 3: Implement** in `backend/routes/exportRoutes.js`:

Add to requires: `const { slaState } = require('../services/replacementService');`

In `COLUMNS`, after `'payable_status',`:

```js
  'replacement_status', 'replacement_requested_at', 'replacement_sla',
```

In the `fetchExportRows` mapping, after `payable_status: l.payable_status,`:

```js
    replacement_status: l.replacement_status || 'none',
    replacement_requested_at: l.replacement_requested_at?.toISOString() || '',
    replacement_sla: slaState(l)?.label || '',
```

In the statement route, after the `totals.font = { bold: true };` line:

```js
  const outstanding = rows.filter((r) => r.replacement_status === 'required').length;
  const outRow = ws.addRow({ ref: 'OUTSTANDING REPLACEMENTS', applicant_name: String(outstanding) });
  outRow.font = { bold: true };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && node --test tests/export.test.js` then `npm test`
Expected: ALL PASS (an existing export test may assert an exact header string — if so, add the three new columns to its expectation).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/exportRoutes.js backend/tests/export.test.js
git commit -m "feat: replacement columns in exports + statement outstanding row"
```

---

### Task 9: Backfill script

**Files:**
- Create: `backend/scripts/backfillReplacementStatus.js`

**Interfaces:**
- Consumes: `connectDB` from `backend/config/db.js` (same boilerplate as `backend/scripts/sendDigest.js` — check that file with `grep -n "connectDB\|disconnect" backend/scripts/sendDigest.js` and mirror its connect/exit shape exactly).
- Produces: idempotent one-shot script; prints `backfilled N leads`.

- [ ] **Step 1: Write the script** — create `backend/scripts/backfillReplacementStatus.js`:

```js
// One-shot, idempotent backfill for the replacement lifecycle (spec 2026-07-14).
// Usage: node scripts/backfillReplacementStatus.js
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const Lead = require('../models/Lead');

(async () => {
  await connectDB();
  const candidates = await Lead.find({
    replacement_status: { $in: [null, 'none'] },
    $or: [{ needs_replacement: true }, { replaced_by_lead: { $ne: null } }],
  }).populate('replaced_by_lead', 'ref initial_status');

  let n = 0;
  for (const lead of candidates) {
    const failedAt = [...lead.history].reverse().find((h) => h.field === 'signature_status' && h.to === 'failed')?.at;
    if (!lead.replacement_requested_at) lead.replacement_requested_at = failedAt || lead.last_updated;

    if (!lead.replaced_by_lead) {
      lead.replacement_status = 'required';
    } else if (lead.replaced_by_lead.initial_status === 'accepted') {
      lead.replacement_status = 'closed';
    } else if (lead.replaced_by_lead.initial_status === 'rejected') {
      // pre-feature data with a rejected replacement: apply the go-forward reopen rule
      lead.history.push({ at: new Date(), field: 'replaced_by_lead', from: lead.replaced_by_lead.ref, to: null, source: 'manual', user: 'backfill' });
      lead.replaced_by_lead = null;
      lead.replacement_status = 'required';
    } else {
      lead.replacement_status = 'supplied';
    }
    lead.history.push({ at: new Date(), field: 'replacement_status', from: 'none', to: lead.replacement_status, source: 'manual', user: 'backfill' });
    await lead.save();
    n += 1;
  }
  console.log(`backfilled ${n} leads`);
  await mongoose.disconnect();
})();
```

- [ ] **Step 2: Verify it runs clean against an empty local DB**

Run: `cd backend && node scripts/backfillReplacementStatus.js`
Expected: `backfilled 0 leads`, exits 0. Re-run — same output (idempotent). If `connectDB()`'s signature in `config/db.js` differs (e.g. needs a URI argument), mirror exactly how `scripts/sendDigest.js` calls it.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/backfillReplacementStatus.js
git commit -m "feat: replacement lifecycle backfill script"
```

---

### Task 10: StatusBadge labels + payment-filter mapping helper

**Files:**
- Modify: `frontend/src/components/StatusBadge.jsx`

**Interfaces:**
- Produces (imported by Tasks 11–13): `LABELS` (`replaced` → `'replacement supplied'`, plus `required/supplied/closed` labels), `COLORS.replacement_status`, `PAYMENT_FILTER_OPTIONS` (array of `{value,label}`), `paymentFilterToParams(value)` → `{}` | `{ replacement_status: 'required' }` | `{ payable_status: value }`.

- [ ] **Step 1: Implement** — replace the `COLORS`/`LABELS` section of `frontend/src/components/StatusBadge.jsx` with:

```jsx
const COLORS = {
  initial_status: { pending: 'yellow', accepted: 'green', rejected: 'red' },
  search_status: { virgin: 'teal', searched: 'indigo', unknown: 'gray' },
  signature_status: { pending: 'yellow', passed: 'green', failed: 'red' },
  payable_status: {
    not_payable: 'gray', payable: 'green', partial_pending_confirmation: 'orange',
    payable_full: 'green', replaced: 'grape',
  },
  replacement_status: { none: 'gray', required: 'red', supplied: 'blue', closed: 'green' },
};
export const LABELS = {
  payable: 'payable (100%)',
  partial_pending_confirmation: 'part-paid — awaiting law firm',
  payable_full: 'payable in full',
  not_payable: 'not payable',
  replaced: 'replacement supplied',
  required: 'replacement required',
  supplied: 'replacement supplied',
  closed: 'replacement closed',
  virgin: 'virgin search',
  searched: 'already searched',
};

// The "Payment status" dropdown mixes money statuses with the replacement
// lifecycle; this maps each option to the query param the API expects.
export const PAYMENT_FILTER_OPTIONS = [
  { value: 'not_payable', label: LABELS.not_payable },
  { value: 'payable', label: LABELS.payable },
  { value: 'partial_pending_confirmation', label: LABELS.partial_pending_confirmation },
  { value: 'payable_full', label: LABELS.payable_full },
  { value: 'replacement_required', label: 'replacement required' },
  { value: 'replaced', label: 'replacement supplied' },
];
export function paymentFilterToParams(value) {
  if (!value) return {};
  if (value === 'replacement_required') return { replacement_status: 'required' };
  return { payable_status: value };
}
```

- [ ] **Step 2: Build**

Run: `cd frontend && npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/StatusBadge.jsx
git commit -m "feat: replacement labels + payment filter mapping (no more 'replaced')"
```

---

### Task 11: Leads page — new dropdown, next-update filter, lifecycle wording

**Files:**
- Modify: `frontend/src/pages/Leads.jsx`

**Interfaces:**
- Consumes: `PAYMENT_FILTER_OPTIONS`, `paymentFilterToParams` from Task 10; `next_update` param from Task 5.

- [ ] **Step 1: Implement** — five edits in `frontend/src/pages/Leads.jsx`:

1. Import: `import StatusBadge, { PAYMENT_FILTER_OPTIONS, paymentFilterToParams } from '../components/StatusBadge';` (replacing the current `LABELS` import — `LABELS` is no longer used here after edit 4).

2. Filters state: replace `payable_status: null` with `payment: null, next_update: null` in the `useState` initial object.

3. Query effect: replace the params loop with payment-aware expansion:

```jsx
    const params = new URLSearchParams({ page, limit: PAGE_SIZE });
    const { payment, ...rest } = filters;
    for (const [k, v] of Object.entries(rest)) if (v) params.set(k, v);
    for (const [k, v] of Object.entries(paymentFilterToParams(payment))) params.set(k, v);
```

4. Payment status Select: replace its `data` with `PAYMENT_FILTER_OPTIONS`, `value={filters.payment}`, `onChange={set('payment')}`. Next to it add:

```jsx
        <Select placeholder="Next update" clearable w={180}
          data={[
            { value: 'awaiting_confirmation', label: 'Awaiting confirmation' },
            { value: 'replacement_required', label: 'Replacement required' },
            { value: 'complete', label: 'Complete' },
          ]}
          value={filters.next_update} onChange={set('next_update')} />
```

5. Lifecycle wording — update `nextUpdate()` to speak the new language (replace the whole function):

```jsx
function nextUpdate(l) {
  if (l.initial_status === 'rejected') return '—';
  if (l.replacement_status === 'required') return 'Replacement required';
  if (l.replacement_status === 'supplied') return 'Replacement supplied — awaiting acceptance';
  if (l.replacement_status === 'closed' || l.payable_status === 'replaced') return '—';
  if (l.initial_status === 'pending') return 'Awaiting acceptance';
  if (l.signature_status === 'pending') {
    return `Signature check by ${l.signature_deadline ? dayjs(l.signature_deadline).format('DD MMM') : '—'}`;
  }
  if (l.payable_status === 'partial_pending_confirmation') return 'Awaiting law firm confirmation';
  if (l.payable_status === 'payable' || l.payable_status === 'payable_full') return 'None — ready to pay';
  return '—';
}
```

And in the signature column, change the badge line to use the lifecycle field and new copy:

```jsx
                {l.replacement_status === 'required' && <Badge color="red" ml={4}>replacement required</Badge>}
```

In the drawer badge `Group`, add after the payable badge:

```jsx
              {selected.replacement_status && selected.replacement_status !== 'none' && (
                <StatusBadge field="replacement_status" value={selected.replacement_status} />
              )}
```

- [ ] **Step 2: Build**

Run: `cd frontend && npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Leads.jsx
git commit -m "feat: Leads page replacement filters + lifecycle wording"
```

---

### Task 12: Replacements page + nav

**Files:**
- Create: `frontend/src/pages/Replacements.jsx`
- Modify: `frontend/src/App.jsx` (import, `ICONS`, `links`, route)

**Interfaces:**
- Consumes: `GET /dashboard/replacements` (Task 6), existing `PATCH /dashboard/leads/:id { replaces_ref }`, existing `GET /dashboard/leads?q=` (returns `{ rows, total }`).

- [ ] **Step 1: Implement the page** — create `frontend/src/pages/Replacements.jsx`:

```jsx
import { useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, Code, Group, Modal, Select, SimpleGrid, Table, Text, TextInput, Title,
} from '@mantine/core';
import dayjs from 'dayjs';
import { api, getUser } from '../api';
import StatusBadge from '../components/StatusBadge';

function Stat({ label, value, accent = 'var(--mantine-color-emerald-5)' }) {
  return (
    <Card withBorder p="md" style={{ borderLeft: `3px solid ${accent}` }}>
      <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
      <Text fz={24} fw={700}>{value}</Text>
    </Card>
  );
}

function SlaCell({ sla }) {
  if (!sla) return <Text size="sm" c="dimmed">—</Text>;
  const color = sla.overdue ? 'red' : sla.hours_remaining <= 24 ? 'yellow' : 'green';
  return <Badge color={color} variant={sla.overdue ? 'filled' : 'light'}>{sla.label}</Badge>;
}

export default function Replacements() {
  const user = getUser();
  const isAdmin = user.role === 'admin';
  const [data, setData] = useState({ rows: [], counts: { required: 0, supplied: 0, closed: 0, overdue: 0 } });
  const [status, setStatus] = useState(null);
  const [affiliates, setAffiliates] = useState([]);
  const [affiliateId, setAffiliateId] = useState(null);
  const [assigning, setAssigning] = useState(null); // the obligation row being assigned
  const [replacementRef, setReplacementRef] = useState('');
  const [error, setError] = useState(null);
  const [modalError, setModalError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => { if (isAdmin) api('/affiliates').then(setAffiliates).catch(() => {}); }, [isAdmin]);

  useEffect(() => {
    let stale = false;
    const params = new URLSearchParams();
    if (status) params.set('replacement_status', status);
    if (affiliateId) params.set('affiliate_id', affiliateId);
    api(`/dashboard/replacements?${params}`)
      .then((d) => { if (!stale) { setData(d); setError(null); } })
      .catch((e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [status, affiliateId, refreshKey]);

  async function assign() {
    setBusy(true); setModalError(null);
    try {
      const ref = replacementRef.trim();
      const found = await api(`/dashboard/leads?q=${encodeURIComponent(ref)}&limit=5`);
      const repl = (found.rows || []).find((r) => r.ref === ref);
      if (!repl) throw new Error(`lead ${ref} not found`);
      await api(`/dashboard/leads/${repl._id}`, { method: 'PATCH', body: { replaces_ref: assigning.ref } });
      setAssigning(null); setReplacementRef(''); setRefreshKey((k) => k + 1);
    } catch (e) { setModalError(e.message); } finally { setBusy(false); }
  }

  const { counts } = data;
  return (
    <>
      <Title order={3} mb="md">Replacements</Title>
      {error && <Alert color="red" mb="md" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
      <SimpleGrid cols={{ base: 2, md: 4 }} mb="lg">
        <Stat label="Required" value={counts.required} accent="var(--mantine-color-red-6)" />
        <Stat label="Supplied" value={counts.supplied} accent="var(--mantine-color-blue-6)" />
        <Stat label="Closed" value={counts.closed} accent="var(--mantine-color-green-6)" />
        <Stat label="Overdue" value={counts.overdue} accent="var(--mantine-color-red-9)" />
      </SimpleGrid>

      <Group mb="md" gap="xs">
        <Select placeholder="Status" clearable w={160}
          data={[
            { value: 'required', label: 'Required' },
            { value: 'supplied', label: 'Supplied' },
            { value: 'closed', label: 'Closed' },
          ]}
          value={status} onChange={setStatus} />
        {isAdmin && (
          <Select placeholder="Affiliate" clearable w={180} value={affiliateId}
            data={affiliates.map((a) => ({ value: a._id, label: a.name }))} onChange={setAffiliateId} />
        )}
      </Group>

      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Ref</Table.Th>
            {isAdmin && <Table.Th>Affiliate</Table.Th>}
            <Table.Th>Signature failed</Table.Th>
            <Table.Th>SLA (72h)</Table.Th>
            <Table.Th>Replacement</Table.Th>
            <Table.Th>Status</Table.Th>
            {isAdmin && <Table.Th />}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.rows.map((l) => (
            <Table.Tr key={l._id}>
              <Table.Td><Code>{l.ref}</Code></Table.Td>
              {isAdmin && <Table.Td>{l.affiliate_id?.name}</Table.Td>}
              <Table.Td>{l.replacement_requested_at ? dayjs(l.replacement_requested_at).format('DD MMM HH:mm') : '—'}</Table.Td>
              <Table.Td><SlaCell sla={l.sla} /></Table.Td>
              <Table.Td>{l.replaced_by_lead ? <Code>{l.replaced_by_lead.ref}</Code> : <Text size="sm" c="dimmed">—</Text>}</Table.Td>
              <Table.Td><StatusBadge field="replacement_status" value={l.replacement_status} /></Table.Td>
              {isAdmin && (
                <Table.Td>
                  {l.replacement_status === 'required' && (
                    <Button size="xs" variant="light" onClick={() => { setAssigning(l); setModalError(null); }}>
                      Assign replacement
                    </Button>
                  )}
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {data.rows.length === 0 && (
        <Text c="dimmed" size="sm" mt="sm">No replacement obligations — nothing owed. 🎉</Text>
      )}

      <Modal opened={!!assigning} onClose={() => setAssigning(null)}
        title={assigning ? `Assign replacement for ${assigning.ref}` : ''}>
        <Text size="sm" c="dimmed" mb="sm">
          Enter the ref of the lead that replaces this one. It must belong to the same affiliate and not already be a replacement.
        </Text>
        {modalError && <Alert color="red" mb="sm">{modalError}</Alert>}
        <TextInput placeholder="KB-2026-000123" value={replacementRef}
          onChange={(e) => setReplacementRef(e.target.value)} mb="md" />
        <Button onClick={assign} loading={busy} disabled={!replacementRef.trim()}>Link replacement</Button>
      </Modal>
    </>
  );
}
```

- [ ] **Step 2: Wire nav + route** in `frontend/src/App.jsx`:

1. Imports: add `IconReplace` to the `@tabler/icons-react` import list, and `import Replacements from './pages/Replacements';`
2. `ICONS`: add `'/replacements': IconReplace,`
3. `links`: after the Leads entry add `{ to: '/replacements', label: 'Replacements' },`
4. Routes: after the `/leads` route add:

```jsx
        <Route path="/replacements" element={<RequireAuth><Replacements /></RequireAuth>} />
```

- [ ] **Step 3: Build**

Run: `cd frontend && npm run build`
Expected: exit 0 (if `IconReplace` doesn't exist in the installed @tabler/icons-react version, use `IconArrowsExchange` instead).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Replacements.jsx frontend/src/App.jsx
git commit -m "feat: Replacements control-centre page with SLA countdown + assign flow"
```

---

### Task 13: Summary page — KPI card, attention strip, reconciliation columns

**Files:**
- Modify: `frontend/src/pages/Summary.jsx`

**Interfaces:**
- Consumes: `summary.outstanding_replacements`, `summary.attention.overdue_replacements`, breakdown `replacement_required` / `replacement_supplied` / `outstanding` (Task 7).

- [ ] **Step 1: Implement** — three edits in `frontend/src/pages/Summary.jsx`:

1. KPI grid: replace the `Awaiting signature` Stat with:

```jsx
          <Stat label="Outstanding replacements" value={summary.outstanding_replacements} accent="var(--mantine-color-red-6)" />
```

2. Attention strip: add `summary.attention.overdue_replacements` to the visibility sum in the strip's condition, and add as the FIRST item of the joined list:

```jsx
            summary.attention.overdue_replacements > 0 && `${summary.attention.overdue_replacements} replacement${summary.attention.overdue_replacements === 1 ? '' : 's'} OVERDUE (72h SLA breached)`,
```

3. By-affiliate table: replace the `<Table.Th>Replacements</Table.Th>` header with:

```jsx
            <Table.Th>Required</Table.Th><Table.Th>Supplied</Table.Th><Table.Th>Outstanding</Table.Th>
```

and the `{r.replacements}` cell with:

```jsx
              <Table.Td>{r.replacement_required}</Table.Td><Table.Td>{r.replacement_supplied}</Table.Td><Table.Td>{r.outstanding}</Table.Td>
```

- [ ] **Step 2: Build**

Run: `cd frontend && npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Summary.jsx
git commit -m "feat: outstanding-replacements KPI + overdue strip + reconciliation columns"
```

---

### Task 14: Export page — payment options + next-update filter

**Files:**
- Modify: `frontend/src/pages/ExportPage.jsx`

**Interfaces:**
- Consumes: `PAYMENT_FILTER_OPTIONS`, `paymentFilterToParams` (Task 10); `next_update` param (Task 5).

- [ ] **Step 1: Implement** — four edits in `frontend/src/pages/ExportPage.jsx`:

1. Import: replace the `LABELS` import with `import { PAYMENT_FILTER_OPTIONS, paymentFilterToParams } from '../components/StatusBadge';`
2. State: rename `payableStatus`/`setPayableStatus` to `payment`/`setPayment`; add `const [nextUpdate, setNextUpdate] = useState(null);`
3. `doExport()`: replace `if (payableStatus) params.set('payable_status', payableStatus);` with:

```jsx
      for (const [k, v] of Object.entries(paymentFilterToParams(payment))) params.set(k, v);
      if (nextUpdate) params.set('next_update', nextUpdate);
```

4. Replace the Payment status Select's `data` with `PAYMENT_FILTER_OPTIONS` (`value={payment} onChange={setPayment}`), and add below it:

```jsx
          <Select label="Next update" placeholder="Any" clearable
            data={[
              { value: 'awaiting_confirmation', label: 'Awaiting confirmation' },
              { value: 'replacement_required', label: 'Replacement required' },
              { value: 'complete', label: 'Complete' },
            ]}
            value={nextUpdate} onChange={setNextUpdate} />
```

- [ ] **Step 2: Build + full backend suite one last time**

Run: `cd frontend && npm run build && cd ../backend && npm test`
Expected: build exit 0, all backend tests pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/ExportPage.jsx
git commit -m "feat: export page replacement + next-update filters"
```

---

### Task 15: Deploy to production + backfill + live verify (USER-GATED)

**⚠️ Do not start this task without explicit user go-ahead — it touches prod (leads.click2leads.co.uk, VPS 31.97.57.193, pm2 `pcp-affiliate-api`, port 5009).**

**Files:** none (operational).

- [ ] **Step 1: Push to GitHub**

```bash
cd ~/Desktop/pcp-affiliate-dashboard && git push origin main
```

- [ ] **Step 2: Deploy** — follow the repo's established flow (`DEPLOY.md` / previous deploys): rsync backend + frontend to `/var/www/pcp-affiliate-dashboard`, `npm install` (NOT `npm ci`), build frontend on the server, `pm2 restart pcp-affiliate-api`.

- [ ] **Step 3: Run the backfill on the server**

```bash
ssh <vps> 'cd /var/www/pcp-affiliate-dashboard/backend && node scripts/backfillReplacementStatus.js'
```

Expected: `backfilled N leads` (N = current count of needs-replacement/replaced leads; likely small).

- [ ] **Step 4: Purge Cloudflare cache** (zone for click2leads.co.uk — creds in `~/.claude` memory `reference_cloudflare_api.md`).

- [ ] **Step 5: Live verify via Playwright** (DOM-based checks, settle ~1s after clicks; screenshot pipeline on this app is flaky):
- Login as admin → Summary shows "Outstanding replacements" card (not "Awaiting signature").
- Replacements nav item present; page renders mini-stats + table (likely near-empty on prod).
- Export page shows the new Payment status options + Next update filter; download a CSV and confirm the three new columns.
- Confirm the word "replaced" appears nowhere in the UI.

- [ ] **Step 6: Update memory** — update `project_pcp_affiliate_dashboard.md` with deployment status and commit hashes.
