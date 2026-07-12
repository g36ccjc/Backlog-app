// POST /api/stats  body: { items: [{appid, name}, ...] }   (legacy: { appids: [...] })
// For each game returns:
//   achUnlocked / achTotal  (Steam, for the logged-in user)
//   mainStory / completionist hours (HowLongToBeat via appid, with name-match
//   fallback when the HLTB service returns multiple candidates)
//
// Env vars: STEAM_API_KEY. SteamID comes from the session.

import { getSession } from "./_session.js";

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
      };
    }
    return { achTotal: 0, achUnlocked: 0 };
  } catch {
    return { achTotal: null, achUnlocked: null };
  }
}

// Very small name similarity: normalized token overlap. Enough to pick the
// right candidate out of a short list without pulling in a library.
function similarity(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const ta = new Set(norm(a)), tb = new Set(norm(b));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

function readTimes(entry) {
  const main = typeof entry?.mainStory === "number" ? entry.mainStory : null;
  const comp = typeof entry?.completionist === "number" ? entry.completionist : null;
  return { mainStory: main, completionist: comp };
}

async function hltbTimes(appid, name) {
  try {
    const d = await getJson(`${HLTB_BASE}/${appid}`);
    // Single populated entry
    if (d && !Array.isArray(d)) {
      const t = readTimes(d);
      if (t.mainStory != null || t.completionist != null) return t;
    }
    // Multiple candidates: pick the best name match with usable times
    if (Array.isArray(d) && d.length && name) {
      const scored = d
        .map((e) => ({ e, s: similarity(name, e.name || e.title || "") }))
        .sort((x, y) => y.s - x.s);
      for (const { e, s } of scored) {
        if (s < 0.4) break; // don't accept wild mismatches
        const t = readTimes(e);
        if (t.mainStory != null || t.completionist != null) return t;
      }
    }
    return { mainStory: null, completionist: null };
  } catch {
    return { mainStory: null, completionist: null };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  const key = process.env.STEAM_API_KEY;
  const steamId = session.steamId;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  // Accept new {items:[{appid,name}]} and legacy {appids:[...]}
  let items = [];
  if (Array.isArray(body?.items)) {
    items = body.items
      .filter((it) => it && Number.isFinite(+it.appid))
      .map((it) => ({ appid: +it.appid, name: typeof it.name === "string" ? it.name : "" }));
  } else if (Array.isArray(body?.appids)) {
    items = body.appids.filter((a) => Number.isFinite(+a)).map((a) => ({ appid: +a, name: "" }));
  }
  items = items.slice(0, 60);
  if (!items.length) return res.status(400).json({ error: "No games provided." });

  const results = {};
  await Promise.all(
    items.map(async ({ appid, name }) => {
      const [ach, hltb] = await Promise.all([
        key ? steamAchievements(appid, key, steamId)
            : Promise.resolve({ achTotal: null, achUnlocked: null }),
        hltbTimes(appid, name),
      ]);
      results[appid] = { ...ach, ...hltb };
    })
  );

  return res.status(200).json({ stats: results, at: Date.now() });
}
