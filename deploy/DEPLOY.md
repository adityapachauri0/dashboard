# Deploy runbook — pcp-affiliate-dashboard

Target: VPS 31.97.57.193 (srv897225), port 5005, Mongo db `pcp-affiliates`.

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
