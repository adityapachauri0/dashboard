// Daily digest — run from cron:
//   0 8 * * * cd /var/www/pcp-affiliate-dashboard/backend && node scripts/sendDigest.js >> /var/log/pcp-digest.log 2>&1
// Needs in .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, DIGEST_TO (comma-separated)
require('dotenv').config();
const nodemailer = require('nodemailer');
const { connectDB } = require('../config/db');
const { buildDigest } = require('../services/digest');

async function main() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, DIGEST_TO } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !DIGEST_TO) {
    console.error('digest: SMTP_HOST/SMTP_USER/SMTP_PASS/DIGEST_TO not configured — skipping');
    process.exit(0);
  }
  await connectDB();
  const { subject, text } = await buildDigest();
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transport.sendMail({ from: EMAIL_FROM || SMTP_USER, to: DIGEST_TO, subject, text });
  console.log(`${new Date().toISOString()} digest sent: ${subject}`);
  process.exit(0);
}
main().catch((e) => { console.error('digest failed:', e.message); process.exit(1); });
