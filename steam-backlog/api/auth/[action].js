// Single function serving all auth routes via Vercel dynamic routing:
//   /api/auth/login, /api/auth/callback, /api/auth/me, /api/auth/logout,
//   /api/auth/register, /api/auth/local-login
// Consolidated to stay under Vercel's Hobby-plan function limit.

import crypto from "crypto";
import { createSession, clearSession, getSession } from "../_session.js";
import { redis, storageReady, hashPassword, verifyPassword, validUsername } from "../_accounts.js";

// ---------- steam login ----------
function login(req, res) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = `${proto}://${host}`;
  const isLink = req.query?.link === "1";
  const returnTo = `${base}/api/auth/callback${isLink ? "?link=1" : ""}`;
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

    if (q.link === "1") {
      const session = getSession(req);
      if (!session || !session.uid.startsWith("u_")) return go("/?link=failed");
      if (!storageReady()) return go("/?link=failed");
      const [ownData, linked] = await Promise.all([
        redis(["EXISTS", `backlog:user:${steamId}`]),
        redis(["GET", `backlog:link:${steamId}`]),
      ]);
      if (ownData === 1 || (linked && linked !== session.uid)) return go("/?link=conflict");
      await redis(["SET", `backlog:link:${steamId}`, session.uid]);
      try {
        const prof = JSON.parse(await redis(["GET", `backlog:profile:${session.uid}`]) || "{}");
        prof.steamId = steamId;
        await redis(["SET", `backlog:profile:${session.uid}`, JSON.stringify(prof)]);
      } catch {}
      createSession(res, session.uid, steamId);
      return go("/?link=ok");
    }

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

// ---------- register ----------
async function register(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!storageReady()) return res.status(500).json({ error: "Storage not configured." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const username = (body?.username || "").trim();
  const password = body?.password || "";

  if (!validUsername(username)) {
    return res.status(400).json({ error: "Username must be 3–20 letters, numbers or underscores." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  try {
    const key = `backlog:auth:${username.toLowerCase()}`;
    const existing = await redis(["GET", key]);
    if (existing) return res.status(409).json({ error: "That username is taken." });
    const uid = "u_" + crypto.randomBytes(9).toString("base64url");
    const { salt, hash } = hashPassword(password);
    const set = await redis(["SET", key, JSON.stringify({ uid, username, salt, hash, createdAt: Date.now() }), "NX"]);
    if (set === null) return res.status(409).json({ error: "That username is taken." });
    await redis(["SET", `backlog:profile:${uid}`, JSON.stringify({ username, steamId: null })]);
    createSession(res, uid, null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

// ---------- local login ----------
async function localLogin(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!storageReady()) return res.status(500).json({ error: "Storage not configured." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const username = (body?.username || "").trim();
  const password = body?.password || "";
  if (!validUsername(username) || typeof password !== "string") {
    return res.status(401).json({ error: "Wrong username or password." });
  }
  try {
    const raw = await redis(["GET", `backlog:auth:${username.toLowerCase()}`]);
    if (!raw) return res.status(401).json({ error: "Wrong username or password." });
    const acct = JSON.parse(raw);
    if (!verifyPassword(password, acct.salt, acct.hash)) {
      return res.status(401).json({ error: "Wrong username or password." });
    }
    let steamId = null;
    try {
      const prof = JSON.parse(await redis(["GET", `backlog:profile:${acct.uid}`]) || "{}");
      if (/^\d{17}$/.test(prof.steamId || "")) steamId = prof.steamId;
    } catch {}
    createSession(res, acct.uid, steamId);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

// ---------- dispatcher ----------
export default async function handler(req, res) {
  switch (req.query?.action) {
    case "login":       return login(req, res);
    case "callback":    return callback(req, res);
    case "me":          return me(req, res);
    case "logout":      return logout(req, res);
    case "register":    return register(req, res);
    case "local-login": return localLogin(req, res);
    default:            return res.status(404).json({ error: "Unknown auth action." });
  }
}
