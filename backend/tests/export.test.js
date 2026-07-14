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

test('export neutralises formula-prefixed free text', async () => {
  const aff = await Affiliate.create({ name: 'C', lead_source: 'ccc' });
  await Lead.create({ ref: 'KB-2026-000009', affiliate_id: aff._id, lead_source: 'ccc', applicant_name: '=HYPERLINK("http://evil")' });
  const admin = await User.create({ email: 'adm@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const res = await request(createApp())
    .get('/api/v1/dashboard/export.csv')
    .set('Authorization', `Bearer ${signToken(admin)}`);
  assert.ok(res.text.includes(`'=HYPERLINK`));
  assert.ok(!/,=HYPERLINK/.test(res.text));
});

test('xlsx export returns a valid workbook with scoping', async () => {
  const affA = await Affiliate.create({ name: 'A', lead_source: 'aaa' });
  const affB = await Affiliate.create({ name: 'B', lead_source: 'bbb' });
  await Lead.create({ ref: 'KB-2026-000011', affiliate_id: affA._id, lead_source: 'aaa', applicant_name: 'Xlsx One', amounts: { upfront_due: 40, confirmation_due: 0, total_due: 40 } });
  await Lead.create({ ref: 'KB-2026-000012', affiliate_id: affB._id, lead_source: 'bbb', applicant_name: 'Xlsx Two' });
  const affUser = await User.create({ email: 'ax@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: affA._id });

  const res = await request(createApp())
    .get('/api/v1/dashboard/export.xlsx')
    .set('Authorization', `Bearer ${signToken(affUser)}`)
    .buffer(true)
    .parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /spreadsheetml/);
  assert.match(res.headers['content-disposition'], /attachment; filename="leads-export-.*\.xlsx"/);
  assert.strictEqual(res.body.slice(0, 2).toString(), 'PK'); // xlsx = zip container

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  const ws = wb.getWorksheet('Leads');
  assert.strictEqual(ws.getCell('A1').value, 'ref');
  assert.strictEqual(ws.getCell('A2').value, 'KB-2026-000011');
  assert.strictEqual(ws.actualRowCount, 2); // header + own lead only (scoped)
});

test('statement.xlsx scopes to affiliate+month, requires params, pins affiliate users', async () => {
  const ExcelJS = require('exceljs');
  const affA = await Affiliate.create({ name: 'A', lead_source: 'aaa' });
  const affB = await Affiliate.create({ name: 'B', lead_source: 'bbb' });
  const admin = await User.create({ email: 'adm2@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'admin' });
  const affUser = await User.create({ email: 'a2@x.com', password_hash: bcrypt.hashSync('p', 10), role: 'affiliate', affiliate_id: affA._id });
  await Lead.create({ ref: 'KB-2026-000011', affiliate_id: affA._id, submitted_at: new Date('2026-06-10T10:00:00Z'), applicant_name: 'In', initial_status: 'accepted', amounts: { upfront_due: 40, confirmation_due: 0, total_due: 40 } });
  await Lead.create({ ref: 'KB-2026-000012', affiliate_id: affA._id, submitted_at: new Date('2026-07-01T10:00:00Z'), applicant_name: 'OtherMonth', amounts: { upfront_due: 15, confirmation_due: 0, total_due: 15 } });
  await Lead.create({ ref: 'KB-2026-000013', affiliate_id: affB._id, submitted_at: new Date('2026-06-11T10:00:00Z'), applicant_name: 'OtherAff', amounts: { upfront_due: 25, confirmation_due: 0, total_due: 25 } });
  const app = createApp();

  // admin without affiliate_id / bad month -> 400
  assert.strictEqual((await request(app).get('/api/v1/dashboard/statement.xlsx?month=2026-06').set('Authorization', `Bearer ${signToken(admin)}`)).status, 400);
  assert.strictEqual((await request(app).get(`/api/v1/dashboard/statement.xlsx?affiliate_id=${affA._id}&month=junk`).set('Authorization', `Bearer ${signToken(admin)}`)).status, 400);

  const res = await request(app)
    .get(`/api/v1/dashboard/statement.xlsx?affiliate_id=${affA._id}&month=2026-06`)
    .set('Authorization', `Bearer ${signToken(admin)}`)
    .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-disposition'], /statement-aaa-2026-06\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  const ws = wb.getWorksheet('Statement');
  const cells = [];
  ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value))));
  assert.ok(cells.includes('KB-2026-000011'));
  assert.ok(!cells.includes('KB-2026-000012')); // other month excluded
  assert.ok(!cells.includes('KB-2026-000013')); // other affiliate excluded
  assert.ok(cells.includes('TOTALS'));
  assert.ok(cells.includes('1 lead'));

  // affiliate user is pinned to their own affiliate even if they ask for B's
  const pinned = await request(app)
    .get(`/api/v1/dashboard/statement.xlsx?affiliate_id=${affB._id}&month=2026-06`)
    .set('Authorization', `Bearer ${signToken(affUser)}`)
    .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  assert.strictEqual(pinned.status, 200);
  assert.match(pinned.headers['content-disposition'], /statement-aaa-2026-06\.xlsx/);
});

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
