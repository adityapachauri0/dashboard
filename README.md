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
