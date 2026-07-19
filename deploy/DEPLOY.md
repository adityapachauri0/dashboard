# Deploy runbook — pcp-affiliate-dashboard

Target: VPS 31.97.57.193 (srv897225), port 5009 (5005 is taken by earnfromsurveys; local dev still defaults to 5005), Mongo db `pcp-affiliates`. Set `PORT=5009` in the server .env.

## First deploy
1. `rsync -av --exclude node_modules --exclude .git ./ root@31.97.57.193:/var/www/pcp-affiliate-dashboard/`
2. Backend:
   - `cd /var/www/pcp-affiliate-dashboard/backend && npm install --omit=dev`
   - `cp .env.example .env` and fill: `NODE_ENV=production`, `MONGO_URI=mongodb://127.0.0.1:27017/pcp-affiliates`,
     strong `JWT_SECRET`, `WEBHOOK_TOKEN` (required in production — the webhook returns 503 without it), optional `SHARED_API_KEY`.
   - `node scripts/createAdmin.js <email> '<password>'`
   - `pm2 start server.js --name pcp-affiliate-api && pm2 save`
3. Frontend: `cd ../frontend && npm install && npm run build` (dist/ is served by nginx)
4. Nginx: copy `deploy/nginx.conf` to `/etc/nginx/sites-available/pcp-affiliate-dashboard`,
   symlink into sites-enabled, `nginx -t && systemctl reload nginx`.
5. DNS: add `leads` A record → 31.97.57.193 in the click2leads.co.uk Cloudflare zone (proxied).
6. TLS per VPS pattern (certbot DNS-01 / CF Origin cert).
7. PORT_MAP.md regenerates hourly via cron — verify 5009 = pcp-affiliate-api appears.

## Redeploy
rsync → backend `npm install --omit=dev` (if package.json changed) → frontend `npm run build`
→ `pm2 restart pcp-affiliate-api` → purge Cloudflare cache for the subdomain.

## Smoke test after every deploy
- `curl -s https://leads.click2leads.co.uk/api/v1/health` → `{"ok":true}`
- Login as admin, open Summary.
- Submit a test lead:
  `curl -s -X POST https://leads.click2leads.co.uk/api/v1/leads -H 'X-API-Key: <affiliate key>' -H 'Content-Type: application/json' -d '{"first_name":"Test","last_name":"Lead","email":"t@example.com","phone":"07700900000"}'`
  → `{"ref":"KB-…","status":"pending"}`; verify it appears in Leads; delete/adjust as needed.

## Automated invoicing (Jul 2026)

Daily 09:00 Europe/London cron emails BlueLion a VAT invoice + Excel reconciliation for
yesterday's leads, backfilling up to 3 prior London days if a run was missed, and emails
each active affiliate their own reconciliation.

### Server update

```
cd /var/www/pcp-affiliate-dashboard && git pull
cd backend && npm install --omit=dev   # pulls pdf-lib
cd ../frontend && npm install && npm run build
pm2 restart pcp-affiliate-api
```

### .env (append to `/var/www/pcp-affiliate-dashboard/backend/.env`)

Mirrors `backend/.env.example` — see that file for the full list with comments:

```
ACCOUNTS_SMTP_HOST=smtpout.secureserver.net
ACCOUNTS_SMTP_PORT=465
ACCOUNTS_SMTP_USER=accounts@click2leads.co.uk
ACCOUNTS_SMTP_PASS=<pending from client — GoDaddy mailbox password>
INVOICE_CC=<internal copy address, e.g. anthony@click2leads.co.uk>
INVOICE_TO_EMAIL=<pending from client — BlueLion accounts address>
# BLUELION_VIRGIN_RATE=110   BLUELION_SEARCHED_RATE=30  (defaults; only set to override)
# INVOICE_HEARTBEAT_URL=<optional Uptime Kuma push URL>
```

`ACCOUNTS_SMTP_PASS` and `INVOICE_TO_EMAIL` are both pending from the client. Until
`INVOICE_TO_EMAIL` is set, invoices deliver to `INVOICE_CC` (falling back further to
`DIGEST_TO` if `INVOICE_CC` is also unset) — nothing is silently dropped, but confirm the
recipient in the first live send before relying on it.

### Crontab

```
0 8,9 * * * cd /var/www/pcp-affiliate-dashboard/backend && node scripts/sendInvoices.js >> /var/log/pcp-invoices.log 2>&1
```

Runs at both 08:00 and 09:00 UTC; the script's in-process London-hour guard makes exactly
one of those two firings actually run (hour 9 in GMT, hour 8 in BST) — this covers the
clock change without needing `CRON_TZ` support.

### FIRST-RUN WARNING — backfill can bill days you don't want billed

The runner backfills up to 3 prior London days: if no `Invoice` row exists yet for a day
in that window, the first live run will generate and send an invoice for it (and the
matching affiliate recons). Before the first live run, do ONE of:

- Confirm with the client that all billable leads in the last 3 London days should
  actually be invoiced, or
- Pre-seed marker rows for any day that must NOT be sent, so the runner treats it as
  already handled. Run in `mongosh pcp-affiliates` (adjust `"2026-07-16"` to the day and
  affiliate `_id` to skip):

  ```js
  // Marks an Invoice as already sent for that day — runner won't regenerate it.
  // `number` must be globally unique across all invoices, so include the day
  // when pre-seeding more than one skip marker.
  db.invoices.insertOne({
    number: "BlueLion SKIP 2026-07-16", seq: 0, type: "daily",
    period_start: "2026-07-16", period_end: "2026-07-16",
    invoice_date: new Date(), lines: [], net: 0, vat: 0, gross: 0,
    email_status: "sent", payment_status: "awaiting",
    created_at: new Date(), last_updated: new Date(),
  });
  // Marks one affiliate's recon as already sent for that day — repeat per affiliate.
  db.reconsends.insertOne({
    affiliate_id: ObjectId("<affiliate _id>"), day: "2026-07-16", sent_at: new Date(),
  });
  ```

  `seq: 0` markers stay clear of the real `BlueLion 001…` numbering sequence (driven by
  the separate `Counter` collection) — don't reuse `seq: 0` for a real invoice.

### Rehearsal

`node scripts/sendInvoices.js --dry-run` — prints, for each of the 3 lookback days,
whether an `Invoice` row already exists (skipped) or one would be generated (with lead
counts and totals); yesterday additionally renders `storage/samples/dry-invoice.pdf`
(visual check against the approved template) and `dry-reconciliation.xlsx`. Also prints
every affiliate recon email that would be sent. No DB writes, no emails sent. Show the
output to the client before the first live run.

### Go-live checklist

1. Set `contact_email` for Claim3000 → `ali@claim3000.co.uk` via the dashboard Affiliates
   form (required for their recon email to send).
2. Back up `backend/storage/` along with the rest of the server backup — it holds the
   generated invoice PDFs/XLSX files, which are business records, not regenerable cache.
3. Do NOT run `npm test` on the production box — the test suite writes into
   `backend/storage/invoices`, colliding with real invoice artifacts. Run tests locally
   or in CI only.
4. Verify GoDaddy SPF before go-live so invoices don't land in spam: the click2leads.co.uk
   DNS TXT record must include `v=spf1 include:secureserver.net ~all` (zone IDs in memory
   `reference_cloudflare_api.md`).
5. Optional but recommended: create an Uptime Kuma push monitor and set
   `INVOICE_HEARTBEAT_URL` — the script only pings it after a run with zero invoice/recon
   failures, so treat monitor silence as a failed run, not just a missed heartbeat.
