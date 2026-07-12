// GET /api/auth/me
// Returns the logged-in user's SteamID, display name, and avatar,
// or { user: null } if not logged in.

import { getSession } from "../_session.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = getSession(req);
  if (!session) return res.status(200).json({ user: null });

  const key = process.env.STEAM_API_KEY;
  let name = null, avatar = null;
  if (key) {
    try {
      const r = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/` +
        `?key=${key}&steamids=${session.steamId}`
      );
      const d = await r.json();
      const p = d?.response?.players?.[0];
      if (p) { name = p.personaname || null; avatar = p.avatarmedium || p.avatar || null; }
    } catch { /* profile lookup is cosmetic; ignore failures */ }
  }

  return res.status(200).json({
    user: { steamId: session.steamId, name, avatar },
  });
}
