// Shared account storage helpers for auth endpoints.
// Records:
//   backlog:auth:{usernameLower} -> { uid, username, salt, hash }
//   backlog:profile:{uid}        -> { username, steamId|null }
//   backlog:link:{steamId}       -> uid  (Steam identity linked to a local account)

import crypto from "crypto";

const REST_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export function storageReady() { return Boolean(REST_URL && REST_TOKEN); }

export async function redis(command) {
  const r = await fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`Storage responded ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, s, 64).toString("base64url");
  return { salt: s, hash };
}
export function verifyPassword(password, salt, hash) {
  const attempt = crypto.scryptSync(password, salt, 64).toString("base64url");
  const a = Buffer.from(attempt), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function validUsername(u) {
  return typeof u === "string" && /^[a-zA-Z0-9_]{3,20}$/.test(u);
}
