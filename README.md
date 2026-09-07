# SOC Jersey GM Portal
## Setup Guide

---

## Architecture

```
Browser (jerseys.shinnyofchampions.com)
    │
    └─── Supabase
            ├── Auth + database (RLS enforced) — uses anon key (safe to expose)
            └── Edge Function "portal-api" — holds service_role key (never
                exposed), auto-injected by Supabase itself
                Routes: /signup, /admin/create-gm, /proxy, /notify
```

Everything lives in one Supabase project and its dashboard — no separate
backend host, no separate secrets manager.

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

## Step 3 — Deploy the Edge Function (no CLI needed)

1. In your Supabase project, go to **Edge Functions** in the left sidebar.
2. Click **Deploy a new function → Via Editor**.
3. Name it `portal-api` (must match this exactly — the frontend's
   `CONFIG.workerUrl` assumes this name).
4. Delete the placeholder code and paste in the entire contents of
   `supabase/functions/portal-api/index.ts`. Click **Deploy**.
5. Open the function's **Settings** and turn **Verify JWT off**. This is
   required — `/signup` is called by people who don't have a session yet,
   and Supabase's gateway would otherwise reject that request before your
   code even runs. Every other route still checks the Authorization
   header itself in code, so this doesn't open anything up.
6. Go to **Edge Functions → Secrets** (project-wide, shared by all
   functions) and add:
   - `NOTIFY_EMAIL` → your SOC admin email
   - `RESEND_API_KEY` → optional, see "Email Notifications" below

   You do **not** need to set `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`
   — Supabase injects those automatically for every Edge Function in the
   project.

Your function's URL is:
```
https://YOUR_PROJECT.supabase.co/functions/v1/portal-api
```

---

## Step 4 — Configure Frontend

Edit `frontend/index.html`, update the CONFIG block near the bottom:

```js
const CONFIG = {
  supabaseUrl:  "https://YOUR_PROJECT.supabase.co",
  supabaseKey:  "YOUR_ANON_PUBLIC_KEY",   // anon key only
  workerUrl:    "https://YOUR_PROJECT.supabase.co/functions/v1/portal-api",
};
```

---

## Step 5 — Deploy Frontend

### Option A: Subdomain on existing host
Upload `frontend/index.html` to `jerseys.shinnyofchampions.com` root.

### Option B: Cloudflare Pages (recommended — free, no CLI needed)
In the Cloudflare dashboard: Workers & Pages → Create application →
drag-and-drop your `frontend/index.html` file → Deploy. Then attach
`jerseys.shinnyofchampions.com` as a custom domain in that project's
settings.

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

The function has a stub for Resend. To enable:

1. Sign up at https://resend.com (free tier: 3,000 emails/month)
2. Get your API key
3. Add it as `RESEND_API_KEY` under Edge Functions → Secrets
4. Redeploy the function (Deploy a new function → Via Editor, paste the
   same code again) so it picks up the new secret

---

## File Structure

```
soc-jersey-portal/
├── frontend/
│   └── index.html          ← entire portal, single file
├── supabase/
│   └── functions/
│       └── portal-api/
│           └── index.ts    ← Supabase Edge Function (API)
├── db/
│   ├── schema.sql          ← Supabase tables + RLS policies
│   └── migrations/         ← one-time catch-up scripts for live projects
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
