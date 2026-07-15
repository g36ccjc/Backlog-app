// GET /api/library
// Returns your owned games (appid, name, icon) so you can one-tap import
// them into the backlog. Achievement + HLTB stats are fetched separately
// via /api/stats once games are in the list.

import { getSession } from "./_session.js";

const STEAM_API = "https://api.steampowered.com";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });

  // ?recent=1 -> games played in the last two weeks (Steam recency data)
  if (req.query?.recent === "1") {
    const key = process.env.STEAM_API_KEY;
    const steamId = session.steamId;
    if (!steamId) return res.status(400).json({ error: "Link your Steam account to see recent games." });
    if (!key) return res.status(500).json({ error: "Server missing STEAM_API_KEY." });
    try {
      const r = await fetch(
        `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/` +
        `?key=${key}&steamid=${steamId}&count=10&format=json`
      );
      if (!r.ok) throw new Error(`Steam responded ${r.status}`);
      const d = await r.json();
      const games = (d?.response?.games || []).map((g) => ({
        appid: g.appid,
        name: g.name,
        playtime2w: g.playtime_2weeks || 0,
        playtimeForever: g.playtime_forever || 0,
      }));
      return res.status(200).json({ games });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }
  const key = process.env.STEAM_API_KEY;
  const steamId = session.steamId;
  if (!steamId) {
    return res.status(400).json({ error: "Link your Steam account (Profile → Link Steam) to import your library." });
  }
  if (!key) {
    return res.status(500).json({ error: "Server missing STEAM_API_KEY." });
  }

  try {
    const url =
      `${STEAM_API}/IPlayerService/GetOwnedGames/v1/` +
      `?key=${key}&steamid=${steamId}` +
      `&include_appinfo=true&include_played_free_games=true&format=json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Steam responded ${r.status}`);
    const data = await r.json();

    const games = (data?.response?.games || []).map((g) => ({
      appid: g.appid,
      name: g.name,
      playtimeMinutes: g.playtime_forever || 0,
      icon: g.img_icon_url
        ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
        : null,
    }));

    games.sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({
      count: games.length,
      games,
      note: games.length ? undefined : "No games returned — check that your profile and Game details are Public.",
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
