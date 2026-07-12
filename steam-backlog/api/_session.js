// Shared session helpers: HMAC-signed cookie holding the user's SteamID.
// Requires env var SESSION_SECRET (any long random string).

import crypto from "crypto";

const COOKIE = "bl_session";
const MAX_AGE_DAYS = 90;

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function createSession(res, steamId) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET not set");
  const payload = `${steamId}.${Date.now()}`;
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
  const [steamId, ts, sig] = parts;
  const payload = `${steamId}.${ts}`;
  const expected = sign(payload, secret);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const ageMs = Date.now() - Number(ts);
  if (!Number.isFinite(ageMs) || ageMs > MAX_AGE_DAYS * 24 * 60 * 60 * 1000) return null;
  if (!/^\d{17}$/.test(steamId)) return null;
  return { steamId };
}
