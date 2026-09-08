/**
 * SOC Jersey GM Portal — Supabase Edge Function
 *
 * Holds the service_role key (auto-injected by Supabase as
 * SUPABASE_SERVICE_ROLE_KEY — never passed in from the browser, never
 * copy-pasted anywhere). Routes:
 *
 *   POST .../signup            — public, open sign-up. Creates the
 *                                 auth user + a first team, no
 *                                 invite code or approval needed.
 *   POST .../admin/create-gm   — admin-only. Creates a GM account +
 *                                 team directly (e.g. on someone's behalf).
 *   POST .../proxy             — GM-only. Atomic multi-table writes
 *                                 (submit_order, submit_service_request).
 *                                 Body must include which team_id it's for.
 *   POST .../notify            — GM-only. Logs a notification row and
 *                                 emails SOC admin. Also needs team_id.
 *
 * A GM account can own more than one team, so every GM route takes an
 * explicit team_id and this function checks that the authenticated user
 * actually owns that team before doing anything with it.
 *
 * IMPORTANT — this function must be deployed with "Verify JWT" turned
 * OFF (Dashboard → Edge Functions → portal-api → Settings). Supabase's
 * gateway checks that setting BEFORE your code ever runs, and /signup
 * and /team-lookup + /roster-signup are called by people who don't have
 * a session token at all. Every other route still verifies the
 * Authorization header itself, in code below (see getAuthUser) —
 * turning the platform toggle off does not make anything more open
 * than it already was with the Cloudflare version.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTIFY_EMAIL = Deno.env.get("NOTIFY_EMAIL");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const JSON_HEADERS = { "Content-Type": "application/json" };

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
  };
}

function json(data: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...cors(origin) },
  });
}

/** Verify the caller's Supabase JWT and return the auth user object. */
async function getAuthUser(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

/** Look up one specific team, but only if this user actually owns it. */
async function getOwnedTeam(userId: string, teamId: string | undefined) {
  if (!teamId) return null;
  const url = `${SUPABASE_URL}/rest/v1/teams?id=eq.${teamId}&gm_user_id=eq.${userId}&select=*`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

/** Look up a team by its public roster_signup_token (no ownership check —
 * this token IS the credential for the public sign-up link). */
async function getTeamByToken(token: string | undefined) {
  if (!token) return null;
  const url = `${SUPABASE_URL}/rest/v1/teams?roster_signup_token=eq.${encodeURIComponent(token)}&select=id,name,colour_primary,colour_secondary`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

/** Check the admins table using the service_role key. */
async function isAdmin(userId: string) {
  const url = `${SUPABASE_URL}/rest/v1/admins?user_id=eq.${userId}&select=user_id`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length > 0;
}

/** Create a Supabase auth user via the Admin API (service_role only). */
async function createAuthUser(email: string, password: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`Could not create account: ${await res.text()}`);
  return res.json();
}

/** Generic authenticated insert against a Supabase table via REST. */
async function supabaseInsert(table: string, rows: unknown[], returning = true) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: returning ? "return=representation" : "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Insert into ${table} failed: ${await res.text()}`);
  return returning ? res.json() : null;
}

async function supabaseUpdate(table: string, filter: string, patch: unknown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Update on ${table} failed: ${await res.text()}`);
  return res.json();
}

/** Insert a notifications row and (optionally) email SOC admin via Resend. */
async function notify(team: any, type: string, payload: unknown) {
  await supabaseInsert("notifications", [{ team_id: team.id, type, payload, sent: false }], false);

  if (RESEND_API_KEY) {
    try {
      const subjectMap: Record<string, string> = {
        order_submitted: `Jersey order submitted — ${team.name}`,
        service_request: `Service request — ${team.name}`,
      };
      const subject = subjectMap[type] || `SOC Jersey Portal — ${type}`;

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "SOC Jersey Portal <notifications@shinnyofchampions.com>",
          to: [NOTIFY_EMAIL],
          subject,
          text: `Team: ${team.name} (${team.division || "—"}, ${team.season || "—"})\n\n${JSON.stringify(
            payload,
            null,
            2
          )}`,
        }),
      });

      await supabaseUpdate(
        "notifications",
        `team_id=eq.${team.id}&type=eq.${type}&order=created_at.desc&limit=1`,
        { sent: true }
      );
    } catch (err) {
      // Email failure shouldn't fail the whole request — the
      // notification row is already logged for SOC to see.
      console.error("Resend send failed:", err);
    }
  }
}

/** Public route: look up a team's public branding by its sign-up token,
 * so the join page can show the right name/colours before submitting. */
async function handleTeamLookup(body: any) {
  const team = await getTeamByToken(body.token);
  if (!team) throw new Error("That link isn't valid — ask your GM for the current one.");
  return { name: team.name, colour_primary: team.colour_primary, colour_secondary: team.colour_secondary };
}

/** Public route: a player adds themselves to a team's roster via a
 * shared link — no account, no GM data entry required. */
async function handleRosterSignup(body: any) {
  const { token, first_name, last_name, jersey_number, jersey_size, sock_size, position, name_bar_dark, name_bar_light } = body;
  if (!first_name || !last_name || !jersey_size) {
    throw new Error("First name, last name, and jersey size are required.");
  }

  const team = await getTeamByToken(token);
  if (!team) throw new Error("That link isn't valid — ask your GM for the current one.");

  await supabaseInsert(
    "players",
    [
      {
        team_id: team.id,
        first_name,
        last_name,
        jersey_number: jersey_number || null,
        jersey_size,
        sock_size: sock_size || null,
        name_bar_dark: name_bar_dark || null,
        name_bar_light: name_bar_light || null,
        position: position || null,
        active: true,
      },
    ],
    false
  );

  return { team_name: team.name };
}

/** Public route: open sign-up. Creates a new GM account + their first team. */
async function handleSignup(body: any) {
  const { email, password, team_name } = body;
  if (!email || !password || !team_name) {
    throw new Error("Email, password, and team name are all required.");
  }

  const user = await createAuthUser(email, password);

  const [team] = await supabaseInsert("teams", [{ name: team_name, gm_user_id: user.id }]);

  return { team_id: team.id };
}

/** Admin-only: create a GM account + team directly, no invite code needed. */
async function handleAdminCreateGm(data: any) {
  const { email, password, team_name, division, season } = data;
  if (!email || !password || !team_name) {
    throw new Error("email, password, and team_name are required.");
  }

  const user = await createAuthUser(email, password);

  const [team] = await supabaseInsert("teams", [
    { name: team_name, division: division || null, season: season || null, gm_user_id: user.id },
  ]);

  return { team_id: team.id, user_id: user.id };
}

async function handleSubmitOrder(user: any, team: any, data: any) {
  const { notes, lines } = data;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("An order needs at least one jersey line.");
  }

  const [order] = await supabaseInsert("jersey_orders", [
    {
      team_id: team.id,
      order_type: data.order_type === "reorder" ? "reorder" : "initial",
      status: "submitted",
      notes: notes || null,
      submitted_at: new Date().toISOString(),
    },
  ]);

  const orderLines = lines.map((l: any) => ({
    order_id: order.id,
    player_id: l.player_id || null,
    name_on_jersey: l.name_on_jersey,
    jersey_number: l.jersey_number,
    jersey_size: l.jersey_size,
    quantity: l.quantity || 1,
    line_type: l.line_type === "replacement" ? "replacement" : "new",
  }));
  await supabaseInsert("order_lines", orderLines, false);

  await notify(team, "order_submitted", {
    order_id: order.id,
    line_count: orderLines.length,
    submitted_by: user.email,
  });

  return { order_id: order.id, status: "submitted", lines: orderLines.length };
}

async function handleSubmitServiceRequest(user: any, team: any, data: any) {
  const { player_id, request_type, description } = data;
  if (!request_type || !description) {
    throw new Error("request_type and description are required.");
  }

  const [request] = await supabaseInsert("service_requests", [
    { team_id: team.id, player_id: player_id || null, request_type, description, status: "open" },
  ]);

  await notify(team, "service_request", {
    request_id: request.id,
    request_type,
    submitted_by: user.email,
  });

  return { request_id: request.id, status: "open" };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  const url = new URL(req.url);
  const path = url.pathname; // e.g. /functions/v1/portal-api/api/signup

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors(origin) });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, origin);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, origin);
  }

  try {
    // ---- Public routes: no session required ----
    if (path.endsWith("/signup")) {
      const result = await handleSignup(body);
      return json({ ok: true, result }, 200, origin);
    }
    if (path.endsWith("/team-lookup")) {
      const result = await handleTeamLookup(body);
      return json({ ok: true, result }, 200, origin);
    }
    if (path.endsWith("/roster-signup")) {
      const result = await handleRosterSignup(body);
      return json({ ok: true, result }, 200, origin);
    }

    // ---- Everything past this point requires a valid session ----
    const user = await getAuthUser(req);
    if (!user || !user.id) {
      return json({ error: "Not authenticated" }, 401, origin);
    }

    // ---- Admin-only routes ----
    if (path.endsWith("/admin/create-gm")) {
      if (!(await isAdmin(user.id))) {
        return json({ error: "Admin access required" }, 403, origin);
      }
      const result = await handleAdminCreateGm(body.data || body);
      return json({ ok: true, result }, 200, origin);
    }

    // ---- GM routes: caller must own the team_id given in the request ----
    const team = await getOwnedTeam(user.id, body.team_id);
    if (!team) {
      return json({ error: "You don't have access to that team" }, 403, origin);
    }

    if (path.endsWith("/proxy")) {
      const { action, data } = body;
      let result;
      if (action === "submit_order") {
        result = await handleSubmitOrder(user, team, data || {});
      } else if (action === "submit_service_request") {
        result = await handleSubmitServiceRequest(user, team, data || {});
      } else {
        return json({ error: `Unknown action: ${action}` }, 400, origin);
      }
      return json({ ok: true, result }, 200, origin);
    }

    if (path.endsWith("/notify")) {
      const { type, payload } = body;
      if (!type) return json({ error: "type is required" }, 400, origin);
      await notify(team, type, payload || {});
      return json({ ok: true }, 200, origin);
    }

    return json({ error: "Not found" }, 404, origin);
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message || "Server error" }, 500, origin);
  }
});
