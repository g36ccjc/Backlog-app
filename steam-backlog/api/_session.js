// Shared session helpers: HMAC-signed cookie holding the account id (uid)
// and, when available, the linked SteamID.
// uid is either a 17-digit SteamID (Steam-first accounts) or "u_..." (local
// accounts). Old-format cookies (steamId only) remain valid.
// Requires env var SESSION_SECRET.

import crypto from "crypto";

const COOKIE = "bl_session";
const MAX_AGE_DAYS = 90;

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}
function validUid(uid) {
  return /^\d{17}$/.test(uid) || /^u_[A-Za-z0-9_-]{6,40}$/.test(uid);
}

export function createSession(res, uid, steamId) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET not set");
  const payload = `${uid}|${steamId || ""}.${Date.now()}`;
  const token = `${payload}.${sign(payload, secret)}`;
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60;
  res.setHeader("Set-Cookie",
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

export function clearSession(res) {
  res.setHeader("Set-Cookie",
    `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export function getSession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const cookies = req.headers.cookie || "";
  const match = cookies.split(/;\s*/).find(c => c.startsWith(COOKIE + "="));
  if (!match) return null;
  const token = match.slice(COOKIE.length + 1);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [idPart, ts, sig] = parts;
  const payload = `${idPart}.${ts}`;
  const expected = sign(payload, secret);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const ageMs = Date.now() - Number(ts);
  if (!Number.isFinite(ageMs) || ageMs > MAX_AGE_DAYS * 24 * 60 * 60 * 1000) return null;

  // New format: "uid|steamId" — old format: bare steamId
  let uid, steamId;
  if (idPart.includes("|")) {
    [uid, steamId] = idPart.split("|");
    steamId = steamId || null;
  } else {
    uid = idPart; steamId = /^\d{17}$/.test(idPart) ? idPart : null;
  }
  if (!validUid(uid)) return null;
  if (steamId && !/^\d{17}$/.test(steamId)) steamId = null;
  return { uid, steamId };
}
