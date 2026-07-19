// Daily BlueLion invoice + affiliate reconciliations — run from cron.
// Server crontab runs it at 8 AND 9 UTC; the London-hour guard makes exactly
// one of them fire year-round (BST/GMT safe without CRON_TZ support):
//   0 8,9 * * * cd /var/www/pcp-affiliate-dashboard/backend && node scripts/sendInvoices.js >> /var/log/pcp-invoices.log 2>&1
// Manual live run: node scripts/sendInvoices.js --force
// Rehearsal:       node scripts/sendInvoices.js --dry-run
// Needs in .env: ACCOUNTS_SMTP_USER, ACCOUNTS_SMTP_PASS (INVOICE_TO_EMAIL for live BlueLion delivery)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { connectDB } = require('../config/db');
const { accountsConfigured } = require('../services/mailer');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const now = new Date();
  const londonHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(now));
  if (!dryRun && !force && londonHour !== 9) {
    console.log(`${now.toISOString()} not 09:00 London (hour=${londonHour}) — exiting`);
    process.exit(0);
  }
  if (!dryRun && !accountsConfigured()) {
    console.error('invoices: ACCOUNTS_SMTP_USER/PASS not configured — skipping (no invoice generated)');
    process.exit(0);
  }
  await connectDB();

  if (dryRun) {
    const { previewInvoiceForDay, money, LOOKBACK_DAYS, londonDay } = require('../services/invoiceService');
    const { renderInvoicePdf } = require('../services/invoicePdf');
    const { buildBlueLionWorkbook } = require('../services/reconExcel');
    const { buildAffiliateRecons } = require('../services/affiliateRecon');
    const Invoice = require('../models/Invoice');
    // Same lookback window a live run backfills, oldest first — a live run
    // would generate/send for all of these, not just yesterday.
    for (let n = LOOKBACK_DAYS; n >= 1; n -= 1) {
      const day = londonDay(new Date(now.getTime() - n * 24 * 3600 * 1000));
      const existing = await Invoice.findOne({ type: 'daily', period_end: day });
      if (existing) {
        console.log(`DRY RUN — day ${day}: invoice ${existing.number} already exists (${existing.email_status}) — skipped`);
        continue;
      }
      const p = await previewInvoiceForDay(day);
      if (!p.leads.length) {
        console.log(`DRY RUN — day ${day}: no billable leads — no invoice would be generated`);
        continue;
      }
      console.log(`DRY RUN — day ${day}: would generate — virgin=${p.counts.virgin} searched=${p.counts.searched} net=£${money(p.calc.net)} vat=£${money(p.calc.vat)} gross=£${money(p.calc.gross)}`);
      if (n === 1) {
        const out = path.join(__dirname, '..', 'storage', 'samples');
        fs.mkdirSync(out, { recursive: true });
        const fake = { number: 'BlueLion DRY', invoice_date: now, lines: p.calc.lines, net: p.calc.net, vat: p.calc.vat, gross: p.calc.gross, period_end: p.day };
        fs.writeFileSync(path.join(out, 'dry-invoice.pdf'), await renderInvoicePdf(fake));
        fs.writeFileSync(path.join(out, 'dry-reconciliation.xlsx'), await buildBlueLionWorkbook(p.leads));
        console.log(`artifacts written to ${out}`);
      }
    }
    for (const r of await buildAffiliateRecons(now)) {
      console.log(`--- recon → ${r.name} <${r.to}> ---\n${r.subject}\n${r.text}`);
    }
    process.exit(0);
  }

  const { runDaily } = require('../services/invoiceRunner');
  const s = await runDaily(now);
  console.log(`${now.toISOString()} invoices day=${s.day} invoice=${s.invoice ? `${s.invoice.number} £${s.invoice.gross} ${s.invoice.email_status}` : 'none'} retried=${s.retried} backfilled=${s.backfilled} failed=${s.failed_invoices} recons=${s.recons_sent}/${s.recons_sent + s.recons_failed}`);
  if (process.env.INVOICE_HEARTBEAT_URL && !s.failed_invoices && !s.recons_failed) {
    await fetch(process.env.INVOICE_HEARTBEAT_URL).catch(() => {});
  }
  process.exit(s.failed_invoices > 0 || s.recons_failed ? 1 : 0);
}

main().catch((e) => { console.error('invoices failed:', e); process.exit(1); });
