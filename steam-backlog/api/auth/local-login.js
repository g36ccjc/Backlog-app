// POST /api/auth/local-login  { username, password }
// Signs in a local account.

import { createSession } from "../_session.js";
import { redis, storageReady, verifyPassword, validUsername } from "../_accounts.js";

export default async function handler(req, res) {
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
    // include linked Steam identity in the session if one exists
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
