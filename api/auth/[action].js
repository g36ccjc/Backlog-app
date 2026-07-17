// Single function serving all auth routes via Vercel dynamic routing:
//   /api/auth/login, /api/auth/callback, /api/auth/me, /api/auth/logout
// Steam sign-in only. Legacy linked accounts (data stored under an old
// u_ id) still resolve via backlog:link so nobody loses their lists.

import { createSession, clearSession, getSession } from "../_session.js";
import { redis, storageReady } from "../_accounts.js";

// ---------- steam login ----------
function login(req, res) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = `${proto}://${host}`;
  const returnTo = `${base}/api/auth/callback`;
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": base,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  res.statusCode = 302;
  res.setHeader("Location", `https://steamcommunity.com/openid/login?${params}`);
  res.end();
}

// ---------- steam callback (sign-in or link) ----------
async function callback(req, res) {
  const go = (path) => { res.statusCode = 302; res.setHeader("Location", path); res.end(); };
  try {
    const q = req.query || {};
    if (q["openid.mode"] !== "id_res") return go("/?login=cancelled");

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (k.startsWith("openid.")) params.set(k, Array.isArray(v) ? v[0] : v);
    }
    params.set("openid.mode", "check_authentication");
    const verify = await fetch("https://steamcommunity.com/openid/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!/is_valid\s*:\s*true/.test(await verify.text())) return go("/?login=failed");

    const m = String(q["openid.claimed_id"] || "").match(/\/openid\/id\/(\d{17})$/);
    if (!m) return go("/?login=failed");
    const steamId = m[1];

    let uid = steamId;
    if (storageReady()) {
      try {
        const linked = await redis(["GET", `backlog:link:${steamId}`]);
        if (linked) uid = linked;
      } catch {}
    }
    createSession(res, uid, steamId);
    return go("/");
  } catch {
    return go("/?login=error");
  }
}

// ---------- me ----------
async function me(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = getSession(req);
  if (!session) return res.status(200).json({ user: null });

  let username = null;
  if (session.uid.startsWith("u_") && storageReady()) {
    try {
      const prof = JSON.parse(await redis(["GET", `backlog:profile:${session.uid}`]) || "{}");
      username = prof.username || null;
    } catch {}
  }
  let name = username, avatar = null;
  const key = process.env.STEAM_API_KEY;
  if (key && session.steamId) {
    try {
      const r = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${session.steamId}`
      );
      const d = await r.json();
      const p = d?.response?.players?.[0];
      if (p) { name = p.personaname || name; avatar = p.avatarmedium || p.avatar || null; }
    } catch {}
  }
  return res.status(200).json({
    user: { uid: session.uid, steamId: session.steamId, name, avatar, username },
  });
}

// ---------- logout ----------
function logout(req, res) {
  clearSession(res);
  res.status(200).json({ ok: true });
}

// ---------- dispatcher ----------
export default async function handler(req, res) {
  switch (req.query?.action) {
    case "login":       return login(req, res);
    case "callback":    return callback(req, res);
    case "me":          return me(req, res);
    case "logout":      return logout(req, res);
    default:            return res.status(404).json({ error: "Unknown auth action." });
  }
}
