// POST /api/auth/register  { username, password }
// Creates a local (non-Steam) account and signs the user in.

import crypto from "crypto";
import { createSession } from "../_session.js";
import { redis, storageReady, hashPassword, validUsername } from "../_accounts.js";

export default async function handler(req, res) {
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
    // NX guards against a race on the same username
    const set = await redis(["SET", key, JSON.stringify({ uid, username, salt, hash, createdAt: Date.now() }), "NX"]);
    if (set === null) return res.status(409).json({ error: "That username is taken." });
    await redis(["SET", `backlog:profile:${uid}`, JSON.stringify({ username, steamId: null })]);

    createSession(res, uid, null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
