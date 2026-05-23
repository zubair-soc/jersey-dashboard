/**
 * SOC Jersey Portal - Cloudflare Worker
 * API proxy: hides Supabase service-role key from frontend.
 * Deploy: wrangler deploy
 *
 * Secrets (set via wrangler secret put):
 *   SUPABASE_URL          https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key (never exposed to browser)
 *   NOTIFY_EMAIL          soc admin email for notifications
 *   ALLOWED_ORIGIN        https://jerseys.shinnyofchampions.com
 */

const CORS_HEADERS = (origin) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-gm-token",
  "Access-Control-Max-Age": "86400",
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";

    // Pre-flight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS(allowed) });
    }

    // Only allow configured origin in production
    if (allowed !== "*" && origin !== allowed) {
      return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    const path = url.pathname; // e.g. /api/orders, /api/players, /api/requests

    try {
      // ── Verify GM JWT from Supabase Auth ──────────────────────
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.replace("Bearer ", "").trim();
      if (!token) return json({ error: "Unauthorized" }, 401, allowed);

      const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: env.SUPABASE_SERVICE_KEY,
        },
      });
      if (!userRes.ok) return json({ error: "Invalid token" }, 401, allowed);
      const user = await userRes.json();
      const userId = user.id;

      // ── Route ─────────────────────────────────────────────────
      if (path === "/api/notify" && request.method === "POST") {
        return handleNotify(request, env, userId, allowed);
      }

      if (path.startsWith("/api/proxy") && request.method === "POST") {
        return handleProxy(request, env, token, allowed);
      }

      return json({ error: "Not found" }, 404, allowed);
    } catch (err) {
      return json({ error: err.message }, 500, allowed);
    }
  },
};

/**
 * Generic Supabase proxy - forwards authenticated REST calls
 * Body: { table, method, query, body }
 */
async function handleProxy(request, env, token, origin) {
  const { table, method = "GET", query = "", body } = await request.json();

  const supaUrl = `${env.SUPABASE_URL}/rest/v1/${table}${query ? "?" + query : ""}`;
  const res = await fetch(supaUrl, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_SERVICE_KEY,
      Prefer: method === "POST" ? "return=representation" : "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  return json(data, res.status, origin);
}

/**
 * Send notification email to SOC admin when GM submits an order
 */
async function handleNotify(request, env, userId, origin) {
  const payload = await request.json();

  // Use Supabase Edge Functions or a simple fetch to your email provider.
  // Example stub - replace with Resend / SendGrid / etc.
  const emailBody = {
    from: "portal@shinnyofchampions.com",
    to: env.NOTIFY_EMAIL,
    subject: `[SOC Portal] New ${payload.type} from ${payload.teamName}`,
    text: JSON.stringify(payload, null, 2),
  };

  // Uncomment and configure for your email provider:
  // await fetch("https://api.resend.com/emails", {
  //   method: "POST",
  //   headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
  //   body: JSON.stringify(emailBody),
  // });

  // Log to Supabase notifications table
  await fetch(`${env.SUPABASE_URL}/rest/v1/notifications`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      team_id: payload.teamId,
      type: payload.type,
      payload: payload,
    }),
  });

  return json({ ok: true }, 200, origin);
}

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS(origin),
    },
  });
}
