// GET /api/auth/me
// Returns the signed-in user: uid, linked steamId (if any), display name,
// avatar, and username (for local accounts).

import { getSession } from "../_session.js";
import { redis, storageReady } from "../_accounts.js";

export default async function handler(req, res) {
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
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/` +
        `?key=${key}&steamids=${session.steamId}`
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
