# Dark-sidebar redesign — design spec (2026-07-10)

## Goal
Visual restyle of the PCP Affiliate Dashboard. Zero functional change: same pages, tables, columns, filters, drawer, modals, flows, copy, and formats (en-GB dates, `£x,xxx.xx`, `KB-` refs in mono).

## Decisions (user-approved)
- **Look**: dark sidebar SaaS ("Stripe/Linear admin" style).
- **Accent**: emerald green `#10b981` (Click2Leads' most-used brand colour), hover `#059669`.
- **Workflow**: restyle the claude.ai design project (`5bfa74d9-776d-4406-ba3d-5b4560ba72fb`, "PCP Affiliate Dashboard Design System") first; user reviews visually; then apply the approved look to `frontend/`.

## Design

### Shell & layout
- Replace top header + light 200px navbar with a **240px dark navy sidebar** `#0f172a`:
  - Wordmark "PCP Affiliate Dashboard" at top (plain bold type — still no logo).
  - Nav links with simple line icons (Summary, Leads, Affiliates, Imports, Export). Active link: emerald-tinted pill, white text. Inactive: slate-300 text, hover slate-800 bg.
  - User block pinned at bottom: email (dimmed) + Log out.
- Content canvas: `#f8fafc` (off-white) instead of flat white. Per-page title bar: title left, page actions (e.g. date-range picker) right.

### Colour
- Primary blue `#228be6` → **emerald `#10b981`** everywhere primary is used: filled buttons, focus rings, active nav, pagination, switch/checkbox accents. Hover `#059669`.
- Emerald scale (Tailwind emerald): 50 `#ecfdf5` … 500 `#10b981`, 600 `#059669`, 700 `#047857`.
- Sidebar palette: bg `#0f172a`, text `#cbd5e1`, hover bg `#1e293b`, active bg `rgba(16,185,129,.15)` + white text + emerald icon.
- **Status badge hues unchanged** (yellow pending, green accepted, teal virgin, indigo searched, orange part-paid, grape replaced, red rejected, gray unknown) — domain vocabulary the team already reads.

### Surfaces & type
- Cards & table containers: white, **8px radius**, hairline border `#e2e8f0` + soft shadow `0 1px 2px rgba(16,24,40,.06)` (replaces flat 1px-border-only).
- Stat cards: 24px bold values, 12px uppercase dimmed labels, slim accent bar (emerald; status-coloured where natural).
- Table stripes `#f8fafc`, hover `#f1f5f9`. Density, sizes, system font stack unchanged. Badges stay pills.

### Login
- Full dark navy `#0f172a` backdrop, centered white card (8px radius, soft shadow), wordmark above fields, emerald sign-in button.

### Out of scope / unchanged
- No dark content mode, no webfonts, no layout/IA changes, no copy changes.
- Icons: inline SVG in the design kit (no dependency). Real app phase adds `@tabler/icons-react` — the only new dependency.

## Implementation phases
1. **Design project restyle** (this spec's deliverable): tokens, components (Button, NavLink, AppShell, Card, Stat, form focus), guidelines specimens, all six `ui_kits/dashboard` screens, readme visual-foundations section.
2. **App application** (separate plan after visual approval): Mantine theme object (primaryColor emerald, defaultRadius 8, shadows), `App.jsx` shell rework, `Login.jsx`, `Summary.jsx` Stat, `@tabler/icons-react`.
