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

test('replaces_ref rejects non-string (injection guard)', async () => {
  const { key } = await makeAffiliate('inj');
  const res = await request(createApp()).post('/api/v1/leads').set('X-API-Key', key)
    .send({ first_name: 'A', last_name: 'B', email: 'a@b.c', replaces_ref: { $ne: null } });
  assert.strictEqual(res.status, 400);
});

test('second replacement of same original is rejected 409', async () => {
  const { aff, key } = await makeAffiliate('dup');
  const app = createApp();
  const first = await request(app).post('/api/v1/leads').set('X-API-Key', key).send({ first_name: 'O', last_name: 'L', email: 'o@x.com' });
  const r1 = await request(app).post('/api/v1/leads').set('X-API-Key', key).send({ first_name: 'R', last_name: 'One', email: 'r1@x.com', replaces_ref: first.body.ref });
  assert.strictEqual(r1.status, 201);
  const r2 = await request(app).post('/api/v1/leads').set('X-API-Key', key).send({ first_name: 'R', last_name: 'Two', email: 'r2@x.com', replaces_ref: first.body.ref });
  assert.strictEqual(r2.status, 409);
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
