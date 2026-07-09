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
