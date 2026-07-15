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

  // ?wishlist=1 -> games on the user's Steam wishlist
  if (req.query?.wishlist === "1") {
    const steamId = session.steamId;
    if (!steamId) return res.status(400).json({ error: "Link your Steam account to import your wishlist." });
    try {
      const r = await fetch(
        `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId}`
      );
      if (!r.ok) throw new Error(`Steam responded ${r.status}`);
      const d = await r.json();
      const items = d?.response?.items || [];
      if (!items.length) {
        return res.status(200).json({
          games: [],
          note: "No wishlist entries found. If you do have games wishlisted, make sure your Steam profile's Game details is set to Public.",
        });
      }
      // resolve names via the store search endpoint (batched, cached by CDN)
      const appids = items.map((it) => it.appid).slice(0, 200);
      const named = [];
      const failed = [];
      await Promise.all(
        appids.map(async (id) => {
          try {
            const r2 = await fetch(
              `https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic&l=english`
            );
            const dd = await r2.json();
            const e = dd?.[id];
            if (e?.success && e.data?.name) {
              named.push({
                appid: id,
                name: e.data.name,
                icon: e.data.header_image || null,
              });
            } else failed.push(id);
          } catch { failed.push(id); }
        })
      );
      // preserve wishlist priority order
      const pri = new Map(items.map((it, i) => [it.appid, i]));
      named.sort((a, b) => (pri.get(a.appid) ?? 0) - (pri.get(b.appid) ?? 0));
      return res.status(200).json({ games: named });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

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
