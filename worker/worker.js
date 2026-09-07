/**
 * SOC Jersey GM Portal — Cloudflare Worker
 *
 * Holds the Supabase service_role key (never exposed to the browser).
 * The frontend only ever holds the anon key and talks to Supabase
 * directly for normal reads/writes (protected by RLS). It calls this
 * Worker only for the things that need elevated privilege:
 *
 *   POST /api/signup            — public, open sign-up. Creates the
 *                                  auth user + a first team, no
 *                                  invite code or approval needed.
 *   POST /api/admin/create-gm   — admin-only. Creates a GM account +
 *                                  team directly (e.g. on someone's behalf).
 *   POST /api/proxy             — GM-only. Atomic multi-table writes
 *                                  (submit_order, submit_service_request).
 *                                  Body must include which team_id it's for.
 *   POST /api/notify            — GM-only. Logs a notification row and
 *                                  emails SOC admin. Also needs team_id.
 *
 * A GM account can own more than one team, so every GM route takes an
 * explicit team_id and the Worker checks that the authenticated user
 * actually owns that team before doing anything with it — it never
 * assumes "the" team for a user.
 *
 * Every route except /api/signup requires: Authorization: Bearer <supabase JWT>
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...cors(origin) },
  });
}

/** Verify the caller's Supabase JWT and return the auth user object. */
async function getAuthUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

/** Look up one specific team, but only if this user actually owns it. */
async function getOwnedTeam(userId, teamId, env) {
  if (!teamId) return null;
  const url = `${env.SUPABASE_URL}/rest/v1/teams?id=eq.${teamId}&gm_user_id=eq.${userId}&select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

/** Check the admins table using the service_role key. */
async function isAdmin(userId, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/admins?user_id=eq.${userId}&select=user_id`;
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length > 0;
}

/** Create a Supabase auth user via the Admin API (service_role only). */
async function createAuthUser(email, password, env) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Could not create account: ${detail}`);
  }
  return res.json();
}

/** Generic authenticated insert against a Supabase table via REST. */
async function supabaseInsert(table, rows, env, returning = true) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: returning ? "return=representation" : "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Insert into ${table} failed: ${detail}`);
  }
  return returning ? res.json() : null;
}

async function supabaseUpdate(table, filter, patch, env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Update on ${table} failed: ${detail}`);
  }
  return res.json();
}

/** Insert a notifications row and (optionally) email SOC admin via Resend. */
async function notify(env, team, type, payload) {
  await supabaseInsert(
    "notifications",
    [{ team_id: team.id, type, payload, sent: false }],
    env,
    false
  );

  if (env.RESEND_API_KEY) {
    try {
      const subjectMap = {
        order_submitted: `Jersey order submitted — ${team.name}`,
        service_request: `Service request — ${team.name}`,
      };
      const subject = subjectMap[type] || `SOC Jersey Portal — ${type}`;

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "SOC Jersey Portal <notifications@shinnyofchampions.com>",
          to: [env.NOTIFY_EMAIL],
          subject,
          text: `Team: ${team.name} (${team.division}, ${team.season})\n\n${JSON.stringify(
            payload,
            null,
            2
          )}`,
        }),
      });

      await supabaseUpdate(
        "notifications",
        `team_id=eq.${team.id}&type=eq.${type}&order=created_at.desc&limit=1`,
        { sent: true },
        env
      );
    } catch (err) {
      // Email failure shouldn't fail the whole request — the
      // notification row is already logged for SOC to see.
      console.error("Resend send failed:", err);
    }
  }
}

/** Public route: open sign-up. Creates a new GM account + their first team. */
async function handleSignup(body, env) {
  const { email, password, team_name, division, season } = body;
  if (!email || !password || !team_name || !division || !season) {
    throw new Error("Email, password, team name, division, and season are all required.");
  }

  const user = await createAuthUser(email, password, env);

  const [team] = await supabaseInsert(
    "teams",
    [{ name: team_name, division, season, gm_user_id: user.id }],
    env
  );

  return { team_id: team.id };
}

/** Admin-only: create a GM account + team directly, no invite code needed. */
async function handleAdminCreateGm(data, env) {
  const { email, password, team_name, division, season } = data;
  if (!email || !password || !team_name || !division || !season) {
    throw new Error("email, password, team_name, division, and season are all required.");
  }

  const user = await createAuthUser(email, password, env);

  const [team] = await supabaseInsert(
    "teams",
    [{ name: team_name, division, season, gm_user_id: user.id }],
    env
  );

  return { team_id: team.id, user_id: user.id };
}

async function handleSubmitOrder(user, team, data, env) {
  const { notes, lines } = data;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("An order needs at least one jersey line.");
  }

  const [order] = await supabaseInsert(
    "jersey_orders",
    [
      {
        team_id: team.id,
        order_type: data.order_type === "reorder" ? "reorder" : "initial",
        status: "submitted",
        notes: notes || null,
        submitted_at: new Date().toISOString(),
      },
    ],
    env
  );

  const orderLines = lines.map((l) => ({
    order_id: order.id,
    player_id: l.player_id || null,
    name_on_jersey: l.name_on_jersey,
    jersey_number: l.jersey_number,
    jersey_size: l.jersey_size,
    quantity: l.quantity || 1,
    line_type: l.line_type === "replacement" ? "replacement" : "new",
  }));
  await supabaseInsert("order_lines", orderLines, env, false);

  await notify(env, team, "order_submitted", {
    order_id: order.id,
    line_count: orderLines.length,
    submitted_by: user.email,
  });

  return { order_id: order.id, status: "submitted", lines: orderLines.length };
}

async function handleSubmitServiceRequest(user, team, data, env) {
  const { player_id, request_type, description } = data;
  if (!request_type || !description) {
    throw new Error("request_type and description are required.");
  }

  const [request] = await supabaseInsert(
    "service_requests",
    [
      {
        team_id: team.id,
        player_id: player_id || null,
        request_type,
        description,
        status: "open",
      },
    ],
    env
  );

  await notify(env, team, "service_request", {
    request_id: request.id,
    request_type,
    submitted_by: user.email,
  });

  return { request_id: request.id, status: "open" };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(origin) });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400, origin);
    }

    try {
      // ---- Public route: no session required ----
      if (url.pathname === "/api/signup") {
        const result = await handleSignup(body, env);
        return json({ ok: true, result }, 200, origin);
      }

      // ---- Everything past this point requires a valid session ----
      const user = await getAuthUser(request, env);
      if (!user || !user.id) {
        return json({ error: "Not authenticated" }, 401, origin);
      }

      // ---- Admin-only routes ----
      if (url.pathname === "/api/admin/create-gm") {
        if (!(await isAdmin(user.id, env))) {
          return json({ error: "Admin access required" }, 403, origin);
        }
        const result = await handleAdminCreateGm(body.data || body, env);
        return json({ ok: true, result }, 200, origin);
      }

      // ---- GM routes: caller must own the team_id given in the request ----
      const team = await getOwnedTeam(user.id, body.team_id, env);
      if (!team) {
        return json({ error: "You don't have access to that team" }, 403, origin);
      }

      if (url.pathname === "/api/proxy") {
        const { action, data } = body;
        let result;
        if (action === "submit_order") {
          result = await handleSubmitOrder(user, team, data || {}, env);
        } else if (action === "submit_service_request") {
          result = await handleSubmitServiceRequest(user, team, data || {}, env);
        } else {
          return json({ error: `Unknown action: ${action}` }, 400, origin);
        }
        return json({ ok: true, result }, 200, origin);
      }

      if (url.pathname === "/api/notify") {
        const { type, payload } = body;
        if (!type) return json({ error: "type is required" }, 400, origin);
        await notify(env, team, type, payload || {});
        return json({ ok: true }, 200, origin);
      }

      return json({ error: "Not found" }, 404, origin);
    } catch (err) {
      console.error(err);
      return json({ error: err.message || "Server error" }, 500, origin);
    }
  },
};
