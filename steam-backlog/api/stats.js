// POST /api/stats  body: { appids: [440, 570, ...] }
// For each appid returns:
//   achUnlocked / achTotal  (from Steam, requires your key + public profile)
//   mainStory / completionist hours (from a public HLTB-by-appid service)
//
// Env vars (set in Vercel):
//   STEAM_API_KEY, STEAM_ID
//
// HLTB source: a community REST service that maps Steam appid -> HLTB times.
// It's third-party and best-effort; failures degrade to null, never throw.

const STEAM_API = "https://api.steampowered.com";
const HLTB_BASE = "https://hltbapi.codepotatoes.de/steam"; // /{appid}

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function steamAchievements(appid, key, steamId) {
  try {
    const url =
      `${STEAM_API}/ISteamUserStats/GetPlayerAchievements/v1/` +
      `?appid=${appid}&key=${key}&steamid=${steamId}`;
    const d = await getJson(url);
    const list = d?.playerstats?.achievements;
    if (Array.isArray(list) && list.length) {
      return {
        achTotal: list.length,
        achUnlocked: list.filter((a) => a.achieved === 1).length,
        owned: true,
      };
    }
    // Valid response but no achievements array — owned, no achievements
    return { achTotal: 0, achUnlocked: 0, owned: true };
  } catch {
    // Not owned, private, or no stats — leave unknown
    return { achTotal: null, achUnlocked: null, owned: false };
  }
}

async function hltbTimes(appid) {
  try {
    const d = await getJson(`${HLTB_BASE}/${appid}`);
    return {
      mainStory: typeof d.mainStory === "number" ? d.mainStory : null,
      completionist: typeof d.completionist === "number" ? d.completionist : null,
    };
  } catch {
    return { mainStory: null, completionist: null };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST." });
  }

  const key = process.env.STEAM_API_KEY;
  const steamId = process.env.STEAM_ID;

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const appids = Array.isArray(body?.appids) ? body.appids.slice(0, 60) : [];
  if (!appids.length) return res.status(400).json({ error: "No appids provided." });

  const results = {};
  await Promise.all(
    appids.map(async (appid) => {
      const [ach, hltb] = await Promise.all([
        key && steamId
          ? steamAchievements(appid, key, steamId)
          : Promise.resolve({ achTotal: null, achUnlocked: null, owned: false }),
        hltbTimes(appid),
      ]);
      results[appid] = { ...ach, ...hltb };
    })
  );

  return res.status(200).json({ stats: results, at: Date.now() });
}
