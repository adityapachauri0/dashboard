# PCP Affiliate Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Affiliate lead gateway + tracking dashboard: affiliates POST leads via API, we forward to the buyer platform (adapter, manual mode for now), track 4 status dimensions + per-affiliate money, expose admin & affiliate-scoped dashboards with CSV import/export.

**Architecture:** Single Express (CommonJS) API on port 5005 backed by MongoDB (`pcp-affiliates` db), serving JSON under `/api/v1`. Separate React/Vite/Mantine SPA (static build, Nginx-served in prod; Vite dev proxy locally). All status mutations flow through one `statusService` that appends history and recomputes money via a pure `moneyEngine`.

**Tech Stack:** Node 20 (CommonJS), express@4, mongoose@8, jsonwebtoken@9, bcryptjs@2, multer@1.4.5-lts, csv-parse@5, csv-stringify@6, express-rate-limit@7, dotenv@16. Tests: `node --test` + supertest@7 + mongodb-memory-server@9. Frontend: Vite 5, React 18, @mantine/core@7, @mantine/dates@7, dayjs, react-router-dom@6.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-08-pcp-affiliate-dashboard-design.md` — enums and behavior below are copied from it verbatim.
- Node 20, CommonJS (`require`), **no TypeScript**, 2-space indent, plain JS.
- Backend port **5005**; Mongo db **pcp-affiliates**; all routes under **/api/v1**; currency **GBP**.
- Lead ref format: **`KB-YYYY-NNNNNN`** (year + zero-padded sequence).
- Enums (verbatim, never invent new values):
  - `initial_status`: `pending | accepted | rejected`
  - `search_status`: `virgin | searched | unknown`
  - `signature_status`: `pending | passed | failed`
  - `payable_status`: `not_payable | payable | partial_pending_confirmation | payable_full | replaced`
  - `history[].source`: `api | webhook | import | manual`
  - `users.role`: `admin | affiliate`
- Signature deadline = `submitted_at + 48h`. No auto-fail; UI flags overdue/weekend.
- Money is **stored on the lead** at status-change time, never recomputed at read time.
- Affiliate-role users are scoped server-side to their `affiliate_id` on every query. Never trust client filters.
- env vars: `PORT`, `MONGO_URI`, `JWT_SECRET`, `SHARED_API_KEY` (optional), `WEBHOOK_TOKEN` (optional).
- Test command: `cd backend && npm test` (runs `node --test tests/`). Test files: `backend/tests/*.test.js`.
- Commit after every task (steps show exact commands).

## File Structure (final)

```
backend/
  package.json, .env.example, server.js
  config/db.js
  models/{Affiliate,User,Lead,Counter,ImportRecord,WebhookEvent}.js
  middleware/{auth,apiKey}.js
  services/{moneyEngine,statusService,normalize,apiKeys,platformAdapter,leadFilter}.js
  routes/{authRoutes,affiliateRoutes,leadIngest,leadRoutes,webhookRoutes,importRoutes,statsRoutes,exportRoutes}.js
  scripts/createAdmin.js
  tests/{helpers.js,*.test.js}
frontend/
  package.json, vite.config.js, index.html
  src/{main.jsx,App.jsx,api.js}
  src/components/StatusBadge.jsx
  src/pages/{Login,Summary,Leads,Affiliates,Imports,ExportPage}.jsx
deploy/{nginx.conf,DEPLOY.md}
```

---

### Task 1: Backend scaffold, Express app, health endpoint, test harness

**Files:**
- Create: `backend/package.json`, `backend/.env.example`, `backend/.gitignore`, `backend/server.js`, `backend/config/db.js`, `backend/tests/helpers.js`, `backend/tests/health.test.js`

**Interfaces:**
- Produces: `createApp()` (exported from `backend/server.js`) returns an Express app with `express.json()` and all routers mounted (later tasks add routers here). `backend/tests/helpers.js` exports `{ setupDB, teardownDB, clearDB }`.

- [ ] **Step 1: Scaffold package and config files**

`backend/package.json`:
```json
{
  "name": "pcp-affiliate-api",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test tests/"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "csv-parse": "^5.5.6",
    "csv-stringify": "^6.5.0",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.4.0",
    "jsonwebtoken": "^9.0.2",
    "mongoose": "^8.5.0",
    "multer": "^1.4.5-lts.2"
  },
  "devDependencies": {
    "mongodb-memory-server": "^9.4.0",
    "supertest": "^7.0.0"
  }
}
```

`backend/.gitignore`:
```
node_modules/
.env
```

`backend/.env.example`:
```
PORT=5005
MONGO_URI=mongodb://127.0.0.1:27017/pcp-affiliates
JWT_SECRET=change-me
# Optional: shared ingest key (affiliates then pass lead_source in body)
SHARED_API_KEY=
# Optional: token required as ?token= on the platform webhook
WEBHOOK_TOKEN=
```

`backend/config/db.js`:
```js
const mongoose = require('mongoose');

async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/pcp-affiliates');
  console.log('MongoDB connected');
}

module.exports = { connectDB };
```

- [ ] **Step 2: Write the failing test**

`backend/tests/helpers.js`:
```js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;

async function setupDB() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('pcp-affiliates-test'));
}

async function teardownDB() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

async function clearDB() {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) await collections[key].deleteMany({});
}

module.exports = { setupDB, teardownDB, clearDB };
```

`backend/tests/health.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../server');

test('GET /api/v1/health returns ok', async () => {
  const res = await request(createApp()).get('/api/v1/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npm install && npm test`
Expected: FAIL — `Cannot find module '../server'`

- [ ] **Step 4: Write minimal implementation**

`backend/server.js`:
```js
require('dotenv').config();
const express = require('express');
const { connectDB } = require('./config/db');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/v1/health', (req, res) => res.json({ ok: true }));

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  connectDB().then(() => {
    const port = process.env.PORT || 5005;
    createApp().listen(port, () => console.log(`pcp-affiliate-api on :${port}`));
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (1 test). First run downloads a mongod binary for mongodb-memory-server — allow a minute.

- [ ] **Step 6: Commit**

```bash
git add backend
git commit -m "feat: backend scaffold with health endpoint and test harness"
```

---

### Task 2: Mongo models + lead ref counter

**Files:**
- Create: `backend/models/Affiliate.js`, `backend/models/User.js`, `backend/models/Lead.js`, `backend/models/Counter.js`, `backend/models/ImportRecord.js`, `backend/models/WebhookEvent.js`
- Test: `backend/tests/models.test.js`

**Interfaces:**
- Produces: mongoose models `Affiliate`, `User`, `Lead`, `ImportRecord`, `WebhookEvent`; `nextLeadRef(date?) -> Promise<string>` from `models/Counter.js` returning e.g. `KB-2026-000001`.
- Lead documents carry: `ref, affiliate_id, lead_source, brand, submitted_at, applicant_name, payload, platform_ref, initial_status, rejection_reason, search_status, signature_status, signature_deadline, law_firm_confirmed, payable_status, needs_replacement, replaces_lead, replaced_by_lead, amounts{upfront_due,confirmation_due,total_due}, history[], created_at, last_updated`.

- [ ] **Step 1: Write the failing test**

`backend/tests/models.test.js`:
```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const { nextLeadRef } = require('../models/Counter');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

test('nextLeadRef produces sequential zero-padded refs', async () => {
  const a = await nextLeadRef(new Date('2026-07-08'));
  const b = await nextLeadRef(new Date('2026-07-08'));
  assert.strictEqual(a, 'KB-2026-000001');
  assert.strictEqual(b, 'KB-2026-000002');
});

test('lead defaults match spec', async () => {
  const aff = await Affiliate.create({ name: 'Acme Leads', lead_source: 'acme' });
  const lead = await Lead.create({
    ref: 'KB-2026-000001',
    affiliate_id: aff._id,
    lead_source: 'acme',
    applicant_name: 'John Smith',
    payload: { first_name: 'John' },
  });
  assert.strictEqual(lead.initial_status, 'pending');
  assert.strictEqual(lead.search_status, 'unknown');
  assert.strictEqual(lead.signature_status, 'pending');
  assert.strictEqual(lead.payable_status, 'not_payable');
  assert.strictEqual(lead.law_firm_confirmed, false);
  assert.strictEqual(lead.needs_replacement, false);
  assert.strictEqual(lead.amounts.total_due, 0);
});

test('affiliate lead_source is unique', async () => {
  await Affiliate.create({ name: 'A', lead_source: 'dup' });
  await Affiliate.ensureIndexes();
  await assert.rejects(Affiliate.create({ name: 'B', lead_source: 'dup' }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `Cannot find module '../models/Affiliate'`

- [ ] **Step 3: Write the models**

`backend/models/Affiliate.js`:
```js
const mongoose = require('mongoose');

const affiliateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    brands: [String],
    lead_source: { type: String, required: true, unique: true, lowercase: true, trim: true },
    api_key_hash: { type: String, index: true },
    api_key_prefix: String,
    rate_card: {
      virgin_rate: { type: Number, default: 0 },
      searched_upfront_rate: { type: Number, default: 0 },
      searched_confirmation_rate: { type: Number, default: 0 },
      currency: { type: String, default: 'GBP' },
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Affiliate', affiliateSchema);
```

`backend/models/User.js`:
```js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password_hash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'affiliate'], required: true },
    affiliate_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
```

`backend/models/Lead.js`:
```js
const mongoose = require('mongoose');

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    field: { type: String, required: true },
    from: mongoose.Schema.Types.Mixed,
    to: mongoose.Schema.Types.Mixed,
    source: { type: String, enum: ['api', 'webhook', 'import', 'manual'], required: true },
    user: String,
  },
  { _id: false }
);

const leadSchema = new mongoose.Schema(
  {
    ref: { type: String, required: true, unique: true },
    affiliate_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', required: true, index: true },
    lead_source: String,
    brand: String,
    submitted_at: { type: Date, default: Date.now, index: true },
    applicant_name: String,
    payload: Object,
    platform_ref: { type: String, index: true },
    initial_status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
    rejection_reason: String,
    search_status: { type: String, enum: ['virgin', 'searched', 'unknown'], default: 'unknown' },
    signature_status: { type: String, enum: ['pending', 'passed', 'failed'], default: 'pending' },
    signature_deadline: Date,
    law_firm_confirmed: { type: Boolean, default: false },
    payable_status: {
      type: String,
      enum: ['not_payable', 'payable', 'partial_pending_confirmation', 'payable_full', 'replaced'],
      default: 'not_payable',
    },
    needs_replacement: { type: Boolean, default: false },
    replaces_lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    replaced_by_lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    amounts: {
      upfront_due: { type: Number, default: 0 },
      confirmation_due: { type: Number, default: 0 },
      total_due: { type: Number, default: 0 },
    },
    history: [historySchema],
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'last_updated' } }
);

module.exports = mongoose.model('Lead', leadSchema);
```

`backend/models/Counter.js`:
```js
const mongoose = require('mongoose');

const Counter = mongoose.model(
  'Counter',
  new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } })
);

async function nextLeadRef(date = new Date()) {
  const c = await Counter.findByIdAndUpdate(
    'lead_ref',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `KB-${date.getFullYear()}-${String(c.seq).padStart(6, '0')}`;
}

module.exports = { Counter, nextLeadRef };
```

`backend/models/ImportRecord.js`:
```js
const mongoose = require('mongoose');

module.exports = mongoose.model(
  'ImportRecord',
  new mongoose.Schema({
    filename: String,
    uploaded_by: String,
    at: { type: Date, default: Date.now },
    row_count: Number,
    matched: Number,
    unmatched: Number,
    mapping: Object,
  })
);
```

`backend/models/WebhookEvent.js`:
```js
const mongoose = require('mongoose');

module.exports = mongoose.model(
  'WebhookEvent',
  new mongoose.Schema({
    payload: Object,
    matched_lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null },
    source_ip: String,
    at: { type: Date, default: Date.now },
  })
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add backend/models backend/tests/models.test.js
git commit -m "feat: mongo models and sequential lead ref counter"
```

---

### Task 3: Money engine (pure)

**Files:**
- Create: `backend/services/moneyEngine.js`
- Test: `backend/tests/moneyEngine.test.js`

**Interfaces:**
- Produces: `computeMoney(lead, rateCard) -> { upfront_due, confirmation_due, total_due, payable_status }`. Pure — accepts plain objects; `lead` needs `initial_status, search_status, signature_status, law_firm_confirmed, replaced_by_lead`; `rateCard` needs `virgin_rate, searched_upfront_rate, searched_confirmation_rate`.

- [ ] **Step 1: Write the failing test**

`backend/tests/moneyEngine.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { computeMoney } = require('../services/moneyEngine');

const rates = { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 };
const base = {
  initial_status: 'accepted',
  search_status: 'virgin',
  signature_status: 'pending',
  law_firm_confirmed: false,
  replaced_by_lead: null,
};

test('accepted virgin -> full virgin rate, payable', () => {
  assert.deepStrictEqual(computeMoney(base, rates), {
    upfront_due: 40, confirmation_due: 0, total_due: 40, payable_status: 'payable',
  });
});

test('accepted searched, unconfirmed -> upfront only, partial_pending_confirmation', () => {
  const m = computeMoney({ ...base, search_status: 'searched' }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 15, confirmation_due: 0, total_due: 15, payable_status: 'partial_pending_confirmation',
  });
});

test('accepted searched, confirmed -> full amount, payable_full', () => {
  const m = computeMoney({ ...base, search_status: 'searched', law_firm_confirmed: true }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 15, confirmation_due: 25, total_due: 40, payable_status: 'payable_full',
  });
});

test('rejected -> zero, not_payable', () => {
  const m = computeMoney({ ...base, initial_status: 'rejected' }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 0, confirmation_due: 0, total_due: 0, payable_status: 'not_payable',
  });
});

test('pending -> zero, not_payable', () => {
  const m = computeMoney({ ...base, initial_status: 'pending' }, rates);
  assert.strictEqual(m.payable_status, 'not_payable');
  assert.strictEqual(m.total_due, 0);
});

test('signature failed -> zero, not_payable (even if virgin accepted)', () => {
  const m = computeMoney({ ...base, signature_status: 'failed' }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 0, confirmation_due: 0, total_due: 0, payable_status: 'not_payable',
  });
});

test('replaced lead -> zero, replaced (never double-billed)', () => {
  const m = computeMoney({ ...base, replaced_by_lead: 'someObjectId' }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 0, confirmation_due: 0, total_due: 0, payable_status: 'replaced',
  });
});

test('accepted but search class unknown -> zero, not_payable until classified', () => {
  const m = computeMoney({ ...base, search_status: 'unknown' }, rates);
  assert.deepStrictEqual(m, {
    upfront_due: 0, confirmation_due: 0, total_due: 0, payable_status: 'not_payable',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `Cannot find module '../services/moneyEngine'`

- [ ] **Step 3: Write minimal implementation**

`backend/services/moneyEngine.js`:
```js
// Pure money calculation per the spec's rate-card table.
// Order matters: replaced beats everything; only accepted leads with a
// non-failed signature and a known search class are worth money.
function computeMoney(lead, rateCard) {
  const zero = { upfront_due: 0, confirmation_due: 0, total_due: 0 };
  if (lead.replaced_by_lead) return { ...zero, payable_status: 'replaced' };
  if (lead.initial_status !== 'accepted') return { ...zero, payable_status: 'not_payable' };
  if (lead.signature_status === 'failed') return { ...zero, payable_status: 'not_payable' };

  if (lead.search_status === 'virgin') {
    const upfront = rateCard.virgin_rate || 0;
    return { upfront_due: upfront, confirmation_due: 0, total_due: upfront, payable_status: 'payable' };
  }
  if (lead.search_status === 'searched') {
    const upfront = rateCard.searched_upfront_rate || 0;
    if (lead.law_firm_confirmed) {
      const conf = rateCard.searched_confirmation_rate || 0;
      return {
        upfront_due: upfront,
        confirmation_due: conf,
        total_due: upfront + conf,
        payable_status: 'payable_full',
      };
    }
    return { upfront_due: upfront, confirmation_due: 0, total_due: upfront, payable_status: 'partial_pending_confirmation' };
  }
  // accepted, search class unknown — nothing payable until classified
  return { ...zero, payable_status: 'not_payable' };
}

module.exports = { computeMoney };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (all money engine cases)

- [ ] **Step 5: Commit**

```bash
git add backend/services/moneyEngine.js backend/tests/moneyEngine.test.js
git commit -m "feat: pure money engine covering every rate-card branch"
```

---

### Task 4: Status service + value normalizer (pure)

**Files:**
- Create: `backend/services/statusService.js`, `backend/services/normalize.js`
- Test: `backend/tests/statusService.test.js`, `backend/tests/normalize.test.js`

**Interfaces:**
- Consumes: `computeMoney` from Task 3.
- Produces:
  - `applyStatusChanges(lead, changes, rateCard, { source, user }) -> lead` from `statusService.js`. Mutates `lead` in place (works on mongoose docs AND plain objects with a `history` array): applies only `UPDATABLE_FIELDS = ['initial_status','rejection_reason','search_status','signature_status','law_firm_confirmed','platform_ref']`, appends one history entry per real change, auto-sets `needs_replacement` when signature fails, recomputes/stores `amounts` + `payable_status`.
  - `normalizeField(field, raw) -> canonicalValue | undefined` and `canonicalFromPayload(payload) -> changes` from `normalize.js`. Unrecognized values return `undefined` (skip — never guess).

- [ ] **Step 1: Write the failing tests**

`backend/tests/statusService.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { applyStatusChanges } = require('../services/statusService');

const rates = { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 };

function freshLead() {
  return {
    initial_status: 'pending',
    rejection_reason: undefined,
    search_status: 'unknown',
    signature_status: 'pending',
    law_firm_confirmed: false,
    platform_ref: undefined,
    payable_status: 'not_payable',
    needs_replacement: false,
    replaced_by_lead: null,
    amounts: { upfront_due: 0, confirmation_due: 0, total_due: 0 },
    history: [],
  };
}

test('acceptance as virgin records history and money', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', search_status: 'virgin' }, rates, { source: 'import', user: 'admin@x.com' });
  assert.strictEqual(lead.initial_status, 'accepted');
  assert.strictEqual(lead.payable_status, 'payable');
  assert.strictEqual(lead.amounts.total_due, 40);
  const fields = lead.history.map((h) => h.field);
  assert.ok(fields.includes('initial_status'));
  assert.ok(fields.includes('search_status'));
  assert.ok(fields.includes('payable_status'));
  assert.strictEqual(lead.history[0].source, 'import');
  assert.strictEqual(lead.history[0].user, 'admin@x.com');
});

test('no-op change appends no history', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'pending' }, rates, { source: 'manual' });
  assert.strictEqual(lead.history.length, 0);
});

test('non-updatable fields in changes are ignored', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { ref: 'HACK', amounts: { total_due: 999 }, payable_status: 'payable_full' }, rates, { source: 'manual' });
  assert.strictEqual(lead.amounts.total_due, 0);
  assert.strictEqual(lead.payable_status, 'not_payable');
});

test('signature failure flags needs_replacement and zeroes money', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', search_status: 'virgin' }, rates, { source: 'import' });
  applyStatusChanges(lead, { signature_status: 'failed' }, rates, { source: 'webhook' });
  assert.strictEqual(lead.needs_replacement, true);
  assert.strictEqual(lead.payable_status, 'not_payable');
  assert.strictEqual(lead.amounts.total_due, 0);
  assert.ok(lead.history.some((h) => h.field === 'needs_replacement' && h.to === true));
});

test('law firm confirmation upgrades searched lead to payable_full', () => {
  const lead = freshLead();
  applyStatusChanges(lead, { initial_status: 'accepted', search_status: 'searched' }, rates, { source: 'import' });
  assert.strictEqual(lead.payable_status, 'partial_pending_confirmation');
  applyStatusChanges(lead, { law_firm_confirmed: true }, rates, { source: 'import' });
  assert.strictEqual(lead.payable_status, 'payable_full');
  assert.strictEqual(lead.amounts.total_due, 40);
});
```

`backend/tests/normalize.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeField, canonicalFromPayload } = require('../services/normalize');

test('initial_status variants', () => {
  assert.strictEqual(normalizeField('initial_status', 'Accepted'), 'accepted');
  assert.strictEqual(normalizeField('initial_status', 'APPROVED'), 'accepted');
  assert.strictEqual(normalizeField('initial_status', 'declined'), 'rejected');
  assert.strictEqual(normalizeField('initial_status', 'garbage'), undefined);
});

test('search_status variants', () => {
  assert.strictEqual(normalizeField('search_status', 'Virgin'), 'virgin');
  assert.strictEqual(normalizeField('search_status', 'non-searched'), 'virgin');
  assert.strictEqual(normalizeField('search_status', 'already searched'), 'searched');
});

test('signature_status variants', () => {
  assert.strictEqual(normalizeField('signature_status', 'signed'), 'passed');
  assert.strictEqual(normalizeField('signature_status', 'FALSE'), 'failed');
  assert.strictEqual(normalizeField('signature_status', 'awaiting'), 'pending');
});

test('law_firm_confirmed variants return booleans', () => {
  assert.strictEqual(normalizeField('law_firm_confirmed', 'YES'), true);
  assert.strictEqual(normalizeField('law_firm_confirmed', true), true);
  assert.strictEqual(normalizeField('law_firm_confirmed', 'no'), false);
});

test('canonicalFromPayload maps common webhook shapes, skips junk', () => {
  const changes = canonicalFromPayload({
    status: 'Accepted',
    credit_search: 'already searched',
    signature: 'signed',
    confirmed: 'yes',
    reason: 'n/a-field',
  });
  assert.deepStrictEqual(changes, {
    initial_status: 'accepted',
    search_status: 'searched',
    signature_status: 'passed',
    law_firm_confirmed: true,
    rejection_reason: 'n/a-field',
  });
  assert.deepStrictEqual(canonicalFromPayload({ foo: 'bar' }), {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test`
Expected: FAIL — `Cannot find module '../services/statusService'`

- [ ] **Step 3: Write implementations**

`backend/services/statusService.js`:
```js
const { computeMoney } = require('./moneyEngine');

const UPDATABLE_FIELDS = [
  'initial_status',
  'rejection_reason',
  'search_status',
  'signature_status',
  'law_firm_confirmed',
  'platform_ref',
];

// Single choke-point for every status mutation (api/webhook/import/manual):
// history append + needs_replacement rule + money recompute.
function applyStatusChanges(lead, changes, rateCard, { source, user } = {}) {
  const now = new Date();
  const record = (field, from, to) => lead.history.push({ at: now, field, from, to, source, user });

  for (const field of UPDATABLE_FIELDS) {
    if (!(field in changes)) continue;
    const to = changes[field];
    if (to === undefined || lead[field] === to) continue;
    record(field, lead[field], to);
    lead[field] = to;
  }

  if (lead.signature_status === 'failed' && !lead.needs_replacement) {
    record('needs_replacement', false, true);
    lead.needs_replacement = true;
  }

  const money = computeMoney(lead, rateCard);
  if (lead.payable_status !== money.payable_status) {
    record('payable_status', lead.payable_status, money.payable_status);
    lead.payable_status = money.payable_status;
  }
  lead.amounts = {
    upfront_due: money.upfront_due,
    confirmation_due: money.confirmation_due,
    total_due: money.total_due,
  };
  return lead;
}

module.exports = { applyStatusChanges, UPDATABLE_FIELDS };
```

`backend/services/normalize.js`:
```js
// Maps the many spellings platforms use to our canonical enum values.
// Unrecognized input -> undefined (callers skip the field; we never guess).
const MAPS = {
  initial_status: {
    accepted: 'accepted', approved: 'accepted', success: 'accepted', accept: 'accepted',
    rejected: 'rejected', declined: 'rejected', refused: 'rejected', reject: 'rejected',
    pending: 'pending', processing: 'pending',
  },
  search_status: {
    virgin: 'virgin', new: 'virgin', unsearched: 'virgin', 'non-searched': 'virgin',
    'non searched': 'virgin', 'not searched': 'virgin',
    searched: 'searched', existing: 'searched', 'already searched': 'searched',
    'already_searched': 'searched',
  },
  signature_status: {
    passed: 'passed', signed: 'passed', valid: 'passed', true: 'passed', yes: 'passed',
    failed: 'failed', false: 'failed', invalid: 'failed', no: 'failed', missing: 'failed',
    unsigned: 'failed',
    pending: 'pending', awaiting: 'pending', 'awaiting signature': 'pending',
  },
  law_firm_confirmed: {
    true: true, yes: true, confirmed: true, payable: true,
    false: false, no: false, unconfirmed: false,
  },
};

function normalizeField(field, raw) {
  if (raw === undefined || raw === null) return undefined;
  if (field === 'law_firm_confirmed' && typeof raw === 'boolean') return raw;
  const key = String(raw).trim().toLowerCase();
  const map = MAPS[field];
  return map ? map[key] : undefined;
}

// Best-effort canonical changes from an arbitrary webhook/report payload.
function canonicalFromPayload(p) {
  const out = {};
  const tryKeys = (field, keys) => {
    for (const k of keys) {
      if (p[k] === undefined || p[k] === null || p[k] === '') continue;
      const v = normalizeField(field, p[k]);
      if (v !== undefined) { out[field] = v; return; }
    }
  };
  tryKeys('initial_status', ['initial_status', 'status', 'result', 'outcome']);
  tryKeys('search_status', ['search_status', 'search_type', 'credit_search', 'search']);
  tryKeys('signature_status', ['signature_status', 'signature', 'signed', 'esign']);
  tryKeys('law_firm_confirmed', ['law_firm_confirmed', 'confirmed', 'payable_confirmed', 'confirmation']);
  const reason = p.rejection_reason || p.reason || p.reject_reason;
  if (reason) out.rejection_reason = String(reason);
  return out;
}

module.exports = { normalizeField, canonicalFromPayload };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npm test`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add backend/services/statusService.js backend/services/normalize.js backend/tests/statusService.test.js backend/tests/normalize.test.js
git commit -m "feat: status service with audit history plus value normalizer"
```

---

### Task 5: Auth — login route, JWT middleware, admin seed script

**Files:**
- Create: `backend/middleware/auth.js`, `backend/routes/authRoutes.js`, `backend/scripts/createAdmin.js`
- Modify: `backend/server.js` (mount router)
- Test: `backend/tests/auth.test.js`

**Interfaces:**
- Consumes: `User` model (Task 2).
- Produces:
  - `signToken(user) -> jwt` , `requireAuth` (verifies `Authorization: Bearer`, sets `req.user = { id, role, affiliate_id, email }`), `requireAdmin` from `middleware/auth.js`.
  - `POST /api/v1/auth/login {email,password} -> { token, role, email, affiliate_id }`.
  - Later tasks mount their routers in `server.js` exactly like this task does.

- [ ] **Step 1: Write the failing test**

`backend/tests/auth.test.js`:
```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

test('login returns token for valid credentials', async () => {
  await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('secret1', 10), role: 'admin' });
  const res = await request(createApp())
    .post('/api/v1/auth/login')
    .send({ email: 'admin@x.com', password: 'secret1' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token);
  assert.strictEqual(res.body.role, 'admin');
});

test('login rejects bad password', async () => {
  await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('secret1', 10), role: 'admin' });
  const res = await request(createApp())
    .post('/api/v1/auth/login')
    .send({ email: 'admin@x.com', password: 'wrong' });
  assert.strictEqual(res.status, 401);
});

test('requireAuth blocks missing/invalid token', async () => {
  const res = await request(createApp()).get('/api/v1/dashboard/leads');
  assert.strictEqual(res.status, 401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — login route 404 (route not mounted yet). The `requireAuth` test also 404s — it goes green in Task 8 when the leads route exists; assert 401 there. For now change nothing: expect the two login tests failing.

- [ ] **Step 3: Write implementation**

`backend/middleware/auth.js`:
```js
const jwt = require('jsonwebtoken');

function signToken(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role, affiliate_id: user.affiliate_id || null, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'auth required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

module.exports = { signToken, requireAuth, requireAdmin };
```

`backend/routes/authRoutes.js`:
```js
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { signToken } = require('../middleware/auth');

const router = express.Router();

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = await User.findOne({ email: String(email).toLowerCase() });
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  res.json({ token: signToken(user), role: user.role, email: user.email, affiliate_id: user.affiliate_id });
});

module.exports = router;
```

In `backend/server.js`, add inside `createApp()` after the health route:
```js
  app.use('/api/v1', require('./routes/authRoutes'));
```

`backend/scripts/createAdmin.js`:
```js
// Usage: node scripts/createAdmin.js admin@example.com 'password'
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { connectDB } = require('../config/db');
const User = require('../models/User');

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node scripts/createAdmin.js <email> <password>');
    process.exit(1);
  }
  await connectDB();
  await User.findOneAndUpdate(
    { email: email.toLowerCase() },
    { email: email.toLowerCase(), password_hash: bcrypt.hashSync(password, 10), role: 'admin' },
    { upsert: true }
  );
  console.log(`Admin ${email} ready`);
  process.exit(0);
}
main();
```

- [ ] **Step 4: Run tests — login tests pass**

Run: `cd backend && npm test`
Expected: both login tests PASS. The `requireAuth blocks` test still fails (404 — leads route arrives in Task 8). Temporarily mark that test `{ todo: true }`:
```js
test('requireAuth blocks missing/invalid token', { todo: true }, async () => {
```
(Task 8 removes the todo flag.)

- [ ] **Step 5: Commit**

```bash
git add backend/middleware/auth.js backend/routes/authRoutes.js backend/scripts/createAdmin.js backend/server.js backend/tests/auth.test.js
git commit -m "feat: JWT auth with login route and admin seed script"
```

---

### Task 6: Affiliate admin CRUD, API keys, affiliate user creation

**Files:**
- Create: `backend/services/apiKeys.js`, `backend/routes/affiliateRoutes.js`
- Modify: `backend/server.js` (mount router)
- Test: `backend/tests/affiliates.test.js`

**Interfaces:**
- Consumes: `requireAuth`, `requireAdmin`, `signToken` (Task 5); `Affiliate`, `User` models (Task 2).
- Produces:
  - `generateApiKey() -> { key, hash, prefix }` and `sha256hex(str) -> hex` from `services/apiKeys.js` (Task 7's ingest auth uses `sha256hex`).
  - Admin routes: `GET /api/v1/affiliates`, `POST /api/v1/affiliates` (returns `{ affiliate, api_key }` — key shown once), `PATCH /api/v1/affiliates/:id`, `POST /api/v1/affiliates/:id/rotate-key` (returns `{ api_key }`), `POST /api/v1/affiliates/:id/users {email,password}`.

- [ ] **Step 1: Write the failing test**

`backend/tests/affiliates.test.js`:
```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const User = require('../models/User');
const Affiliate = require('../models/Affiliate');
const { signToken } = require('../middleware/auth');
const { sha256hex } = require('../services/apiKeys');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

async function adminToken() {
  const u = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  return signToken(u);
}

test('create affiliate returns api key once and stores only hash', async () => {
  const app = createApp();
  const token = await adminToken();
  const res = await request(app)
    .post('/api/v1/affiliates')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Acme', lead_source: 'acme', brands: ['acmeclaims.co.uk'], rate_card: { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 } });
  assert.strictEqual(res.status, 201);
  assert.ok(res.body.api_key.length >= 32);
  const stored = await Affiliate.findById(res.body.affiliate._id);
  assert.strictEqual(stored.api_key_hash, sha256hex(res.body.api_key));
  assert.ok(!JSON.stringify(res.body.affiliate).includes(res.body.api_key));
});

test('rotate key replaces hash', async () => {
  const app = createApp();
  const token = await adminToken();
  const created = await request(app).post('/api/v1/affiliates').set('Authorization', `Bearer ${token}`).send({ name: 'A', lead_source: 'a1' });
  const oldHash = (await Affiliate.findById(created.body.affiliate._id)).api_key_hash;
  const rotated = await request(app).post(`/api/v1/affiliates/${created.body.affiliate._id}/rotate-key`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(rotated.status, 200);
  const newHash = (await Affiliate.findById(created.body.affiliate._id)).api_key_hash;
  assert.notStrictEqual(oldHash, newHash);
  assert.strictEqual(newHash, sha256hex(rotated.body.api_key));
});

test('non-admin cannot access affiliate routes', async () => {
  const app = createApp();
  const aff = await Affiliate.create({ name: 'X', lead_source: 'x1' });
  const u = await User.create({ email: 'aff@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: aff._id });
  const res = await request(app).get('/api/v1/affiliates').set('Authorization', `Bearer ${signToken(u)}`);
  assert.strictEqual(res.status, 403);
});

test('admin can create affiliate login user', async () => {
  const app = createApp();
  const token = await adminToken();
  const aff = await Affiliate.create({ name: 'X', lead_source: 'x2' });
  const res = await request(app)
    .post(`/api/v1/affiliates/${aff._id}/users`)
    .set('Authorization', `Bearer ${token}`)
    .send({ email: 'supplier@x.com', password: 'pass1234' });
  assert.strictEqual(res.status, 201);
  const u = await User.findOne({ email: 'supplier@x.com' });
  assert.strictEqual(u.role, 'affiliate');
  assert.strictEqual(u.affiliate_id.toString(), aff._id.toString());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `Cannot find module '../services/apiKeys'`

- [ ] **Step 3: Write implementation**

`backend/services/apiKeys.js`:
```js
const crypto = require('crypto');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function generateApiKey() {
  const key = crypto.randomBytes(24).toString('hex'); // 48 chars
  return { key, hash: sha256hex(key), prefix: key.slice(0, 8) };
}

module.exports = { generateApiKey, sha256hex };
```

`backend/routes/affiliateRoutes.js`:
```js
const express = require('express');
const bcrypt = require('bcryptjs');
const Affiliate = require('../models/Affiliate');
const User = require('../models/User');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { generateApiKey } = require('../services/apiKeys');

const router = express.Router();
router.use('/affiliates', requireAuth, requireAdmin);

router.get('/affiliates', async (req, res) => {
  const affiliates = await Affiliate.find().sort({ name: 1 }).select('-api_key_hash').lean();
  res.json(affiliates);
});

router.post('/affiliates', async (req, res) => {
  const { name, lead_source, brands, rate_card } = req.body || {};
  if (!name || !lead_source) return res.status(400).json({ error: 'name and lead_source required' });
  const { key, hash, prefix } = generateApiKey();
  try {
    const affiliate = await Affiliate.create({ name, lead_source, brands, rate_card, api_key_hash: hash, api_key_prefix: prefix });
    const safe = affiliate.toObject();
    delete safe.api_key_hash;
    res.status(201).json({ affiliate: safe, api_key: key });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'lead_source already exists' });
    throw e;
  }
});

router.patch('/affiliates/:id', async (req, res) => {
  const allowed = {};
  for (const f of ['name', 'brands', 'rate_card', 'active']) {
    if (f in req.body) allowed[f] = req.body[f];
  }
  const affiliate = await Affiliate.findByIdAndUpdate(req.params.id, allowed, { new: true }).select('-api_key_hash');
  if (!affiliate) return res.status(404).json({ error: 'not found' });
  res.json(affiliate);
});

router.post('/affiliates/:id/rotate-key', async (req, res) => {
  const { key, hash, prefix } = generateApiKey();
  const affiliate = await Affiliate.findByIdAndUpdate(req.params.id, { api_key_hash: hash, api_key_prefix: prefix }, { new: true });
  if (!affiliate) return res.status(404).json({ error: 'not found' });
  res.json({ api_key: key, api_key_prefix: prefix });
});

router.post('/affiliates/:id/users', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const affiliate = await Affiliate.findById(req.params.id);
  if (!affiliate) return res.status(404).json({ error: 'not found' });
  try {
    const user = await User.create({
      email, password_hash: bcrypt.hashSync(password, 10), role: 'affiliate', affiliate_id: affiliate._id,
    });
    res.status(201).json({ email: user.email, role: user.role, affiliate_id: user.affiliate_id });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'email already exists' });
    throw e;
  }
});

module.exports = router;
```

In `backend/server.js`, after the auth router line, add:
```js
  app.use('/api/v1', require('./routes/affiliateRoutes'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (all affiliate tests)

- [ ] **Step 5: Commit**

```bash
git add backend/services/apiKeys.js backend/routes/affiliateRoutes.js backend/server.js backend/tests/affiliates.test.js
git commit -m "feat: affiliate CRUD with hashed api keys and affiliate user creation"
```

---

### Task 7: Lead ingest endpoint (API-key auth, platform adapter, replacement linking)

**Files:**
- Create: `backend/middleware/apiKey.js`, `backend/services/platformAdapter.js`, `backend/routes/leadIngest.js`
- Modify: `backend/server.js` (mount router)
- Test: `backend/tests/ingest.test.js`

**Interfaces:**
- Consumes: `sha256hex` (Task 6), `nextLeadRef` (Task 2), `applyStatusChanges` (Task 4), models.
- Produces:
  - `apiKeyAuth` middleware — sets `req.affiliate` from `X-API-Key` (per-affiliate) or `SHARED_API_KEY` + body `lead_source`.
  - `submitLead(lead) -> Promise<null | {initial_status, rejection_reason, search_status, platform_ref, raw}>` from `platformAdapter.js` (manual mode returns `null`).
  - `POST /api/v1/leads` (rate-limited 120/min/IP) — validates name + (email|phone), assigns ref, links `replaces_ref`, responds `201 { ref, status }`.

- [ ] **Step 1: Write the failing test**

`backend/tests/ingest.test.js`:
```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setupDB, teardownDB, clearDB } = require('./helpers');
const { createApp } = require('../server');
const Affiliate = require('../models/Affiliate');
const Lead = require('../models/Lead');
const { generateApiKey } = require('../services/apiKeys');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

async function makeAffiliate(lead_source = 'acme') {
  const { key, hash, prefix } = generateApiKey();
  const aff = await Affiliate.create({
    name: 'Acme', lead_source, api_key_hash: hash, api_key_prefix: prefix,
    rate_card: { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 },
  });
  return { aff, key };
}

test('valid submission creates pending lead with ref and 48h signature deadline', async () => {
  const { key } = await makeAffiliate();
  const res = await request(createApp())
    .post('/api/v1/leads')
    .set('X-API-Key', key)
    .send({ first_name: 'John', last_name: 'Smith', email: 'j@x.com', phone: '07700900000', brand: 'acmeclaims.co.uk' });
  assert.strictEqual(res.status, 201);
  assert.match(res.body.ref, /^KB-\d{4}-\d{6}$/);
  assert.strictEqual(res.body.status, 'pending');
  const lead = await Lead.findOne({ ref: res.body.ref });
  assert.strictEqual(lead.applicant_name, 'John Smith');
  const hours = (lead.signature_deadline - lead.submitted_at) / 36e5;
  assert.ok(Math.abs(hours - 48) < 0.01);
  assert.deepStrictEqual(lead.payload.email, 'j@x.com');
});

test('bad api key -> 401; missing contact -> 400', async () => {
  await makeAffiliate();
  const app = createApp();
  const bad = await request(app).post('/api/v1/leads').set('X-API-Key', 'nope').send({ first_name: 'A', last_name: 'B', email: 'a@b.c' });
  assert.strictEqual(bad.status, 401);
  const { key } = await makeAffiliate('two');
  const invalid = await request(app).post('/api/v1/leads').set('X-API-Key', key).send({ first_name: 'A', last_name: 'B' });
  assert.strictEqual(invalid.status, 400);
});

test('shared key requires and resolves lead_source', async () => {
  process.env.SHARED_API_KEY = 'shared-key-123';
  const { aff } = await makeAffiliate('sharedsrc');
  const app = createApp();
  const missing = await request(app).post('/api/v1/leads').set('X-API-Key', 'shared-key-123').send({ first_name: 'A', last_name: 'B', email: 'a@b.c' });
  assert.strictEqual(missing.status, 400);
  const ok = await request(app).post('/api/v1/leads').set('X-API-Key', 'shared-key-123').send({ first_name: 'A', last_name: 'B', email: 'a@b.c', lead_source: 'sharedsrc' });
  assert.strictEqual(ok.status, 201);
  const lead = await Lead.findOne({ ref: ok.body.ref });
  assert.strictEqual(lead.affiliate_id.toString(), aff._id.toString());
  delete process.env.SHARED_API_KEY;
});

test('replaces_ref links replacement and zeroes the original', async () => {
  const { aff, key } = await makeAffiliate();
  const app = createApp();
  const first = await request(app).post('/api/v1/leads').set('X-API-Key', key).send({ first_name: 'Old', last_name: 'Lead', email: 'o@x.com' });
  // simulate: original was accepted virgin then signature failed
  const orig = await Lead.findOne({ ref: first.body.ref });
  const { applyStatusChanges } = require('../services/statusService');
  applyStatusChanges(orig, { initial_status: 'accepted', search_status: 'virgin', signature_status: 'failed' }, aff.rate_card, { source: 'manual' });
  await orig.save();
  const second = await request(app).post('/api/v1/leads').set('X-API-Key', key).send({ first_name: 'New', last_name: 'Lead', email: 'n@x.com', replaces_ref: first.body.ref });
  assert.strictEqual(second.status, 201);
  const updatedOrig = await Lead.findOne({ ref: first.body.ref });
  const replacement = await Lead.findOne({ ref: second.body.ref });
  assert.strictEqual(updatedOrig.payable_status, 'replaced');
  assert.strictEqual(updatedOrig.amounts.total_due, 0);
  assert.strictEqual(updatedOrig.replaced_by_lead.toString(), replacement._id.toString());
  assert.strictEqual(replacement.replaces_lead.toString(), updatedOrig._id.toString());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — POST /api/v1/leads 404

- [ ] **Step 3: Write implementation**

`backend/middleware/apiKey.js`:
```js
const Affiliate = require('../models/Affiliate');
const { sha256hex } = require('../services/apiKeys');

async function apiKeyAuth(req, res, next) {
  const key = req.get('X-API-Key');
  if (!key) return res.status(401).json({ error: 'X-API-Key required' });

  if (process.env.SHARED_API_KEY && key === process.env.SHARED_API_KEY) {
    const src = (req.body?.lead_source || '').toLowerCase().trim();
    if (!src) return res.status(400).json({ error: 'lead_source required with shared key' });
    const affiliate = await Affiliate.findOne({ lead_source: src, active: true });
    if (!affiliate) return res.status(401).json({ error: 'unknown lead_source' });
    req.affiliate = affiliate;
    return next();
  }

  const affiliate = await Affiliate.findOne({ api_key_hash: sha256hex(key), active: true });
  if (!affiliate) return res.status(401).json({ error: 'invalid api key' });
  req.affiliate = affiliate;
  next();
}

module.exports = { apiKeyAuth };
```

`backend/services/platformAdapter.js`:
```js
// Buyer-platform adapter. MANUAL MODE: the platform's API docs are pending,
// so submission returns null and leads stay `pending`; statuses arrive via
// webhook / CSV import / manual adjustment instead.
//
// When docs arrive, implement the HTTP call here and return the canonical
// shape — nothing else in the codebase changes:
//   { initial_status, rejection_reason, search_status, platform_ref, raw }
async function submitLead(lead) {
  return null;
}

module.exports = { submitLead };
```

`backend/routes/leadIngest.js`:
```js
const express = require('express');
const rateLimit = require('express-rate-limit');
const Lead = require('../models/Lead');
const { nextLeadRef } = require('../models/Counter');
const { apiKeyAuth } = require('../middleware/apiKey');
const { applyStatusChanges } = require('../services/statusService');
const { submitLead } = require('../services/platformAdapter');

const router = express.Router();
const ingestLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true });

router.post('/leads', ingestLimiter, apiKeyAuth, async (req, res) => {
  const body = req.body || {};
  const applicant_name = (body.name || `${body.first_name || ''} ${body.last_name || ''}`).trim();
  if (!applicant_name) return res.status(400).json({ error: 'name (or first_name/last_name) required' });
  if (!body.email && !body.phone) return res.status(400).json({ error: 'email or phone required' });

  const submitted_at = new Date();
  const lead = new Lead({
    ref: await nextLeadRef(submitted_at),
    affiliate_id: req.affiliate._id,
    lead_source: req.affiliate.lead_source,
    brand: body.brand || req.affiliate.brands?.[0] || '',
    submitted_at,
    signature_deadline: new Date(submitted_at.getTime() + 48 * 3600 * 1000),
    applicant_name,
    payload: body,
  });

  // Replacement for a signature-failed lead: link both ways, zero the original.
  if (body.replaces_ref) {
    const original = await Lead.findOne({ ref: body.replaces_ref, affiliate_id: req.affiliate._id });
    if (!original) return res.status(400).json({ error: `replaces_ref ${body.replaces_ref} not found` });
    lead.replaces_lead = original._id;
    original.replaced_by_lead = lead._id;
    original.history.push({ at: submitted_at, field: 'replaced_by_lead', from: null, to: lead.ref, source: 'api' });
    applyStatusChanges(original, {}, req.affiliate.rate_card, { source: 'api' });
    await original.save();
    lead.history.push({ at: submitted_at, field: 'replaces_lead', from: null, to: original.ref, source: 'api' });
  }

  // Forward to buyer platform (manual mode returns null -> stays pending).
  const platformResponse = await submitLead(lead);
  if (platformResponse) {
    applyStatusChanges(lead, platformResponse, req.affiliate.rate_card, { source: 'api' });
  }

  await lead.save();
  res.status(201).json({ ref: lead.ref, status: lead.initial_status });
});

module.exports = router;
```

In `backend/server.js`, after the affiliate router line, add:
```js
  app.use('/api/v1', require('./routes/leadIngest'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (all ingest tests)

- [ ] **Step 5: Commit**

```bash
git add backend/middleware/apiKey.js backend/services/platformAdapter.js backend/routes/leadIngest.js backend/server.js backend/tests/ingest.test.js
git commit -m "feat: lead ingest with api-key auth, manual-mode adapter, replacement linking"
```

---

### Task 8: Dashboard lead queries + manual adjustment (with affiliate scoping)

**Files:**
- Create: `backend/services/leadFilter.js`, `backend/routes/leadRoutes.js`
- Modify: `backend/server.js` (mount router), `backend/tests/auth.test.js` (remove `{ todo: true }`)
- Test: `backend/tests/leadRoutes.test.js`

**Interfaces:**
- Consumes: `requireAuth`, `requireAdmin` (Task 5), `applyStatusChanges` (Task 4), models.
- Produces:
  - `buildLeadFilter(query, user) -> mongoFilter` from `services/leadFilter.js` — shared with export (Task 12). Query params: `affiliate_id, brand, from, to, initial_status, search_status, signature_status, payable_status, needs_replacement, q`. Affiliate-role users ALWAYS get `affiliate_id` forced from the JWT.
  - `GET /api/v1/dashboard/leads` -> `{ rows, total }` (paginated, `page`/`limit`, sorted `submitted_at` desc, excludes `payload`/`history`).
  - `GET /api/v1/dashboard/leads/:id` -> full lead (scoped).
  - `PATCH /api/v1/dashboard/leads/:id` (admin only) — accepts UPDATABLE fields + `replaces_ref` (links THIS lead as replacement of another).

- [ ] **Step 1: Write the failing test**

`backend/tests/leadRoutes.test.js`:
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

const rates = { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 };

async function seed() {
  const affA = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: rates });
  const affB = await Affiliate.create({ name: 'B', lead_source: 'bbb', rate_card: rates });
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const affUser = await User.create({ email: 'a@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: affA._id });
  const leadA = await Lead.create({ ref: 'KB-2026-000001', affiliate_id: affA._id, lead_source: 'aaa', applicant_name: 'Alpha One', submitted_at: new Date('2026-07-01'), initial_status: 'accepted', search_status: 'virgin', payable_status: 'payable' });
  const leadB = await Lead.create({ ref: 'KB-2026-000002', affiliate_id: affB._id, lead_source: 'bbb', applicant_name: 'Beta Two', submitted_at: new Date('2026-07-02') });
  return { affA, affB, admin, affUser, leadA, leadB };
}

test('admin sees all leads; filters work', async () => {
  const { admin } = await seed();
  const app = createApp();
  const all = await request(app).get('/api/v1/dashboard/leads').set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(all.body.total, 2);
  const filtered = await request(app).get('/api/v1/dashboard/leads?initial_status=accepted').set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(filtered.body.total, 1);
  assert.strictEqual(filtered.body.rows[0].ref, 'KB-2026-000001');
});

test('affiliate user sees only own leads, even when requesting another affiliate_id', async () => {
  const { affUser, affB } = await seed();
  const app = createApp();
  const res = await request(app)
    .get(`/api/v1/dashboard/leads?affiliate_id=${affB._id}`)
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.body.total, 1);
  assert.strictEqual(res.body.rows[0].ref, 'KB-2026-000001');
});

test('affiliate cannot read another affiliate lead detail; cannot PATCH', async () => {
  const { affUser, leadB, leadA } = await seed();
  const app = createApp();
  const detail = await request(app).get(`/api/v1/dashboard/leads/${leadB._id}`).set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(detail.status, 404);
  const patch = await request(app).patch(`/api/v1/dashboard/leads/${leadA._id}`).set('Authorization', `Bearer ${signToken(affUser)}`).send({ initial_status: 'accepted' });
  assert.strictEqual(patch.status, 403);
});

test('admin PATCH applies status change with manual source history', async () => {
  const { admin, leadB } = await seed();
  const app = createApp();
  const res = await request(app)
    .patch(`/api/v1/dashboard/leads/${leadB._id}`)
    .set('Authorization', `Bearer ${signToken(admin)}`)
    .send({ initial_status: 'accepted', search_status: 'searched' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.payable_status, 'partial_pending_confirmation');
  assert.strictEqual(res.body.amounts.total_due, 15);
  const stored = await Lead.findById(leadB._id);
  assert.ok(stored.history.every((h) => h.source === 'manual' && h.user === 'admin@x.com'));
});

test('admin PATCH replaces_ref links this lead as replacement', async () => {
  const { admin, leadA, leadB } = await seed();
  const app = createApp();
  const res = await request(app)
    .patch(`/api/v1/dashboard/leads/${leadB._id}`)
    .set('Authorization', `Bearer ${signToken(admin)}`)
    .send({ replaces_ref: 'KB-2026-000001' });
  assert.strictEqual(res.status, 400); // different affiliate — must reject
  const own = await Lead.create({ ref: 'KB-2026-000003', affiliate_id: leadA.affiliate_id, lead_source: 'aaa', applicant_name: 'Alpha Three' });
  const ok = await request(app)
    .patch(`/api/v1/dashboard/leads/${own._id}`)
    .set('Authorization', `Bearer ${signToken(admin)}`)
    .send({ replaces_ref: 'KB-2026-000001' });
  assert.strictEqual(ok.status, 200);
  const orig = await Lead.findById(leadA._id);
  assert.strictEqual(orig.payable_status, 'replaced');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — /api/v1/dashboard/leads 404

- [ ] **Step 3: Write implementation**

`backend/services/leadFilter.js`:
```js
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Shared by lead list, stats and CSV export. Affiliate users are ALWAYS
// pinned to their own affiliate_id from the JWT — client filters can't widen it.
function buildLeadFilter(query, user) {
  const filter = {};
  if (user.role === 'affiliate') filter.affiliate_id = user.affiliate_id;
  else if (query.affiliate_id) filter.affiliate_id = query.affiliate_id;

  for (const f of ['brand', 'initial_status', 'search_status', 'signature_status', 'payable_status']) {
    if (query[f]) filter[f] = query[f];
  }
  if (query.needs_replacement === 'true') filter.needs_replacement = true;
  if (query.from || query.to) filter.submitted_at = {};
  if (query.from) filter.submitted_at.$gte = new Date(query.from);
  if (query.to) filter.submitted_at.$lte = new Date(new Date(query.to).setHours(23, 59, 59, 999));
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [{ ref: rx }, { applicant_name: rx }, { platform_ref: rx }];
  }
  return filter;
}

module.exports = { buildLeadFilter };
```

`backend/routes/leadRoutes.js`:
```js
const express = require('express');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { applyStatusChanges } = require('../services/statusService');
const { buildLeadFilter } = require('../services/leadFilter');

const router = express.Router();

router.get('/dashboard/leads', requireAuth, async (req, res) => {
  const filter = buildLeadFilter(req.query, req.user);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const [total, rows] = await Promise.all([
    Lead.countDocuments(filter),
    Lead.find(filter).sort({ submitted_at: -1 }).skip((page - 1) * limit).limit(limit)
      .select('-payload -history').populate('affiliate_id', 'name lead_source').lean(),
  ]);
  res.json({ rows, total });
});

router.get('/dashboard/leads/:id', requireAuth, async (req, res) => {
  const lead = await Lead.findById(req.params.id)
    .populate('affiliate_id', 'name lead_source')
    .populate('replaces_lead', 'ref')
    .populate('replaced_by_lead', 'ref')
    .lean();
  if (!lead) return res.status(404).json({ error: 'not found' });
  if (req.user.role === 'affiliate' && String(lead.affiliate_id._id) !== String(req.user.affiliate_id)) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json(lead);
});

router.patch('/dashboard/leads/:id', requireAuth, requireAdmin, async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const affiliate = await Affiliate.findById(lead.affiliate_id);
  const meta = { source: 'manual', user: req.user.email };
  const now = new Date();

  if (req.body.replaces_ref) {
    const original = await Lead.findOne({ ref: req.body.replaces_ref, affiliate_id: lead.affiliate_id });
    if (!original) return res.status(400).json({ error: `replaces_ref ${req.body.replaces_ref} not found for this affiliate` });
    lead.replaces_lead = original._id;
    original.replaced_by_lead = lead._id;
    original.history.push({ at: now, field: 'replaced_by_lead', from: null, to: lead.ref, source: 'manual', user: req.user.email });
    applyStatusChanges(original, {}, affiliate.rate_card, meta);
    await original.save();
    lead.history.push({ at: now, field: 'replaces_lead', from: null, to: original.ref, source: 'manual', user: req.user.email });
  }

  applyStatusChanges(lead, req.body, affiliate.rate_card, meta);
  await lead.save();
  res.json(lead.toObject());
});

module.exports = router;
```

In `backend/server.js`, after the ingest router line, add:
```js
  app.use('/api/v1', require('./routes/leadRoutes'));
```

In `backend/tests/auth.test.js`, remove the `{ todo: true }` flag from the `requireAuth blocks` test (route now exists → 401 assertion is live).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (all — including the previously-todo auth test)

- [ ] **Step 5: Commit**

```bash
git add backend/services/leadFilter.js backend/routes/leadRoutes.js backend/server.js backend/tests/leadRoutes.test.js backend/tests/auth.test.js
git commit -m "feat: scoped lead queries and admin manual adjustment"
```

---

### Task 9: Platform webhook endpoint + unmatched review queue

**Files:**
- Create: `backend/routes/webhookRoutes.js`
- Modify: `backend/server.js` (mount router)
- Test: `backend/tests/webhooks.test.js`

**Interfaces:**
- Consumes: `canonicalFromPayload` (Task 4), `applyStatusChanges` (Task 4), `requireAuth`/`requireAdmin` (Task 5), models.
- Produces:
  - `POST /api/v1/webhooks/platform` (public; optional `?token=` guarded by `WEBHOOK_TOKEN`) — stores every payload as `WebhookEvent`, matches lead by our `ref` (`KB-` prefix) else `platform_ref`, applies canonical changes with source `webhook`. Always 200 `{ received, matched }`.
  - `GET /api/v1/webhooks/unmatched` (admin) — latest 100 unmatched events.
  - `POST /api/v1/webhooks/:id/match {ref}` (admin) — manually attach an event to a lead and apply its payload.

- [ ] **Step 1: Write the failing test**

`backend/tests/webhooks.test.js`:
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
const WebhookEvent = require('../models/WebhookEvent');
const { signToken } = require('../middleware/auth');

before(setupDB);
after(teardownDB);
beforeEach(clearDB);

const rates = { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 };

async function seedLead() {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: rates });
  const lead = await Lead.create({ ref: 'KB-2026-000001', affiliate_id: aff._id, lead_source: 'aaa', applicant_name: 'John', platform_ref: 'PLAT-77' });
  return { aff, lead };
}

test('webhook matches by our ref and applies statuses', async () => {
  await seedLead();
  const res = await request(createApp())
    .post('/api/v1/webhooks/platform')
    .send({ ref: 'KB-2026-000001', status: 'accepted', credit_search: 'virgin' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.matched, true);
  const lead = await Lead.findOne({ ref: 'KB-2026-000001' });
  assert.strictEqual(lead.initial_status, 'accepted');
  assert.strictEqual(lead.payable_status, 'payable');
  assert.strictEqual(lead.amounts.total_due, 40);
  assert.ok(lead.history.every((h) => h.source === 'webhook'));
});

test('webhook matches by platform_ref; unmatched stored for review', async () => {
  await seedLead();
  const app = createApp();
  const byPlat = await request(app).post('/api/v1/webhooks/platform').send({ platform_ref: 'PLAT-77', signature: 'signed' });
  assert.strictEqual(byPlat.body.matched, true);
  const nomatch = await request(app).post('/api/v1/webhooks/platform').send({ platform_ref: 'UNKNOWN-1', status: 'accepted' });
  assert.strictEqual(nomatch.body.matched, false);
  const events = await WebhookEvent.find({ matched_lead: null });
  assert.strictEqual(events.length, 1);
});

test('webhook token enforced when configured', async () => {
  process.env.WEBHOOK_TOKEN = 'sekret';
  const res = await request(createApp()).post('/api/v1/webhooks/platform').send({ ref: 'x' });
  assert.strictEqual(res.status, 401);
  const ok = await request(createApp()).post('/api/v1/webhooks/platform?token=sekret').send({ ref: 'x' });
  assert.strictEqual(ok.status, 200);
  delete process.env.WEBHOOK_TOKEN;
});

test('admin can manually match an unmatched event', async () => {
  const { lead } = await seedLead();
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const app = createApp();
  await request(app).post('/api/v1/webhooks/platform').send({ platform_ref: 'UNKNOWN-9', status: 'rejected', reason: 'no credit file' });
  const event = await WebhookEvent.findOne({ matched_lead: null });
  const res = await request(app)
    .post(`/api/v1/webhooks/${event._id}/match`)
    .set('Authorization', `Bearer ${signToken(admin)}`)
    .send({ ref: 'KB-2026-000001' });
  assert.strictEqual(res.status, 200);
  const updated = await Lead.findById(lead._id);
  assert.strictEqual(updated.initial_status, 'rejected');
  assert.strictEqual(updated.rejection_reason, 'no credit file');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — /api/v1/webhooks/platform 404

- [ ] **Step 3: Write implementation**

`backend/routes/webhookRoutes.js`:
```js
const express = require('express');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const WebhookEvent = require('../models/WebhookEvent');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { canonicalFromPayload } = require('../services/normalize');
const { applyStatusChanges } = require('../services/statusService');

const router = express.Router();

async function applyEventToLead(event, lead) {
  const changes = canonicalFromPayload(event.payload);
  const pref = event.payload.platform_ref || event.payload.reference || event.payload.id;
  if (pref && !lead.platform_ref) changes.platform_ref = String(pref);
  const affiliate = await Affiliate.findById(lead.affiliate_id);
  applyStatusChanges(lead, changes, affiliate.rate_card, { source: 'webhook' });
  await lead.save();
  event.matched_lead = lead._id;
  await event.save();
}

router.post('/webhooks/platform', async (req, res) => {
  if (process.env.WEBHOOK_TOKEN && req.query.token !== process.env.WEBHOOK_TOKEN) {
    return res.status(401).json({ error: 'bad token' });
  }
  const payload = req.body || {};
  const event = await WebhookEvent.create({ payload, source_ip: req.ip });

  let lead = null;
  if (typeof payload.ref === 'string' && payload.ref.startsWith('KB-')) {
    lead = await Lead.findOne({ ref: payload.ref });
  }
  const pref = payload.platform_ref || payload.reference || payload.id;
  if (!lead && pref) lead = await Lead.findOne({ platform_ref: String(pref) });

  if (lead) await applyEventToLead(event, lead);
  res.json({ received: true, matched: !!lead });
});

router.get('/webhooks/unmatched', requireAuth, requireAdmin, async (req, res) => {
  const events = await WebhookEvent.find({ matched_lead: null }).sort({ at: -1 }).limit(100).lean();
  res.json(events);
});

router.post('/webhooks/:id/match', requireAuth, requireAdmin, async (req, res) => {
  const event = await WebhookEvent.findById(req.params.id);
  if (!event) return res.status(404).json({ error: 'event not found' });
  const lead = await Lead.findOne({ ref: req.body?.ref });
  if (!lead) return res.status(400).json({ error: 'lead ref not found' });
  await applyEventToLead(event, lead);
  res.json({ matched: true, lead_ref: lead.ref });
});

module.exports = router;
```

In `backend/server.js`, after the lead routes line, add:
```js
  app.use('/api/v1', require('./routes/webhookRoutes'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/routes/webhookRoutes.js backend/server.js backend/tests/webhooks.test.js
git commit -m "feat: platform webhook capture with matching and review queue"
```

---

### Task 10: CSV import (preview, mapping, apply, history)

**Files:**
- Create: `backend/routes/importRoutes.js`
- Modify: `backend/server.js` (mount router)
- Test: `backend/tests/imports.test.js`

**Interfaces:**
- Consumes: `normalizeField` (Task 4), `applyStatusChanges` (Task 4), `requireAuth`/`requireAdmin` (Task 5), models, multer.
- Produces (all admin-only):
  - `POST /api/v1/imports/preview` (multipart `file`) -> `{ headers: [], rows: [first 5 as objects] }`
  - `POST /api/v1/imports` (multipart `file` + text field `mapping` = JSON `{ match_by: 'ref'|'platform_ref', columns: { ref?, platform_ref?, initial_status?, rejection_reason?, search_status?, signature_status?, law_firm_confirmed? } }`) -> `{ row_count, matched, unmatched }`
  - `GET /api/v1/imports` -> import history (latest 50)
  - `GET /api/v1/imports/last-mapping` -> most recent mapping or `null` (UI default)

- [ ] **Step 1: Write the failing test**

`backend/tests/imports.test.js`:
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

const rates = { virgin_rate: 40, searched_upfront_rate: 15, searched_confirmation_rate: 25 };
const CSV = [
  'Our Ref,Status,Search Type,Signature,Confirmed,Reason',
  'KB-2026-000001,Accepted,already searched,signed,,',
  'KB-2026-000002,Declined,,,,No credit file',
  'KB-2026-999999,Accepted,virgin,,,',
].join('\n');
const MAPPING = {
  match_by: 'ref',
  columns: {
    ref: 'Our Ref', initial_status: 'Status', search_status: 'Search Type',
    signature_status: 'Signature', law_firm_confirmed: 'Confirmed', rejection_reason: 'Reason',
  },
};

async function seed() {
  const aff = await Affiliate.create({ name: 'A', lead_source: 'aaa', rate_card: rates });
  await Lead.create({ ref: 'KB-2026-000001', affiliate_id: aff._id, lead_source: 'aaa', applicant_name: 'One' });
  await Lead.create({ ref: 'KB-2026-000002', affiliate_id: aff._id, lead_source: 'aaa', applicant_name: 'Two' });
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  return signToken(admin);
}

test('preview returns headers and sample rows', async () => {
  const token = await seed();
  const res = await request(createApp())
    .post('/api/v1/imports/preview')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(CSV), 'report.csv');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.headers, ['Our Ref', 'Status', 'Search Type', 'Signature', 'Confirmed', 'Reason']);
  assert.strictEqual(res.body.rows.length, 3);
});

test('apply updates matched leads, counts unmatched, saves record', async () => {
  const token = await seed();
  const app = createApp();
  const res = await request(app)
    .post('/api/v1/imports')
    .set('Authorization', `Bearer ${token}`)
    .field('mapping', JSON.stringify(MAPPING))
    .attach('file', Buffer.from(CSV), 'report.csv');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(
    { row_count: res.body.row_count, matched: res.body.matched, unmatched: res.body.unmatched },
    { row_count: 3, matched: 2, unmatched: 1 }
  );
  const one = await Lead.findOne({ ref: 'KB-2026-000001' });
  assert.strictEqual(one.initial_status, 'accepted');
  assert.strictEqual(one.search_status, 'searched');
  assert.strictEqual(one.signature_status, 'passed');
  assert.strictEqual(one.payable_status, 'partial_pending_confirmation');
  assert.strictEqual(one.amounts.total_due, 15);
  assert.ok(one.history.every((h) => h.source === 'import' && h.user === 'admin@x.com'));
  const two = await Lead.findOne({ ref: 'KB-2026-000002' });
  assert.strictEqual(two.initial_status, 'rejected');
  assert.strictEqual(two.rejection_reason, 'No credit file');
  const last = await request(app).get('/api/v1/imports/last-mapping').set('Authorization', `Bearer ${token}`);
  assert.deepStrictEqual(last.body, MAPPING);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — /api/v1/imports/preview 404

- [ ] **Step 3: Write implementation**

`backend/routes/importRoutes.js`:
```js
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const ImportRecord = require('../models/ImportRecord');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { normalizeField } = require('../services/normalize');
const { applyStatusChanges } = require('../services/statusService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.use('/imports', requireAuth, requireAdmin);

const STATUS_FIELDS = ['initial_status', 'search_status', 'signature_status', 'law_firm_confirmed'];
const TEXT_FIELDS = ['platform_ref', 'rejection_reason'];

function parseCsv(buffer) {
  return parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
}

router.post('/imports/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const rows = parseCsv(req.file.buffer);
  res.json({ headers: rows.length ? Object.keys(rows[0]) : [], rows: rows.slice(0, 5) });
});

router.post('/imports', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  let mapping;
  try {
    mapping = JSON.parse(req.body.mapping);
  } catch {
    return res.status(400).json({ error: 'mapping must be valid JSON' });
  }
  if (!['ref', 'platform_ref'].includes(mapping.match_by) || !mapping.columns?.[mapping.match_by]) {
    return res.status(400).json({ error: 'mapping.match_by must be ref or platform_ref with a mapped column' });
  }

  const rows = parseCsv(req.file.buffer);
  const rateCards = new Map(); // affiliate_id -> rate_card, cached per import
  let matched = 0;
  let unmatched = 0;

  for (const row of rows) {
    const matchVal = (row[mapping.columns[mapping.match_by]] || '').trim();
    const lead = matchVal
      ? await Lead.findOne(mapping.match_by === 'ref' ? { ref: matchVal } : { platform_ref: matchVal })
      : null;
    if (!lead) { unmatched++; continue; }

    const changes = {};
    for (const field of [...STATUS_FIELDS, ...TEXT_FIELDS]) {
      const col = mapping.columns[field];
      if (!col || row[col] === undefined || row[col] === '') continue;
      changes[field] = STATUS_FIELDS.includes(field) ? normalizeField(field, row[col]) : row[col];
    }

    const affId = lead.affiliate_id.toString();
    if (!rateCards.has(affId)) {
      const aff = await Affiliate.findById(affId).lean();
      rateCards.set(affId, aff.rate_card);
    }
    applyStatusChanges(lead, changes, rateCards.get(affId), { source: 'import', user: req.user.email });
    await lead.save();
    matched++;
  }

  await ImportRecord.create({
    filename: req.file.originalname, uploaded_by: req.user.email,
    row_count: rows.length, matched, unmatched, mapping,
  });
  res.json({ row_count: rows.length, matched, unmatched });
});

router.get('/imports', async (req, res) => {
  res.json(await ImportRecord.find().sort({ at: -1 }).limit(50).lean());
});

router.get('/imports/last-mapping', async (req, res) => {
  const last = await ImportRecord.findOne().sort({ at: -1 }).lean();
  res.json(last ? last.mapping : null);
});

module.exports = router;
```

In `backend/server.js`, after the webhook router line, add:
```js
  app.use('/api/v1', require('./routes/importRoutes'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/routes/importRoutes.js backend/server.js backend/tests/imports.test.js
git commit -m "feat: CSV import with column mapping, preview and audit history"
```

---

### Task 11: Stats — summary + affiliate breakdown

**Files:**
- Create: `backend/routes/statsRoutes.js`
- Modify: `backend/server.js` (mount router)
- Test: `backend/tests/stats.test.js`

**Interfaces:**
- Consumes: `buildLeadFilter` (Task 8), `requireAuth` (Task 5), models.
- Produces:
  - `GET /api/v1/dashboard/summary?from&to` -> `{ submitted, accepted, rejected, pending, acceptance_rate, rejection_rate, awaiting_signature, awaiting_confirmation, total_due }` (rates are 0–100, 1dp; date range defaults to today; affiliate users scoped).
  - `GET /api/v1/dashboard/affiliate-breakdown?from&to` -> `[{ affiliate_id, name, lead_source, submitted, accepted, rejected, pending, acceptance_rate, payable, replacements, owed }]` (affiliate users get only their row).

- [ ] **Step 1: Write the failing test**

`backend/tests/stats.test.js`:
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

async function seed() {
  const affA = await Affiliate.create({ name: 'A', lead_source: 'aaa' });
  const affB = await Affiliate.create({ name: 'B', lead_source: 'bbb' });
  const admin = await User.create({ email: 'admin@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const affUser = await User.create({ email: 'a@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: affA._id });
  const day = new Date('2026-07-05T10:00:00Z');
  await Lead.create({ ref: 'KB-2026-000001', affiliate_id: affA._id, submitted_at: day, initial_status: 'accepted', search_status: 'virgin', signature_status: 'pending', payable_status: 'payable', amounts: { upfront_due: 40, confirmation_due: 0, total_due: 40 } });
  await Lead.create({ ref: 'KB-2026-000002', affiliate_id: affA._id, submitted_at: day, initial_status: 'rejected' });
  await Lead.create({ ref: 'KB-2026-000003', affiliate_id: affB._id, submitted_at: day, initial_status: 'accepted', search_status: 'searched', signature_status: 'passed', payable_status: 'partial_pending_confirmation', amounts: { upfront_due: 15, confirmation_due: 0, total_due: 15 } });
  await Lead.create({ ref: 'KB-2026-000004', affiliate_id: affB._id, submitted_at: day, initial_status: 'pending' });
  return { admin, affUser };
}

test('summary counts and rates for admin', async () => {
  const { admin } = await seed();
  const res = await request(createApp())
    .get('/api/v1/dashboard/summary?from=2026-07-05&to=2026-07-05')
    .set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.submitted, 4);
  assert.strictEqual(res.body.accepted, 2);
  assert.strictEqual(res.body.rejected, 1);
  assert.strictEqual(res.body.pending, 1);
  assert.strictEqual(res.body.acceptance_rate, 50);
  assert.strictEqual(res.body.awaiting_signature, 1);
  assert.strictEqual(res.body.awaiting_confirmation, 1);
  assert.strictEqual(res.body.total_due, 55);
});

test('breakdown groups by affiliate; affiliate user sees only own row', async () => {
  const { admin, affUser } = await seed();
  const app = createApp();
  const adminRes = await request(app)
    .get('/api/v1/dashboard/affiliate-breakdown?from=2026-07-05&to=2026-07-05')
    .set('Authorization', `Bearer ${signToken(admin)}`);
  assert.strictEqual(adminRes.body.length, 2);
  const a = adminRes.body.find((r) => r.name === 'A');
  assert.deepStrictEqual(
    { submitted: a.submitted, accepted: a.accepted, owed: a.owed },
    { submitted: 2, accepted: 1, owed: 40 }
  );
  const affRes = await request(app)
    .get('/api/v1/dashboard/affiliate-breakdown?from=2026-07-05&to=2026-07-05')
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(affRes.body.length, 1);
  assert.strictEqual(affRes.body[0].name, 'A');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — /api/v1/dashboard/summary 404

- [ ] **Step 3: Write implementation**

`backend/routes/statsRoutes.js`:
```js
const express = require('express');
const Lead = require('../models/Lead');
const Affiliate = require('../models/Affiliate');
const { requireAuth } = require('../middleware/auth');
const { buildLeadFilter } = require('../services/leadFilter');

const router = express.Router();

const PAYABLE_STATUSES = ['payable', 'partial_pending_confirmation', 'payable_full'];
const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : 0);
const is = (field, val) => ({ $cond: [{ $eq: [`$${field}`, val] }, 1, 0] });

function dateRange(query) {
  // default: today
  const from = query.from ? new Date(query.from) : new Date(new Date().setHours(0, 0, 0, 0));
  const to = query.to ? new Date(new Date(query.to).setHours(23, 59, 59, 999)) : new Date(new Date().setHours(23, 59, 59, 999));
  return { from: from.toISOString(), to: to.toISOString() };
}

router.get('/dashboard/summary', requireAuth, async (req, res) => {
  const range = dateRange(req.query);
  const match = buildLeadFilter({ ...req.query, ...range }, req.user);
  const [g] = await Lead.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        submitted: { $sum: 1 },
        accepted: { $sum: is('initial_status', 'accepted') },
        rejected: { $sum: is('initial_status', 'rejected') },
        pending: { $sum: is('initial_status', 'pending') },
        awaiting_signature: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$initial_status', 'accepted'] }, { $eq: ['$signature_status', 'pending'] }] },
              1, 0,
            ],
          },
        },
        awaiting_confirmation: { $sum: is('payable_status', 'partial_pending_confirmation') },
        total_due: { $sum: '$amounts.total_due' },
      },
    },
  ]);
  const s = g || { submitted: 0, accepted: 0, rejected: 0, pending: 0, awaiting_signature: 0, awaiting_confirmation: 0, total_due: 0 };
  res.json({
    submitted: s.submitted,
    accepted: s.accepted,
    rejected: s.rejected,
    pending: s.pending,
    acceptance_rate: pct(s.accepted, s.submitted),
    rejection_rate: pct(s.rejected, s.submitted),
    awaiting_signature: s.awaiting_signature,
    awaiting_confirmation: s.awaiting_confirmation,
    total_due: s.total_due,
  });
});

router.get('/dashboard/affiliate-breakdown', requireAuth, async (req, res) => {
  const range = dateRange(req.query);
  const match = buildLeadFilter({ ...req.query, ...range }, req.user);
  const groups = await Lead.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$affiliate_id',
        submitted: { $sum: 1 },
        accepted: { $sum: is('initial_status', 'accepted') },
        rejected: { $sum: is('initial_status', 'rejected') },
        pending: { $sum: is('initial_status', 'pending') },
        payable: { $sum: { $cond: [{ $in: ['$payable_status', PAYABLE_STATUSES] }, 1, 0] } },
        replacements: { $sum: { $cond: ['$needs_replacement', 1, 0] } },
        owed: { $sum: '$amounts.total_due' },
      },
    },
  ]);
  const affiliates = await Affiliate.find({ _id: { $in: groups.map((r) => r._id) } }).select('name lead_source').lean();
  const byId = new Map(affiliates.map((a) => [a._id.toString(), a]));
  res.json(
    groups.map((r) => ({
      affiliate_id: r._id,
      name: byId.get(r._id.toString())?.name || 'unknown',
      lead_source: byId.get(r._id.toString())?.lead_source || '',
      submitted: r.submitted,
      accepted: r.accepted,
      rejected: r.rejected,
      pending: r.pending,
      acceptance_rate: pct(r.accepted, r.submitted),
      payable: r.payable,
      replacements: r.replacements,
      owed: r.owed,
    })).sort((a, b) => b.submitted - a.submitted)
  );
});

module.exports = router;
```

Note: `buildLeadFilter` receives `affiliate_id` as a string from queries; mongoose aggregation `$match` needs an ObjectId. Update `backend/services/leadFilter.js` to cast:
```js
const mongoose = require('mongoose');
```
and where `affiliate_id` is set (both branches), wrap:
```js
  if (user.role === 'affiliate') filter.affiliate_id = new mongoose.Types.ObjectId(String(user.affiliate_id));
  else if (query.affiliate_id) filter.affiliate_id = new mongoose.Types.ObjectId(String(query.affiliate_id));
```
(`Lead.find()` accepts ObjectId equally, so Task 8 routes keep working.)

In `backend/server.js`, after the import router line, add:
```js
  app.use('/api/v1', require('./routes/statsRoutes'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (stats tests AND all Task 8 lead-route tests still green after the ObjectId cast)

- [ ] **Step 5: Commit**

```bash
git add backend/routes/statsRoutes.js backend/services/leadFilter.js backend/server.js backend/tests/stats.test.js
git commit -m "feat: summary and per-affiliate breakdown stats"
```

---

### Task 12: CSV export

**Files:**
- Create: `backend/routes/exportRoutes.js`
- Modify: `backend/server.js` (mount router)
- Test: `backend/tests/export.test.js`

**Interfaces:**
- Consumes: `buildLeadFilter` (Task 8), `requireAuth` (Task 5), csv-stringify.
- Produces: `GET /api/v1/dashboard/export.csv?<same filters as leads list>` -> `text/csv` attachment `leads-export-YYYY-MM-DD.csv` with columns: `ref, submitted_at, affiliate, lead_source, brand, applicant_name, initial_status, rejection_reason, search_status, signature_status, signature_deadline, law_firm_confirmed, payable_status, upfront_due, confirmation_due, total_due, platform_ref, last_updated`. Affiliate users scoped as always.

- [ ] **Step 1: Write the failing test**

`backend/tests/export.test.js`:
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

test('export returns csv with headers, money columns and scoping', async () => {
  const affA = await Affiliate.create({ name: 'A', lead_source: 'aaa' });
  const affB = await Affiliate.create({ name: 'B', lead_source: 'bbb' });
  await Lead.create({ ref: 'KB-2026-000001', affiliate_id: affA._id, lead_source: 'aaa', applicant_name: 'One', initial_status: 'accepted', search_status: 'virgin', payable_status: 'payable', amounts: { upfront_due: 40, confirmation_due: 0, total_due: 40 } });
  await Lead.create({ ref: 'KB-2026-000002', affiliate_id: affB._id, lead_source: 'bbb', applicant_name: 'Two' });
  const affUser = await User.create({ email: 'a@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: affA._id });

  const res = await request(createApp())
    .get('/api/v1/dashboard/export.csv')
    .set('Authorization', `Bearer ${signToken(affUser)}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment; filename="leads-export-/);
  const lines = res.text.trim().split('\n');
  assert.strictEqual(lines.length, 2); // header + own lead only
  assert.match(lines[0], /^ref,submitted_at,affiliate,lead_source/);
  assert.match(lines[1], /^KB-2026-000001/);
  assert.match(lines[1], /,40,0,40,/);
  assert.ok(!res.text.includes('KB-2026-000002'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — /api/v1/dashboard/export.csv 404

- [ ] **Step 3: Write implementation**

`backend/routes/exportRoutes.js`:
```js
const express = require('express');
const { stringify } = require('csv-stringify/sync');
const Lead = require('../models/Lead');
const { requireAuth } = require('../middleware/auth');
const { buildLeadFilter } = require('../services/leadFilter');

const router = express.Router();

const COLUMNS = [
  'ref', 'submitted_at', 'affiliate', 'lead_source', 'brand', 'applicant_name',
  'initial_status', 'rejection_reason', 'search_status', 'signature_status',
  'signature_deadline', 'law_firm_confirmed', 'payable_status',
  'upfront_due', 'confirmation_due', 'total_due', 'platform_ref', 'last_updated',
];

router.get('/dashboard/export.csv', requireAuth, async (req, res) => {
  const filter = buildLeadFilter(req.query, req.user);
  const leads = await Lead.find(filter).sort({ submitted_at: -1 }).limit(50_000)
    .populate('affiliate_id', 'name').lean();
  const rows = leads.map((l) => ({
    ref: l.ref,
    submitted_at: l.submitted_at?.toISOString() || '',
    affiliate: l.affiliate_id?.name || '',
    lead_source: l.lead_source || '',
    brand: l.brand || '',
    applicant_name: l.applicant_name || '',
    initial_status: l.initial_status,
    rejection_reason: l.rejection_reason || '',
    search_status: l.search_status,
    signature_status: l.signature_status,
    signature_deadline: l.signature_deadline?.toISOString() || '',
    law_firm_confirmed: l.law_firm_confirmed ? 'yes' : 'no',
    payable_status: l.payable_status,
    upfront_due: l.amounts?.upfront_due ?? 0,
    confirmation_due: l.amounts?.confirmation_due ?? 0,
    total_due: l.amounts?.total_due ?? 0,
    platform_ref: l.platform_ref || '',
    last_updated: l.last_updated?.toISOString() || '',
  }));
  const csv = stringify(rows, { header: true, columns: COLUMNS });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-export-${stamp}.csv"`);
  res.send(csv);
});

module.exports = router;
```

In `backend/server.js`, after the stats router line, add:
```js
  app.use('/api/v1', require('./routes/exportRoutes'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (full backend suite green)

- [ ] **Step 5: Commit**

```bash
git add backend/routes/exportRoutes.js backend/server.js backend/tests/export.test.js
git commit -m "feat: filtered CSV export for reconciliation"
```

---

### Task 13: Frontend scaffold — Vite, Mantine, router, auth, app shell

**Files:**
- Create: `frontend/package.json`, `frontend/vite.config.js`, `frontend/index.html`, `frontend/.gitignore`, `frontend/src/main.jsx`, `frontend/src/App.jsx`, `frontend/src/api.js`, `frontend/src/pages/Login.jsx`, `frontend/src/components/StatusBadge.jsx`

**Interfaces:**
- Consumes: backend `/api/v1` (Vite dev proxy → `http://localhost:5005`).
- Produces (used by every page task):
  - `api(path, { method, body, formData }) -> Promise<json>`, `download(path, filename)`, `getUser()/setUser()/logout()` from `src/api.js`.
  - `<StatusBadge kind field value />` — colored Mantine Badge for any of the 4 status dims.
  - Routes registered in `App.jsx`; page tasks replace the placeholder `<div>` elements with real pages.

- [ ] **Step 1: Scaffold the frontend**

`frontend/package.json`:
```json
{
  "name": "pcp-affiliate-dashboard",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@mantine/core": "^7.11.0",
    "@mantine/dates": "^7.11.0",
    "@mantine/hooks": "^7.11.0",
    "dayjs": "^1.11.11",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.24.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.3.1"
  }
}
```

`frontend/vite.config.js`:
```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:5005' } },
});
```

`frontend/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>PCP Affiliate Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

`frontend/.gitignore`:
```
node_modules/
dist/
```

`frontend/src/api.js`:
```js
const API = '/api/v1';

export const getUser = () => JSON.parse(localStorage.getItem('user') || 'null');
export const setUser = (u) => localStorage.setItem('user', JSON.stringify(u));
export function logout() {
  localStorage.removeItem('user');
  window.location.href = '/login';
}

export async function api(path, { method = 'GET', body, formData } = {}) {
  const user = getUser();
  const headers = {};
  if (user?.token) headers.Authorization = `Bearer ${user.token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: formData || (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401) { logout(); throw new Error('session expired'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function download(path, filename) {
  const user = getUser();
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${user?.token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
```

`frontend/src/components/StatusBadge.jsx`:
```jsx
import { Badge } from '@mantine/core';

const COLORS = {
  initial_status: { pending: 'yellow', accepted: 'green', rejected: 'red' },
  search_status: { virgin: 'teal', searched: 'indigo', unknown: 'gray' },
  signature_status: { pending: 'yellow', passed: 'green', failed: 'red' },
  payable_status: {
    not_payable: 'gray', payable: 'green', partial_pending_confirmation: 'orange',
    payable_full: 'green', replaced: 'grape',
  },
};
const LABELS = {
  partial_pending_confirmation: 'pending confirmation',
  payable_full: 'payable (full)',
  not_payable: 'not payable',
  virgin: 'virgin search',
  searched: 'already searched',
};

export default function StatusBadge({ field, value }) {
  if (value === undefined || value === null) return null;
  return (
    <Badge color={COLORS[field]?.[value] || 'gray'} variant="light">
      {LABELS[value] || value}
    </Badge>
  );
}
```

`frontend/src/pages/Login.jsx`:
```jsx
import { useState } from 'react';
import { Button, Card, Center, PasswordInput, TextInput, Title, Alert } from '@mantine/core';
import { api, setUser } from '../api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await api('/auth/login', { method: 'POST', body: { email, password } });
      setUser(data);
      window.location.href = '/';
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Center h="100vh">
      <Card withBorder w={360} p="lg">
        <Title order={3} mb="md">PCP Affiliate Dashboard</Title>
        {error && <Alert color="red" mb="sm">{error}</Alert>}
        <form onSubmit={submit}>
          <TextInput label="Email" value={email} onChange={(e) => setEmail(e.target.value)} required mb="sm" />
          <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.target.value)} required mb="md" />
          <Button type="submit" fullWidth loading={loading}>Sign in</Button>
        </form>
      </Card>
    </Center>
  );
}
```

`frontend/src/App.jsx`:
```jsx
import { BrowserRouter, Routes, Route, Navigate, NavLink as RouterNavLink, useLocation } from 'react-router-dom';
import { AppShell, NavLink, Group, Title, Button, Text } from '@mantine/core';
import { getUser, logout } from './api';
import Login from './pages/Login';

function Shell({ children }) {
  const user = getUser();
  const location = useLocation();
  const links = [
    { to: '/', label: 'Summary' },
    { to: '/leads', label: 'Leads' },
    ...(user.role === 'admin'
      ? [{ to: '/affiliates', label: 'Affiliates' }, { to: '/imports', label: 'Imports' }]
      : []),
    { to: '/export', label: 'Export' },
  ];
  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 200, breakpoint: 'sm' }} padding="md">
      <AppShell.Header>
        <Group justify="space-between" h="100%" px="md">
          <Title order={4}>PCP Affiliate Dashboard</Title>
          <Group gap="sm">
            <Text size="sm" c="dimmed">{user.email}</Text>
            <Button size="xs" variant="default" onClick={logout}>Log out</Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {links.map((l) => (
          <NavLink key={l.to} component={RouterNavLink} to={l.to} label={l.label} active={location.pathname === l.to} />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}

function RequireAuth({ children }) {
  return getUser() ? <Shell>{children}</Shell> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<RequireAuth><div>Summary (Task 14)</div></RequireAuth>} />
        <Route path="/leads" element={<RequireAuth><div>Leads (Task 15)</div></RequireAuth>} />
        <Route path="/affiliates" element={<RequireAuth><div>Affiliates (Task 16)</div></RequireAuth>} />
        <Route path="/imports" element={<RequireAuth><div>Imports (Task 17)</div></RequireAuth>} />
        <Route path="/export" element={<RequireAuth><div>Export (Task 18)</div></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
```

`frontend/src/main.jsx`:
```jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MantineProvider defaultColorScheme="light">
      <App />
    </MantineProvider>
  </React.StrictMode>
);
```

- [ ] **Step 2: Verify build passes**

Run: `cd frontend && npm install && npm run build`
Expected: `vite build` completes with no errors, `dist/` produced.

- [ ] **Step 3: Manual smoke check**

Run backend (`cd backend && npm start`, needs local Mongo or set `MONGO_URI`) and `cd frontend && npm run dev`. Visit http://localhost:5173/login — login form renders; wrong creds show an error; after `node scripts/createAdmin.js admin@test.com test1234`, valid login lands on the shell with nav links.

- [ ] **Step 4: Commit**

```bash
git add frontend
git commit -m "feat: frontend scaffold with auth, shell and routing"
```

---

### Task 14: Summary page

**Files:**
- Create: `frontend/src/pages/Summary.jsx`
- Modify: `frontend/src/App.jsx` (route)

**Interfaces:**
- Consumes: `GET /dashboard/summary`, `GET /dashboard/affiliate-breakdown` (Tasks 11), `api` + `StatusBadge` (Task 13).

- [ ] **Step 1: Write the page**

`frontend/src/pages/Summary.jsx`:
```jsx
import { useEffect, useState } from 'react';
import { Card, Group, SimpleGrid, Table, Text, Title, Alert } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import dayjs from 'dayjs';
import { api, getUser } from '../api';

function Stat({ label, value, suffix = '' }) {
  return (
    <Card withBorder p="md">
      <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
      <Text size="xl" fw={700}>{value}{suffix}</Text>
    </Card>
  );
}

export default function Summary() {
  const user = getUser();
  const [range, setRange] = useState([new Date(), new Date()]);
  const [summary, setSummary] = useState(null);
  const [breakdown, setBreakdown] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const [from, to] = range;
    if (!from || !to) return;
    const qs = `?from=${dayjs(from).format('YYYY-MM-DD')}&to=${dayjs(to).format('YYYY-MM-DD')}`;
    Promise.all([api(`/dashboard/summary${qs}`), api(`/dashboard/affiliate-breakdown${qs}`)])
      .then(([s, b]) => { setSummary(s); setBreakdown(b); setError(null); })
      .catch((e) => setError(e.message));
  }, [range]);

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Summary</Title>
        <DatePickerInput type="range" value={range} onChange={setRange} allowSingleDateInRange w={280} />
      </Group>
      {error && <Alert color="red" mb="md">{error}</Alert>}
      {summary && (
        <SimpleGrid cols={{ base: 2, md: 4 }} mb="lg">
          <Stat label="Submitted" value={summary.submitted} />
          <Stat label="Accepted" value={summary.accepted} />
          <Stat label="Rejected" value={summary.rejected} />
          <Stat label="Pending" value={summary.pending} />
          <Stat label="Acceptance rate" value={summary.acceptance_rate} suffix="%" />
          <Stat label="Awaiting signature" value={summary.awaiting_signature} />
          <Stat label="Awaiting confirmation" value={summary.awaiting_confirmation} />
          <Stat label="Total due" value={`£${(summary.total_due || 0).toFixed(2)}`} />
        </SimpleGrid>
      )}
      <Title order={4} mb="sm">{user.role === 'admin' ? 'By affiliate' : 'Your totals'}</Title>
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Affiliate</Table.Th><Table.Th>Submitted</Table.Th><Table.Th>Accepted</Table.Th>
            <Table.Th>Rejected</Table.Th><Table.Th>Pending</Table.Th><Table.Th>Accept %</Table.Th>
            <Table.Th>Payable</Table.Th><Table.Th>Replacements</Table.Th><Table.Th>Owed</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {breakdown.map((r) => (
            <Table.Tr key={r.affiliate_id}>
              <Table.Td>{r.name} <Text span size="xs" c="dimmed">({r.lead_source})</Text></Table.Td>
              <Table.Td>{r.submitted}</Table.Td><Table.Td>{r.accepted}</Table.Td>
              <Table.Td>{r.rejected}</Table.Td><Table.Td>{r.pending}</Table.Td>
              <Table.Td>{r.acceptance_rate}%</Table.Td><Table.Td>{r.payable}</Table.Td>
              <Table.Td>{r.replacements}</Table.Td><Table.Td>£{(r.owed || 0).toFixed(2)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
```

In `frontend/src/App.jsx`: add `import Summary from './pages/Summary';` and replace the `/` route element content `<div>Summary (Task 14)</div>` with `<Summary />`.

- [ ] **Step 2: Verify build + smoke**

Run: `cd frontend && npm run build`
Expected: builds clean. Dev smoke: Summary shows stat cards (zeros on empty DB) and breakdown table.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Summary.jsx frontend/src/App.jsx
git commit -m "feat: summary page with stat cards and affiliate breakdown"
```

---

### Task 15: Leads page with filters, detail drawer, manual adjustment

**Files:**
- Create: `frontend/src/pages/Leads.jsx`
- Modify: `frontend/src/App.jsx` (route)

**Interfaces:**
- Consumes: `GET /dashboard/leads`, `GET /dashboard/leads/:id`, `PATCH /dashboard/leads/:id` (Task 8), `GET /affiliates` (Task 6, admin), `api`, `StatusBadge`.

- [ ] **Step 1: Write the page**

`frontend/src/pages/Leads.jsx`:
```jsx
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Drawer, Group, Pagination, Select, Stack, Switch, Table, Text,
  TextInput, Timeline, Title, Code, Divider,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import dayjs from 'dayjs';
import { api, getUser } from '../api';
import StatusBadge from '../components/StatusBadge';

const PAGE_SIZE = 50;
const opts = (arr) => arr.map((v) => ({ value: v, label: v.replaceAll('_', ' ') }));

export default function Leads() {
  const user = getUser();
  const isAdmin = user.role === 'admin';
  const [filters, setFilters] = useState({ affiliate_id: null, initial_status: null, search_status: null, signature_status: null, payable_status: null, q: '' });
  const [range, setRange] = useState([null, null]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], total: 0 });
  const [affiliates, setAffiliates] = useState([]);
  const [selected, setSelected] = useState(null); // full lead detail
  const [edit, setEdit] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isAdmin) api('/affiliates').then(setAffiliates).catch(() => {});
  }, [isAdmin]);

  const load = useCallback(() => {
    const params = new URLSearchParams({ page, limit: PAGE_SIZE });
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    if (range[0]) params.set('from', dayjs(range[0]).format('YYYY-MM-DD'));
    if (range[1]) params.set('to', dayjs(range[1]).format('YYYY-MM-DD'));
    api(`/dashboard/leads?${params}`).then(setData).catch((e) => setError(e.message));
  }, [filters, range, page]);

  useEffect(load, [load]);

  async function openDetail(id) {
    try {
      const lead = await api(`/dashboard/leads/${id}`);
      setSelected(lead);
      setEdit({});
    } catch (e) { setError(e.message); }
  }

  async function saveEdit() {
    setSaving(true);
    try {
      await api(`/dashboard/leads/${selected._id}`, { method: 'PATCH', body: edit });
      await openDetail(selected._id);
      load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  const set = (k) => (v) => { setPage(1); setFilters((f) => ({ ...f, [k]: v })); };

  return (
    <>
      <Title order={3} mb="md">Leads</Title>
      {error && <Alert color="red" mb="md" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
      <Group mb="md" gap="xs" wrap="wrap">
        {isAdmin && (
          <Select placeholder="Affiliate" clearable w={180} value={filters.affiliate_id}
            data={affiliates.map((a) => ({ value: a._id, label: a.name }))} onChange={set('affiliate_id')} />
        )}
        <Select placeholder="API status" clearable w={140} data={opts(['pending', 'accepted', 'rejected'])} value={filters.initial_status} onChange={set('initial_status')} />
        <Select placeholder="Search status" clearable w={150} data={opts(['virgin', 'searched', 'unknown'])} value={filters.search_status} onChange={set('search_status')} />
        <Select placeholder="Signature" clearable w={140} data={opts(['pending', 'passed', 'failed'])} value={filters.signature_status} onChange={set('signature_status')} />
        <Select placeholder="Payable" clearable w={200} data={opts(['not_payable', 'payable', 'partial_pending_confirmation', 'payable_full', 'replaced'])} value={filters.payable_status} onChange={set('payable_status')} />
        <DatePickerInput type="range" placeholder="Date range" clearable value={range} onChange={(v) => { setPage(1); setRange(v); }} w={240} />
        <TextInput placeholder="Search ref / name" value={filters.q} onChange={(e) => set('q')(e.target.value)} w={180} />
      </Group>

      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Ref</Table.Th><Table.Th>Submitted</Table.Th><Table.Th>Affiliate</Table.Th>
            <Table.Th>Name</Table.Th><Table.Th>API status</Table.Th><Table.Th>Search</Table.Th>
            <Table.Th>Signature</Table.Th><Table.Th>Payable</Table.Th><Table.Th>Due</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.rows.map((l) => (
            <Table.Tr key={l._id} style={{ cursor: 'pointer' }} onClick={() => openDetail(l._id)}>
              <Table.Td><Code>{l.ref}</Code></Table.Td>
              <Table.Td>{dayjs(l.submitted_at).format('DD MMM HH:mm')}</Table.Td>
              <Table.Td>{l.affiliate_id?.name}</Table.Td>
              <Table.Td>{l.applicant_name}</Table.Td>
              <Table.Td><StatusBadge field="initial_status" value={l.initial_status} /></Table.Td>
              <Table.Td><StatusBadge field="search_status" value={l.search_status} /></Table.Td>
              <Table.Td>
                <StatusBadge field="signature_status" value={l.signature_status} />
                {l.signature_status === 'pending' && l.signature_deadline && dayjs().isAfter(l.signature_deadline) && (
                  <Badge color="red" variant="outline" ml={4}>overdue{[0, 6].includes(dayjs(l.signature_deadline).day()) ? ' (weekend)' : ''}</Badge>
                )}
                {l.needs_replacement && !l.replaced_by_lead && <Badge color="red" ml={4}>needs replacement</Badge>}
              </Table.Td>
              <Table.Td><StatusBadge field="payable_status" value={l.payable_status} /></Table.Td>
              <Table.Td>£{(l.amounts?.total_due || 0).toFixed(2)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group justify="space-between" mt="sm">
        <Text size="sm" c="dimmed">{data.total} leads</Text>
        <Pagination value={page} onChange={setPage} total={Math.max(1, Math.ceil(data.total / PAGE_SIZE))} />
      </Group>

      <Drawer opened={!!selected} onClose={() => setSelected(null)} position="right" size="lg"
        title={selected ? `${selected.ref} — ${selected.applicant_name}` : ''}>
        {selected && (
          <Stack gap="sm">
            <Group gap="xs">
              <StatusBadge field="initial_status" value={selected.initial_status} />
              <StatusBadge field="search_status" value={selected.search_status} />
              <StatusBadge field="signature_status" value={selected.signature_status} />
              <StatusBadge field="payable_status" value={selected.payable_status} />
            </Group>
            <Text size="sm">
              Affiliate: <b>{selected.affiliate_id?.name}</b> · Brand: {selected.brand || '—'} · Platform ref: {selected.platform_ref || '—'}
            </Text>
            <Text size="sm">
              Submitted {dayjs(selected.submitted_at).format('DD MMM YYYY HH:mm')} · Signature deadline {selected.signature_deadline ? dayjs(selected.signature_deadline).format('DD MMM YYYY HH:mm') : '—'}
            </Text>
            {selected.rejection_reason && <Alert color="red" p="xs">Rejection: {selected.rejection_reason}</Alert>}
            {selected.replaces_lead && <Text size="sm">Replaces: <Code>{selected.replaces_lead.ref}</Code></Text>}
            {selected.replaced_by_lead && <Text size="sm">Replaced by: <Code>{selected.replaced_by_lead.ref}</Code></Text>}
            <Text size="sm">
              Due: upfront £{(selected.amounts?.upfront_due || 0).toFixed(2)} + confirmation £{(selected.amounts?.confirmation_due || 0).toFixed(2)} = <b>£{(selected.amounts?.total_due || 0).toFixed(2)}</b>
            </Text>

            {isAdmin && (
              <>
                <Divider label="Manual adjustment" />
                <Group grow>
                  <Select label="API status" data={opts(['pending', 'accepted', 'rejected'])} value={edit.initial_status ?? selected.initial_status} onChange={(v) => setEdit((e) => ({ ...e, initial_status: v }))} />
                  <Select label="Search status" data={opts(['virgin', 'searched', 'unknown'])} value={edit.search_status ?? selected.search_status} onChange={(v) => setEdit((e) => ({ ...e, search_status: v }))} />
                </Group>
                <Group grow>
                  <Select label="Signature" data={opts(['pending', 'passed', 'failed'])} value={edit.signature_status ?? selected.signature_status} onChange={(v) => setEdit((e) => ({ ...e, signature_status: v }))} />
                  <TextInput label="Rejection reason" value={edit.rejection_reason ?? (selected.rejection_reason || '')} onChange={(ev) => setEdit((e) => ({ ...e, rejection_reason: ev.target.value }))} />
                </Group>
                <Group grow align="end">
                  <Switch label="Law firm confirmed" checked={edit.law_firm_confirmed ?? selected.law_firm_confirmed} onChange={(ev) => setEdit((e) => ({ ...e, law_firm_confirmed: ev.currentTarget.checked }))} />
                  <TextInput label="Replaces ref (link as replacement)" placeholder="KB-2026-000001" value={edit.replaces_ref || ''} onChange={(ev) => setEdit((e) => ({ ...e, replaces_ref: ev.target.value }))} />
                </Group>
                <Button onClick={saveEdit} loading={saving} disabled={!Object.keys(edit).length}>Save changes</Button>
              </>
            )}

            <Divider label="History" />
            <Timeline bulletSize={16} lineWidth={2}>
              {[...(selected.history || [])].reverse().map((h, i) => (
                <Timeline.Item key={i} title={`${h.field}: ${h.from ?? '—'} → ${h.to}`}>
                  <Text size="xs" c="dimmed">{dayjs(h.at).format('DD MMM YYYY HH:mm')} · {h.source}{h.user ? ` · ${h.user}` : ''}</Text>
                </Timeline.Item>
              ))}
            </Timeline>

            <Divider label="Raw payload" />
            <Code block>{JSON.stringify(selected.payload, null, 2)}</Code>
          </Stack>
        )}
      </Drawer>
    </>
  );
}
```

In `frontend/src/App.jsx`: add `import Leads from './pages/Leads';` and replace `<div>Leads (Task 15)</div>` with `<Leads />`.

- [ ] **Step 2: Verify build + smoke**

Run: `cd frontend && npm run build`
Expected: builds clean. Dev smoke: submit a test lead via curl (Task 7 endpoint), see it listed; open drawer; as admin change status → history timeline grows, money updates.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Leads.jsx frontend/src/App.jsx
git commit -m "feat: leads page with filters, detail drawer and manual adjustment"
```

---

### Task 16: Affiliates page (rollups, rate cards, API keys, logins)

**Files:**
- Create: `frontend/src/pages/Affiliates.jsx`
- Modify: `frontend/src/App.jsx` (route)

**Interfaces:**
- Consumes: `GET/POST/PATCH /affiliates`, `POST /affiliates/:id/rotate-key`, `POST /affiliates/:id/users` (Task 6), `GET /dashboard/affiliate-breakdown` (Task 11).

- [ ] **Step 1: Write the page**

`frontend/src/pages/Affiliates.jsx`:
```jsx
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Code, Group, Modal, NumberInput, Stack, Switch, Table, TagsInput, Text,
  TextInput, Title, CopyButton, PasswordInput,
} from '@mantine/core';
import { api } from '../api';

const emptyForm = { name: '', lead_source: '', brands: [], rate_card: { virgin_rate: 0, searched_upfront_rate: 0, searched_confirmation_rate: 0 } };

export default function Affiliates() {
  const [affiliates, setAffiliates] = useState([]);
  const [stats, setStats] = useState({});
  const [modal, setModal] = useState(null); // {mode:'create'|'edit'|'user', affiliate?}
  const [form, setForm] = useState(emptyForm);
  const [newKey, setNewKey] = useState(null); // {name, key}
  const [userForm, setUserForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api('/affiliates').then(setAffiliates).catch((e) => setError(e.message));
    api('/dashboard/affiliate-breakdown?from=1970-01-01&to=2100-01-01')
      .then((rows) => setStats(Object.fromEntries(rows.map((r) => [r.affiliate_id, r]))))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function save() {
    try {
      if (modal.mode === 'create') {
        const res = await api('/affiliates', { method: 'POST', body: form });
        setNewKey({ name: res.affiliate.name, key: res.api_key });
      } else {
        await api(`/affiliates/${modal.affiliate._id}`, { method: 'PATCH', body: form });
      }
      setModal(null); load();
    } catch (e) { setError(e.message); }
  }

  async function rotate(a) {
    if (!window.confirm(`Rotate API key for ${a.name}? The old key stops working immediately.`)) return;
    try {
      const res = await api(`/affiliates/${a._id}/rotate-key`, { method: 'POST' });
      setNewKey({ name: a.name, key: res.api_key });
    } catch (e) { setError(e.message); }
  }

  async function addUser() {
    try {
      await api(`/affiliates/${modal.affiliate._id}/users`, { method: 'POST', body: userForm });
      setModal(null); setUserForm({ email: '', password: '' });
    } catch (e) { setError(e.message); }
  }

  const setRate = (k) => (v) => setForm((f) => ({ ...f, rate_card: { ...f.rate_card, [k]: Number(v) || 0 } }));

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Affiliates</Title>
        <Button onClick={() => { setForm(emptyForm); setModal({ mode: 'create' }); }}>New affiliate</Button>
      </Group>
      {error && <Alert color="red" mb="md" withCloseButton onClose={() => setError(null)}>{error}</Alert>}

      <Table striped withTableBorder highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th><Table.Th>Source</Table.Th><Table.Th>Key</Table.Th>
            <Table.Th>Rates (V / S / C)</Table.Th><Table.Th>Leads</Table.Th><Table.Th>Accept %</Table.Th>
            <Table.Th>Owed</Table.Th><Table.Th>Active</Table.Th><Table.Th></Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {affiliates.map((a) => {
            const s = stats[a._id] || {};
            return (
              <Table.Tr key={a._id}>
                <Table.Td>{a.name}</Table.Td>
                <Table.Td><Code>{a.lead_source}</Code></Table.Td>
                <Table.Td><Code>{a.api_key_prefix}…</Code></Table.Td>
                <Table.Td>£{a.rate_card?.virgin_rate} / £{a.rate_card?.searched_upfront_rate} / £{a.rate_card?.searched_confirmation_rate}</Table.Td>
                <Table.Td>{s.submitted || 0}</Table.Td>
                <Table.Td>{s.acceptance_rate ?? 0}%</Table.Td>
                <Table.Td>£{(s.owed || 0).toFixed(2)}</Table.Td>
                <Table.Td>{a.active ? 'yes' : 'no'}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    <Button size="compact-xs" variant="default" onClick={() => { setForm({ name: a.name, brands: a.brands || [], rate_card: { ...a.rate_card }, active: a.active }); setModal({ mode: 'edit', affiliate: a }); }}>Edit</Button>
                    <Button size="compact-xs" variant="default" onClick={() => rotate(a)}>Rotate key</Button>
                    <Button size="compact-xs" variant="default" onClick={() => setModal({ mode: 'user', affiliate: a })}>Add login</Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>

      <Modal opened={!!modal && modal.mode !== 'user'} onClose={() => setModal(null)} title={modal?.mode === 'create' ? 'New affiliate' : `Edit ${modal?.affiliate?.name}`}>
        <Stack>
          <TextInput label="Name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          {modal?.mode === 'create' && (
            <TextInput label="Lead source slug" description="lowercase, unique — used in shared-key submissions" value={form.lead_source} onChange={(e) => setForm((f) => ({ ...f, lead_source: e.target.value }))} required />
          )}
          <TagsInput label="Brands / domains" value={form.brands} onChange={(v) => setForm((f) => ({ ...f, brands: v }))} />
          <NumberInput label="Virgin search rate (£)" value={form.rate_card.virgin_rate} onChange={setRate('virgin_rate')} min={0} decimalScale={2} />
          <NumberInput label="Searched upfront rate (£)" value={form.rate_card.searched_upfront_rate} onChange={setRate('searched_upfront_rate')} min={0} decimalScale={2} />
          <NumberInput label="Searched confirmation rate (£)" value={form.rate_card.searched_confirmation_rate} onChange={setRate('searched_confirmation_rate')} min={0} decimalScale={2} />
          {modal?.mode === 'edit' && (
            <Switch label="Active" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.currentTarget.checked }))} />
          )}
          <Button onClick={save}>{modal?.mode === 'create' ? 'Create' : 'Save'}</Button>
        </Stack>
      </Modal>

      <Modal opened={modal?.mode === 'user'} onClose={() => setModal(null)} title={`Add login for ${modal?.affiliate?.name}`}>
        <Stack>
          <TextInput label="Email" value={userForm.email} onChange={(e) => setUserForm((f) => ({ ...f, email: e.target.value }))} />
          <PasswordInput label="Password" value={userForm.password} onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))} />
          <Button onClick={addUser}>Create login</Button>
        </Stack>
      </Modal>

      <Modal opened={!!newKey} onClose={() => setNewKey(null)} title={`API key for ${newKey?.name}`}>
        <Alert color="yellow" mb="sm">Copy this key now — it is shown only once.</Alert>
        <Group>
          <Code style={{ wordBreak: 'break-all' }}>{newKey?.key}</Code>
          <CopyButton value={newKey?.key || ''}>
            {({ copied, copy }) => <Button size="xs" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>}
          </CopyButton>
        </Group>
      </Modal>
    </>
  );
}
```

In `frontend/src/App.jsx`: add `import Affiliates from './pages/Affiliates';` and replace `<div>Affiliates (Task 16)</div>` with `<Affiliates />`.

- [ ] **Step 2: Verify build + smoke**

Run: `cd frontend && npm run build`
Expected: builds clean. Dev smoke: create affiliate → key modal appears once; rotate works; add login; edit rates persists.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Affiliates.jsx frontend/src/App.jsx
git commit -m "feat: affiliates page with rate cards, api keys and logins"
```

---

### Task 17: Imports page (CSV upload + mapping, history, webhook review queue)

**Files:**
- Create: `frontend/src/pages/Imports.jsx`
- Modify: `frontend/src/App.jsx` (route)

**Interfaces:**
- Consumes: `POST /imports/preview`, `POST /imports`, `GET /imports`, `GET /imports/last-mapping` (Task 10); `GET /webhooks/unmatched`, `POST /webhooks/:id/match` (Task 9).

- [ ] **Step 1: Write the page**

`frontend/src/pages/Imports.jsx`:
```jsx
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Card, Code, FileInput, Group, Select, Stack, Table, Text, TextInput, Title, Divider,
} from '@mantine/core';
import dayjs from 'dayjs';
import { api } from '../api';

const CANONICAL_FIELDS = [
  ['ref', 'Our ref (KB-…)'], ['platform_ref', 'Platform ref'], ['initial_status', 'API status'],
  ['rejection_reason', 'Rejection reason'], ['search_status', 'Search status'],
  ['signature_status', 'Signature status'], ['law_firm_confirmed', 'Law firm confirmed'],
];

export default function Imports() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null); // {headers, rows}
  const [mapping, setMapping] = useState({ match_by: 'ref', columns: {} });
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [matchRefs, setMatchRefs] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api('/imports').then(setHistory).catch(() => {});
    api('/webhooks/unmatched').then(setUnmatched).catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function doPreview() {
    setBusy(true); setError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const p = await api('/imports/preview', { method: 'POST', formData: fd });
      setPreview(p);
      const last = await api('/imports/last-mapping');
      if (last) setMapping(last);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function apply() {
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mapping', JSON.stringify(mapping));
      setResult(await api('/imports', { method: 'POST', formData: fd }));
      setPreview(null); setFile(null); load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function matchEvent(id) {
    try {
      await api(`/webhooks/${id}/match`, { method: 'POST', body: { ref: matchRefs[id] } });
      load();
    } catch (e) { setError(e.message); }
  }

  const headerOptions = preview ? preview.headers.map((h) => ({ value: h, label: h })) : [];

  return (
    <>
      <Title order={3} mb="md">Imports</Title>
      {error && <Alert color="red" mb="md" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
      {result && <Alert color="green" mb="md">Imported: {result.matched} matched, {result.unmatched} unmatched of {result.row_count} rows.</Alert>}

      <Card withBorder mb="lg">
        <Group align="end">
          <FileInput label="Platform report (CSV)" accept=".csv,text/csv" value={file} onChange={setFile} w={300} />
          <Button onClick={doPreview} disabled={!file} loading={busy}>Preview</Button>
        </Group>
        {preview && (
          <Stack mt="md">
            <Text size="sm" fw={600}>Map columns (unmapped fields are skipped)</Text>
            <Group>
              <Select label="Match leads by" w={180} data={[{ value: 'ref', label: 'Our ref (KB-…)' }, { value: 'platform_ref', label: 'Platform ref' }]}
                value={mapping.match_by} onChange={(v) => setMapping((m) => ({ ...m, match_by: v }))} />
            </Group>
            <Group wrap="wrap">
              {CANONICAL_FIELDS.map(([field, label]) => (
                <Select key={field} label={label} placeholder="—" clearable w={200} data={headerOptions}
                  value={mapping.columns[field] || null}
                  onChange={(v) => setMapping((m) => ({ ...m, columns: { ...m.columns, [field]: v || undefined } }))} />
              ))}
            </Group>
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>{preview.headers.map((h) => <Table.Th key={h}>{h}</Table.Th>)}</Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {preview.rows.map((r, i) => (
                  <Table.Tr key={i}>{preview.headers.map((h) => <Table.Td key={h}>{r[h]}</Table.Td>)}</Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Button onClick={apply} loading={busy} disabled={!mapping.columns[mapping.match_by]}>Apply import</Button>
          </Stack>
        )}
      </Card>

      <Title order={4} mb="sm">Unmatched webhooks</Title>
      {unmatched.length === 0 && <Text size="sm" c="dimmed" mb="md">None — all webhook events matched.</Text>}
      <Stack mb="lg">
        {unmatched.map((ev) => (
          <Card withBorder key={ev._id} p="sm">
            <Group justify="space-between" align="start">
              <Code block style={{ maxWidth: '70%' }}>{JSON.stringify(ev.payload)}</Code>
              <Group>
                <TextInput placeholder="KB-2026-000001" size="xs" value={matchRefs[ev._id] || ''}
                  onChange={(e) => setMatchRefs((m) => ({ ...m, [ev._id]: e.target.value }))} />
                <Button size="xs" onClick={() => matchEvent(ev._id)} disabled={!matchRefs[ev._id]}>Match</Button>
              </Group>
            </Group>
            <Text size="xs" c="dimmed" mt={4}>{dayjs(ev.at).format('DD MMM YYYY HH:mm')}</Text>
          </Card>
        ))}
      </Stack>

      <Divider mb="md" />
      <Title order={4} mb="sm">Import history</Title>
      <Table striped withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>When</Table.Th><Table.Th>File</Table.Th><Table.Th>By</Table.Th>
            <Table.Th>Rows</Table.Th><Table.Th>Matched</Table.Th><Table.Th>Unmatched</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {history.map((h) => (
            <Table.Tr key={h._id}>
              <Table.Td>{dayjs(h.at).format('DD MMM YYYY HH:mm')}</Table.Td>
              <Table.Td>{h.filename}</Table.Td><Table.Td>{h.uploaded_by}</Table.Td>
              <Table.Td>{h.row_count}</Table.Td><Table.Td>{h.matched}</Table.Td><Table.Td>{h.unmatched}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
```

In `frontend/src/App.jsx`: add `import Imports from './pages/Imports';` and replace `<div>Imports (Task 17)</div>` with `<Imports />`.

- [ ] **Step 2: Verify build + smoke**

Run: `cd frontend && npm run build`
Expected: builds clean. Dev smoke: upload the Task 10 test CSV → preview → map → apply → green summary; import history row appears.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Imports.jsx frontend/src/App.jsx
git commit -m "feat: imports page with mapping wizard and webhook review queue"
```

---

### Task 18: Export page

**Files:**
- Create: `frontend/src/pages/ExportPage.jsx`
- Modify: `frontend/src/App.jsx` (route)

**Interfaces:**
- Consumes: `GET /dashboard/export.csv` (Task 12), `GET /affiliates` (Task 6), `download` (Task 13).

- [ ] **Step 1: Write the page**

`frontend/src/pages/ExportPage.jsx`:
```jsx
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Group, Select, Stack, Title } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import dayjs from 'dayjs';
import { api, download, getUser } from '../api';

const opts = (arr) => arr.map((v) => ({ value: v, label: v.replaceAll('_', ' ') }));

export default function ExportPage() {
  const user = getUser();
  const [affiliates, setAffiliates] = useState([]);
  const [affiliateId, setAffiliateId] = useState(null);
  const [range, setRange] = useState([dayjs().startOf('month').toDate(), new Date()]);
  const [initialStatus, setInitialStatus] = useState(null);
  const [payableStatus, setPayableStatus] = useState(null);
  const [period, setPeriod] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user.role === 'admin') api('/affiliates').then(setAffiliates).catch(() => {});
  }, [user.role]);

  function setPresetPeriod(p) {
    setPeriod(p);
    if (p === 'this_week') setRange([dayjs().startOf('week').toDate(), new Date()]);
    if (p === 'last_week') setRange([dayjs().subtract(1, 'week').startOf('week').toDate(), dayjs().subtract(1, 'week').endOf('week').toDate()]);
    if (p === 'this_month') setRange([dayjs().startOf('month').toDate(), new Date()]);
    if (p === 'last_month') setRange([dayjs().subtract(1, 'month').startOf('month').toDate(), dayjs().subtract(1, 'month').endOf('month').toDate()]);
  }

  async function doExport() {
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (affiliateId) params.set('affiliate_id', affiliateId);
      if (range[0]) params.set('from', dayjs(range[0]).format('YYYY-MM-DD'));
      if (range[1]) params.set('to', dayjs(range[1]).format('YYYY-MM-DD'));
      if (initialStatus) params.set('initial_status', initialStatus);
      if (payableStatus) params.set('payable_status', payableStatus);
      await download(`/dashboard/export.csv?${params}`, `leads-export-${dayjs().format('YYYY-MM-DD')}.csv`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <Title order={3} mb="md">Export</Title>
      {error && <Alert color="red" mb="md">{error}</Alert>}
      <Card withBorder maw={480}>
        <Stack>
          {user.role === 'admin' && (
            <Select label="Affiliate" placeholder="All affiliates" clearable value={affiliateId}
              data={affiliates.map((a) => ({ value: a._id, label: a.name }))} onChange={setAffiliateId} />
          )}
          <Select label="Reconciliation period" placeholder="Custom range" clearable value={period}
            data={[
              { value: 'this_week', label: 'This week' }, { value: 'last_week', label: 'Last week' },
              { value: 'this_month', label: 'This month' }, { value: 'last_month', label: 'Last month' },
            ]}
            onChange={setPresetPeriod} />
          <DatePickerInput type="range" label="Date range" value={range} onChange={(v) => { setPeriod(null); setRange(v); }} />
          <Select label="Lead status" placeholder="Any" clearable data={opts(['pending', 'accepted', 'rejected'])} value={initialStatus} onChange={setInitialStatus} />
          <Select label="Payable status" placeholder="Any" clearable data={opts(['not_payable', 'payable', 'partial_pending_confirmation', 'payable_full', 'replaced'])} value={payableStatus} onChange={setPayableStatus} />
          <Button onClick={doExport} loading={busy}>Download CSV</Button>
        </Stack>
      </Card>
    </>
  );
}
```

In `frontend/src/App.jsx`: add `import ExportPage from './pages/ExportPage';` and replace `<div>Export (Task 18)</div>` with `<ExportPage />`.

- [ ] **Step 2: Verify build + smoke**

Run: `cd frontend && npm run build`
Expected: builds clean. Dev smoke: Download produces a CSV containing seeded leads; affiliate login exports only its own rows.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/ExportPage.jsx frontend/src/App.jsx
git commit -m "feat: export page with reconciliation period presets"
```

---

### Task 19: Deploy artifacts (nginx, PM2, runbook)

**Files:**
- Create: `deploy/nginx.conf`, `deploy/DEPLOY.md`, `README.md`

**Interfaces:**
- Consumes: everything. No code changes — deployment happens only when the user says go.

- [ ] **Step 1: Write deploy artifacts**

`deploy/nginx.conf`:
```nginx
# /etc/nginx/sites-available/pcp-affiliate-dashboard
# Subdomain default per spec: leads.click2leads.co.uk (change server_name if needed)
server {
    listen 80;
    server_name leads.click2leads.co.uk;

    root /var/www/pcp-affiliate-dashboard/frontend/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:5005;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 12m;
    }

    location / {
        try_files $uri /index.html;
    }
}
```

`deploy/DEPLOY.md`:
```markdown
# Deploy runbook — pcp-affiliate-dashboard

Target: VPS 31.97.57.193 (srv897225), port 5005, Mongo db `pcp-affiliates`.

## First deploy
1. `rsync -av --exclude node_modules --exclude .git ./ root@31.97.57.193:/var/www/pcp-affiliate-dashboard/`
2. Backend:
   - `cd /var/www/pcp-affiliate-dashboard/backend && npm install --omit=dev`
   - `cp .env.example .env` and fill: `MONGO_URI=mongodb://127.0.0.1:27017/pcp-affiliates`,
     strong `JWT_SECRET`, optional `SHARED_API_KEY` / `WEBHOOK_TOKEN`.
   - `node scripts/createAdmin.js <email> '<password>'`
   - `pm2 start server.js --name pcp-affiliate-api && pm2 save`
3. Frontend: `cd ../frontend && npm install && npm run build` (dist/ is served by nginx)
4. Nginx: copy `deploy/nginx.conf` to `/etc/nginx/sites-available/pcp-affiliate-dashboard`,
   symlink into sites-enabled, `nginx -t && systemctl reload nginx`.
5. DNS: add `leads` A record → 31.97.57.193 in the click2leads.co.uk Cloudflare zone (proxied).
6. TLS per VPS pattern (certbot DNS-01 / CF Origin cert).
7. Update /var/www/PORT_MAP.md: 5005 = pcp-affiliate-api.

## Redeploy
rsync → backend `npm install --omit=dev` (if package.json changed) → frontend `npm run build`
→ `pm2 restart pcp-affiliate-api` → purge Cloudflare cache for the subdomain.

## Smoke test after every deploy
- `curl -s https://leads.click2leads.co.uk/api/v1/health` → `{"ok":true}`
- Login as admin, open Summary.
- Submit a test lead:
  `curl -s -X POST https://leads.click2leads.co.uk/api/v1/leads -H 'X-API-Key: <affiliate key>' -H 'Content-Type: application/json' -d '{"first_name":"Test","last_name":"Lead","email":"t@example.com","phone":"07700900000"}'`
  → `{"ref":"KB-…","status":"pending"}`; verify it appears in Leads; delete/adjust as needed.
```

`README.md`:
```markdown
# PCP Affiliate Dashboard

Lead gateway + tracking dashboard for PCP claims affiliates.
Spec: docs/superpowers/specs/2026-07-08-pcp-affiliate-dashboard-design.md
Plan: docs/superpowers/plans/2026-07-08-pcp-affiliate-dashboard.md

- `backend/` — Express API (port 5005) + MongoDB. `npm test` runs the suite.
- `frontend/` — React/Vite/Mantine SPA. `npm run dev` proxies /api to :5005.
- `deploy/` — nginx config + runbook.

Affiliate ingest: `POST /api/v1/leads` with `X-API-Key` (or shared key + `lead_source`).
Platform adapter is in MANUAL MODE until the buyer platform's API docs arrive
(`backend/services/platformAdapter.js`).
```

- [ ] **Step 2: Full verification**

Run: `cd backend && npm test && cd ../frontend && npm run build`
Expected: full backend suite green; frontend builds clean.

- [ ] **Step 3: Commit**

```bash
git add deploy README.md
git commit -m "docs: deploy runbook, nginx config and readme"
```

---

## Plan Self-Review (completed)

- **Spec coverage:** gateway ingest (T7), per-affiliate/shared keys (T6/T7), platform adapter manual mode (T7), 4 status dimensions + history (T2/T4), 48h signature deadline + weekend flag (T7 backend, T15 UI), money engine incl. partial-then-full searched payments and replacement no-double-billing (T3/T4/T7/T8), webhook + review queue (T9/T17), CSV import with saved mapping (T10/T17), manual adjust (T8/T15), summary/breakdown/lead-level views (T11/T14/T15/T16), CSV export with reconciliation periods (T12/T18), admin+affiliate auth with server-side scoping (T5/T6/T8/T11/T12), deploy on VPS/nginx/PM2 (T19).
- **Placeholder scan:** none — every step has full code/commands.
- **Type consistency:** `computeMoney`, `applyStatusChanges(lead, changes, rateCard, {source,user})`, `buildLeadFilter(query, user)`, `generateApiKey/sha256hex`, `nextLeadRef`, route paths and JSON shapes checked across tasks.
