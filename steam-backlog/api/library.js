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

  // ?yearly=1 -> year-to-date stats built from real Steam unlock timestamps.
  // Walks the user's most-played games and counts achievements unlocked in
  // the current year, plus games that hit 100% this year.
  if (req.query?.yearly === "1") {
    const key = process.env.STEAM_API_KEY;
    const steamId = session.steamId;
    if (!steamId) return res.status(400).json({ error: "Link your Steam account to see yearly stats." });
    if (!key) return res.status(500).json({ error: "Server missing STEAM_API_KEY." });

    const yearStart = Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);

    async function jsonOrNull(url) {
      try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); }
      catch { return null; }
    }

    try {
      // Which games has the user actually touched this year? rtime_last_played
      // narrows the scan to games they've opened at least once this year.
      const owned = await jsonOrNull(
        `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/` +
        `?key=${key}&steamid=${steamId}&include_played_free_games=true&format=json`
      );
      const games = (owned?.response?.games || [])
        .filter((g) => g.rtime_last_played && g.rtime_last_played >= yearStart)
        .sort((a, b) => (b.rtime_last_played || 0) - (a.rtime_last_played || 0))
        .slice(0, 80); // scan cap keeps us inside the serverless time limit

      let achievementsEarned = 0;
      let gamesCompletedThisYear = 0;

      // For each candidate: check every achievement's unlocktime. If it lies
      // within this year, count it. If the game just hit 100% and the *last*
      // achievement was unlocked this year, count it as a year-completion.
      await Promise.all(
        games.map(async (g) => {
          const d = await jsonOrNull(
            `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/` +
            `?appid=${g.appid}&key=${key}&steamid=${steamId}`
          );
          const list = d?.playerstats?.achievements;
          if (!Array.isArray(list) || !list.length) return;
          let unlockedThisYear = 0;
          let totalUnlocked = 0;
          let latestUnlock = 0;
          for (const a of list) {
            if (a.achieved === 1) {
              totalUnlocked++;
              if (a.unlocktime > latestUnlock) latestUnlock = a.unlocktime;
              if (a.unlocktime >= yearStart) unlockedThisYear++;
            }
          }
          achievementsEarned += unlockedThisYear;
          if (totalUnlocked === list.length && latestUnlock >= yearStart) {
            gamesCompletedThisYear++;
          }
        })
      );

      return res.status(200).json({
        year: new Date().getFullYear(),
        achievementsEarned,
        gamesCompletedThisYear,
        gamesScanned: games.length,
      });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

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
          allAppids: [],
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
              `https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic,price_overview&l=english&cc=au`
            );
            const dd = await r2.json();
            const e = dd?.[id];
            if (e?.success && e.data?.name) {
              const po = e.data.price_overview;
              named.push({
                appid: id,
                name: e.data.name,
                icon: e.data.header_image || null,
                price: e.data.is_free
                  ? { free: true }
                  : po
                  ? { final: po.final, discount: po.discount_percent || 0, str: po.final_formatted || null }
                  : null,
              });
            } else failed.push(id);
          } catch { failed.push(id); }
        })
      );
      // preserve wishlist priority order
      const pri = new Map(items.map((it, i) => [it.appid, i]));
      named.sort((a, b) => (pri.get(a.appid) ?? 0) - (pri.get(b.appid) ?? 0));
      return res.status(200).json({ games: named, allAppids: items.map((it) => it.appid) });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  // ?recent=1 -> games played in the last two weeks, ordered by when they
  // were last launched where possible. GetRecentlyPlayedGames reliably
  // returns the right SET of games for any account; rtime_last_played from
  // GetOwnedGames adds true recency but Steam only returns that field for
  // some accounts (dependably only the key owner's own). So: take the set
  // from the first, enrich with timestamps from the second, and sort by
  // timestamp only when we actually got them.
  if (req.query?.recent === "1") {
    const key = process.env.STEAM_API_KEY;
    const steamId = session.steamId;
    if (!steamId) return res.status(400).json({ error: "Link your Steam account to see recent games." });
    if (!key) return res.status(500).json({ error: "Server missing STEAM_API_KEY." });
    try {
      const [recentR, ownedR] = await Promise.allSettled([
        fetch(
          `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/` +
          `?key=${key}&steamid=${steamId}&count=10&format=json`
        ).then((r) => (r.ok ? r.json() : null)),
        fetch(
          `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/` +
          `?key=${key}&steamid=${steamId}&include_played_free_games=true&format=json`
        ).then((r) => (r.ok ? r.json() : null)),
      ]);
      const recent = recentR.status === "fulfilled" ? recentR.value?.response?.games || [] : [];
      const rtimes = new Map();
      if (ownedR.status === "fulfilled") {
        for (const g of ownedR.value?.response?.games || []) {
          if (g.rtime_last_played) rtimes.set(g.appid, g.rtime_last_played);
        }
      }
      const games = recent.map((g) => ({
        appid: g.appid,
        name: g.name,
        playtime2w: g.playtime_2weeks || 0,
        playtimeForever: g.playtime_forever || 0,
        lastPlayed: rtimes.get(g.appid) || null,
      }));
      // Only sort by timestamps when EVERY game has one — a partial set
      // would rank the stamped games and unfairly sink the rest (often the
      // newest). Otherwise keep Steam's own recently-played order.
      if (games.length && games.every((g) => g.lastPlayed)) {
        games.sort((a, b) => b.lastPlayed - a.lastPlayed);
      }
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
