# SOC Jersey GM Portal
## Setup Guide

---

## Architecture

```
Browser (jerseys.shinnyofchampions.com)
    │
    ├─── Supabase (auth + database, RLS enforced)
    │       Uses anon key (safe to expose)
    │
    └─── Cloudflare Worker (soc-jersey-portal-api.*.workers.dev)
            Holds service_role key (never exposed)
            Routes: /api/notify, /api/proxy
```

---

## Step 1 — Supabase Setup

1. Create a project at https://supabase.com
2. In the SQL editor, run `db/schema.sql`
3. Under Authentication → Settings → enable "Email" provider
4. Note your project URL and anon key from Settings → API

---

## Step 2 — Bootstrap the First Admin

Sign-up itself is fully open: anyone can create an account and a team
straight from the portal, no code or approval needed — that's the point,
so teams can hop on and start tracking rosters immediately. Only the
**Admin** role (for SOC oversight — seeing every team, adding a GM
account on someone's behalf) needs a one-time manual bootstrap:

1. Supabase → Authentication → Users → Invite user (invite yourself).
2. Copy that user's UUID from the Users table.
3. In the SQL editor:

```sql
insert into admins (user_id, email)
values ('<user-uuid-from-auth>', 'admin@example.com');
```

Sign in to the portal with that account and you'll land on the **Admin**
screen instead of a team dashboard, where you can see every team and add
other admins the same way.

A GM account can own more than one team (some GMs run multiple squads) —
they can add another team any time from the "+ Add another team" control
in the sidebar, and switch between them with the team dropdown.

---

## Step 3 — Cloudflare Worker

```bash
cd worker
npm install -g wrangler
wrangler login

# Set secrets (never commit these):
wrangler secret put SUPABASE_URL
# → paste: https://xxxx.supabase.co

wrangler secret put SUPABASE_SERVICE_KEY
# → paste: service_role key from Supabase Settings → API

wrangler secret put NOTIFY_EMAIL
# → paste: your SOC admin email

# Deploy:
wrangler deploy
```

Note the worker URL (e.g. `https://soc-jersey-portal-api.YOUR_SUBDOMAIN.workers.dev`)

---

## Step 4 — Configure Frontend

Edit `frontend/index.html`, update the CONFIG block near the bottom:

```js
const CONFIG = {
  supabaseUrl:  "https://YOUR_PROJECT.supabase.co",
  supabaseKey:  "YOUR_ANON_PUBLIC_KEY",   // anon key only
  workerUrl:    "https://soc-jersey-portal-api.YOUR_SUBDOMAIN.workers.dev",
};
```

---

## Step 5 — Deploy Frontend

### Option A: Subdomain on existing host
Upload `frontend/index.html` to `jerseys.shinnyofchampions.com` root.

### Option B: Cloudflare Pages (recommended - free)
```bash
cd frontend
npx wrangler pages deploy . --project-name soc-jersey-portal
```
Then set a custom domain in Cloudflare Pages settings:
`jerseys.shinnyofchampions.com` → add CNAME in DNS

---

## Step 6 — Test the flow

1. Open the portal URL
2. Sign in with a GM account
3. Verify team profile loads
4. Add a test player → confirm it appears in Supabase `players` table
5. Submit a test order → confirm it appears in `jersey_orders`
6. Check Supabase `notifications` table for the notification record

---

## Email Notifications (Optional)

The Worker has a stub for Resend. To enable:

1. Sign up at https://resend.com (free tier: 3,000 emails/month)
2. Get your API key
3. `wrangler secret put RESEND_API_KEY`
4. Uncomment the Resend block in `worker/worker.js`

---

## File Structure

```
soc-jersey-portal/
├── frontend/
│   └── index.html          ← entire portal, single file
├── worker/
│   ├── worker.js           ← Cloudflare Worker (API proxy)
│   └── wrangler.toml       ← deployment config
├── db/
│   └── schema.sql          ← Supabase tables + RLS policies
└── README.md
```

---

## Data Model Quick Reference

| Table              | Purpose                              |
|--------------------|--------------------------------------|
| `teams`            | One row per team, linked to GM user  |
| `players`          | Permanent roster (soft-delete)       |
| `jersey_orders`    | Order headers                        |
| `order_lines`      | Per-player jersey lines              |
| `service_requests` | Size swaps, replacements, etc.       |
| `notifications`    | Outbound log to SOC                  |

---

## Adding More GMs / Teams

Nothing to do — sign-up is self-serve from the portal's "New here? Create
your team" screen. The Admin screen's "Add GM directly" is there for cases
where SOC wants to set an account up on someone's behalf instead.
