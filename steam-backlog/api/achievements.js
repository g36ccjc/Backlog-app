// GET /api/achievements?appid=123
// Returns the game's full achievement list with the logged-in user's unlock
// state and global rarity:
//   { achievements: [{ id, name, description, hidden, icon, iconLocked,
//                      unlocked, unlockTime, globalPercent }] }
//
// Sources (all official Steam Web API):
//   GetSchemaForGame                       — names, descriptions, icons
//   GetPlayerAchievements                  — this user's unlock state
//   GetGlobalAchievementPercentagesForApp  — rarity

import { getSession } from "./_session.js";

const STEAM_API = "https://api.steampowered.com";

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });

  const key = process.env.STEAM_API_KEY;
  if (!key) return res.status(500).json({ error: "Server missing STEAM_API_KEY." });

  const appid = parseInt(req.query?.appid, 10);
  if (!Number.isFinite(appid)) return res.status(400).json({ error: "Missing appid." });

  try {
    const [schemaR, playerR, globalR] = await Promise.allSettled([
      getJson(`${STEAM_API}/ISteamUserStats/GetSchemaForGame/v2/?key=${key}&appid=${appid}`),
      getJson(`${STEAM_API}/ISteamUserStats/GetPlayerAchievements/v1/?appid=${appid}&key=${key}&steamid=${session.steamId}`),
      getJson(`${STEAM_API}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`),
    ]);

    const schema = schemaR.status === "fulfilled"
      ? (schemaR.value?.game?.availableGameStats?.achievements || [])
      : [];
    if (!schema.length) {
      return res.status(200).json({ achievements: [], note: "This game has no achievements." });
    }

    const mine = new Map();
    if (playerR.status === "fulfilled") {
      for (const a of playerR.value?.playerstats?.achievements || []) {
        mine.set(a.apiname, a);
      }
    }
    const global = new Map();
    if (globalR.status === "fulfilled") {
      for (const a of globalR.value?.achievementpercentages?.achievements || []) {
        global.set(a.name, a.percent);
      }
    }

    const achievements = schema.map((a) => {
      const p = mine.get(a.name);
      const pct = global.get(a.name);
      return {
        id: a.name,
        name: a.displayName || a.name,
        description: a.description || "",
        hidden: a.hidden === 1,
        icon: a.icon || null,
        iconLocked: a.icongray || null,
        unlocked: p ? p.achieved === 1 : false,
        unlockTime: p && p.achieved === 1 ? p.unlocktime || null : null,
        globalPercent: typeof pct === "number" ? Math.round(pct * 10) / 10
          : (typeof pct === "string" ? Math.round(parseFloat(pct) * 10) / 10 : null),
      };
    });

    return res.status(200).json({ achievements });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
