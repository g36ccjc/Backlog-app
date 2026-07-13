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

// One call for the whole library: appid -> minutes played
async function playtimeMap(key, steamId) {
  try {
    const d = await getJson(
      `${STEAM_API}/IPlayerService/GetOwnedGames/v1/` +
      `?key=${key}&steamid=${steamId}&include_played_free_games=true&format=json`
    );
    const map = new Map();
    for (const g of d?.response?.games || []) map.set(g.appid, g.playtime_forever || 0);
    return map;
  } catch {
    return new Map();
  }
}

// Metacritic score + genres via Steam's store data, in one call.
async function storeMeta(appid) {
  try {
    const d = await getJson(
      `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=metacritic,genres&l=english`
    );
    const entry = d?.[appid];
    if (!entry?.success) return { metaScore: null, genres: [] };
    const s = entry?.data?.metacritic?.score;
    const genres = (entry?.data?.genres || []).map((g) => g.description).slice(0, 6);
    return { metaScore: typeof s === "number" ? s : null, genres };
  } catch {
    return { metaScore: null, genres: [] };
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
  // HLTB uses 0 for "no submissions" — treat it as unknown, not zero hours.
  const num = (v) => (typeof v === "number" && v > 0 ? v : null);
  return { mainStory: num(entry?.mainStory), completionist: num(entry?.completionist) };
}
function hasTimes(t) { return t.mainStory != null || t.completionist != null; }

// Follow-up lookup by HLTB id — the service stores entries under a numeric
// hltbId; the exact route isn't documented, so try the likely paths.
async function hltbById(hltbId) {
  const base = HLTB_BASE.replace(/\/steam$/, "");
  for (const path of [`/hltb/${hltbId}`, `/hltbid/${hltbId}`, `/id/${hltbId}`]) {
    try {
      const d = await getJson(base + path);
      const entry = Array.isArray(d) ? d[0] : d;
      const t = readTimes(entry);
      if (hasTimes(t)) return t;
    } catch { /* try next path */ }
  }
  return null;
}

async function hltbTimes(appid, name) {
  try {
    const d = await getJson(`${HLTB_BASE}/${appid}`);
    // Populated single entry (object, or one-element array per the docs)
    const single = Array.isArray(d) ? (d.length === 1 ? d[0] : null) : d;
    if (single) {
      const t = readTimes(single);
      if (hasTimes(t)) return t;
    }
    // Multiple candidates: these are bare search results and usually carry
    // no times. Rank by name similarity, then resolve the best ones by hltbId.
    if (Array.isArray(d) && d.length > 1 && name) {
      const scored = d
        .map((e) => ({ e, s: similarity(name, e.title || e.name || "") }))
        .sort((x, y) => y.s - x.s)
        .filter(({ s }) => s >= 0.4)
        .slice(0, 2); // at most two follow-ups per game
      for (const { e } of scored) {
        // candidate might already be populated
        const direct = readTimes(e);
        if (hasTimes(direct)) return direct;
        if (e.hltbId != null) {
          const t = await hltbById(e.hltbId);
          if (t) return t;
        }
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
  const steamId = session.steamId; // null for local accounts without Steam linked

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  // Accept new {items:[{appid,name,metaScore?}]} and legacy {appids:[...]}
  // If an item includes metaScore (number or null), it's a cached value we
  // echo back; if absent, we look it up once via the Steam store.
  let items = [];
  if (Array.isArray(body?.items)) {
    items = body.items
      .filter((it) => it && Number.isFinite(+it.appid))
      .map((it) => ({
        appid: +it.appid,
        name: typeof it.name === "string" ? it.name : "",
        hasMeta: ("metaScore" in it) && ("genres" in it),
        metaScore: "metaScore" in it
          ? (typeof it.metaScore === "number" ? it.metaScore : null)
          : undefined,
        genres: Array.isArray(it.genres) ? it.genres.slice(0, 6) : undefined,
      }));
  } else if (Array.isArray(body?.appids)) {
    items = body.appids.filter((a) => Number.isFinite(+a)).map((a) => ({ appid: +a, name: "", hasMeta: false }));
  }
  items = items.slice(0, 60);
  if (!items.length) return res.status(400).json({ error: "No games provided." });

  const results = {};
  const playtimes = (key && steamId) ? await playtimeMap(key, steamId) : new Map();
  await Promise.all(
    items.map(async ({ appid, name, hasMeta, metaScore: knownMeta, genres: knownGenres }) => {
      const [ach, hltb, store] = await Promise.all([
        (key && steamId) ? steamAchievements(appid, key, steamId)
            : Promise.resolve({ achTotal: null, achUnlocked: null }),
        hltbTimes(appid, name),
        hasMeta ? Promise.resolve({ metaScore: knownMeta, genres: knownGenres || [] }) : storeMeta(appid),
      ]);
      // null = not owned; a number (possibly 0) = owned
      const playtimeMinutes = playtimes.has(appid) ? playtimes.get(appid) : null;
      results[appid] = { ...ach, ...hltb, playtimeMinutes, metaScore: store.metaScore, genres: store.genres };
    })
  );

  return res.status(200).json({ stats: results, at: Date.now() });
}
