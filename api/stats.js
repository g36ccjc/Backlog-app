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
      let lastUnlock = 0;
      let unlocked = 0;
      for (const a of list) {
        if (a.achieved === 1) {
          unlocked++;
          if (a.unlocktime > lastUnlock) lastUnlock = a.unlocktime;
        }
      }
      return {
        achTotal: list.length,
        achUnlocked: unlocked,
        lastUnlock: lastUnlock || null, // newest unlock = last-played signal
      };
    }
    return { achTotal: 0, achUnlocked: 0, lastUnlock: null };
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

// Metacritic score, fetched from metacritic.com directly (Steam's stored
// scores are stale for many games). Slug is derived from the game name;
// misses fall back to Steam's stored score below.
function mcSlug(name) {
  return name
    .replace(/[\u2122\u00ae\u00a9]/g, "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
async function mcScore(name) {
  if (!name) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(`https://www.metacritic.com/game/${mcSlug(name)}/`, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const html = await r.text();
    // structured data first, then a scoped regex fallback
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (ld) {
      try {
        const j = JSON.parse(ld[1]);
        const v = parseInt(j?.aggregateRating?.ratingValue, 10);
        if (v >= 0 && v <= 100) return v;
      } catch { /* fall through */ }
    }
    const m = html.match(/"ratingValue":\s*"?(\d{1,3})"?/);
    if (m) { const v = +m[1]; if (v >= 0 && v <= 100) return v; }
    return null;
  } catch {
    return null;
  }
}

// Genres (and fallback score) via Steam's store data.
async function storeMeta(appid, name) {
  const steamP = (async () => {
    try {
      const d = await getJson(
        `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=metacritic,genres&l=english`
      );
      const entry = d?.[appid];
      if (!entry?.success) return { score: null, genres: [] };
      const sc = entry?.data?.metacritic?.score;
      return {
        score: typeof sc === "number" ? sc : null,
        genres: (entry?.data?.genres || []).map((g) => g.description).slice(0, 6),
      };
    } catch {
      return { score: null, genres: [] };
    }
  })();
  const [mc, steam] = await Promise.all([mcScore(name), steamP]);
  return { metaScore: mc ?? steam.score, genres: steam.genres };
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

// Resolve times straight from HowLongToBeat's own game page. HLTB is a
// Next.js site: each game page embeds its stats as JSON (comp_main /
// comp_100, in seconds). This is the same source community scrapers use,
// and far more reliable than undocumented middleman routes.
async function hltbPage(hltbId) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(`https://howlongtobeat.com/game/${hltbId}`, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Referer": "https://howlongtobeat.com/",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const html = await r.text();

    // Preferred: structured __NEXT_DATA__ parse
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      try {
        const nd = JSON.parse(m[1]);
        const g = nd?.props?.pageProps?.game?.data?.game?.[0];
        if (g) {
          const t = secsToTimes(g.comp_main, g.comp_100);
          if (hasTimes(t)) return t;
        }
      } catch { /* fall through to regex */ }
    }
    // Fallback: first comp_main / comp_100 values anywhere in the embedded JSON
    const mm = html.match(/"comp_main":(\d+)/);
    const mc = html.match(/"comp_100":(\d+)/);
    if (mm || mc) {
      const t = secsToTimes(mm ? +mm[1] : 0, mc ? +mc[1] : 0);
      if (hasTimes(t)) return t;
    }
    return null;
  } catch {
    return null;
  }
}
function secsToTimes(mainSecs, compSecs) {
  const h = (s) => (typeof s === "number" && s > 0 ? Math.round(s / 360) / 10 : null);
  return { mainStory: h(mainSecs), completionist: h(compSecs) };
}

// ---- HLTB name-search fallback ---------------------------------------
// The appid-mapping service doesn't know a sizeable share of games. For
// those we search HowLongToBeat directly. Their search API requires a
// rotating key embedded in their JS bundle; we extract it once and cache
// it for the lifetime of the (warm) function instance.
const HLTB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
let hltbTok = { v: null, at: 0 };

async function hltbToken() {
  if (hltbTok.v && Date.now() - hltbTok.at < 60 * 60 * 1000) return hltbTok.v;
  try {
    const home = await fetch("https://howlongtobeat.com/", {
      headers: { "User-Agent": HLTB_UA, "Accept": "text/html" },
    });
    if (!home.ok) return null;
    const html = await home.text();
    // the key lives in the _app chunk; check that first, then a few others
    const chunks = [...html.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((m) => m[1]);
    chunks.sort((a, b) => (b.includes("_app") ? 1 : 0) - (a.includes("_app") ? 1 : 0));
    for (const src of chunks.slice(0, 5)) {
      try {
        const r = await fetch("https://howlongtobeat.com" + src, { headers: { "User-Agent": HLTB_UA } });
        if (!r.ok) continue;
        const js = await r.text();
        const pathM = js.match(/\/api\/(search|seek|find)\//);
        if (!pathM) continue;
        const keyM = js.match(
          /\/api\/(?:search|seek|find)\/"\.concat\("([^"]+)"\)(?:\.concat\("([^"]+)"\))?/
        );
        if (keyM) {
          hltbTok = { v: { path: pathM[1], key: (keyM[1] || "") + (keyM[2] || "") }, at: Date.now() };
          return hltbTok.v;
        }
      } catch { /* try next chunk */ }
    }
  } catch { /* fall through */ }
  return null;
}

async function hltbSearch(name) {
  const tok = await hltbToken();
  if (!tok) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(`https://howlongtobeat.com/api/${tok.path}/${tok.key}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": HLTB_UA,
        "Referer": "https://howlongtobeat.com/",
        "Origin": "https://howlongtobeat.com",
      },
      body: JSON.stringify({
        searchType: "games",
        searchTerms: String(name).replace(/[\u2122\u00ae\u00a9]/g, "").split(/\s+/).filter(Boolean),
        searchPage: 1,
        size: 5,
        searchOptions: {
          games: {
            userId: 0, platform: "", sortCategory: "popular", rangeCategory: "main",
            rangeTime: { min: null, max: null },
            gameplay: { perspective: "", flow: "", genre: "", difficulty: "" },
            rangeYear: { min: "", max: "" }, modifier: "",
          },
          users: { sortCategory: "postcount" },
          lists: { sortCategory: "follows" },
          filter: "", sort: 0, randomizer: 0,
        },
        useCache: true,
      }),
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    const list = Array.isArray(d?.data) ? d.data : [];
    if (!list.length) return null;
    const best = list
      .map((e) => ({ e, s: similarity(name, e.game_name || "") }))
      .sort((a, b) => b.s - a.s)[0];
    if (!best || best.s < 0.4) return null;
    const t = secsToTimes(best.e.comp_main, best.e.comp_100);
    if (hasTimes(t)) return t;
    if (best.e.game_id != null) return await hltbPage(best.e.game_id);
    return null;
  } catch {
    return null;
  }
}

async function hltbTimes(appid, name) {
  try {
    const d = await getJson(`${HLTB_BASE}/${appid}`);
    // Populated single entry (object, or one-element array per the docs)
    const single = Array.isArray(d) ? (d.length === 1 ? d[0] : null) : d;
    if (single) {
      const t = readTimes(single);
      if (hasTimes(t)) return t;
      // stored entry but zeroed times: try the source page directly
      if (single.hltbId != null) {
        const t2 = await hltbPage(single.hltbId);
        if (t2) return t2;
      }
    }
    // Multiple candidates: bare search results without times. Rank by name
    // similarity, then read the best matches straight from HLTB's pages.
    if (Array.isArray(d) && d.length > 1 && name) {
      const scored = d
        .map((e) => ({ e, s: similarity(name, e.title || e.name || "") }))
        .sort((x, y) => y.s - x.s)
        .filter(({ s }) => s >= 0.4)
        .slice(0, 2); // at most two page fetches per game
      for (const { e } of scored) {
        const direct = readTimes(e);
        if (hasTimes(direct)) return direct;
        if (e.hltbId != null) {
          const t = await hltbPage(e.hltbId);
          if (t) return t;
        }
      }
    }
    // Last resort: the mapping service doesn't know this game at all —
    // search HowLongToBeat by name directly.
    if (name) {
      const t = await hltbSearch(name);
      if (t) return t;
    }
    return { mainStory: null, completionist: null };
  } catch {
    if (name) {
      try { const t = await hltbSearch(name); if (t) return t; } catch { /* give up */ }
    }
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
        hasMeta: ("metaScore" in it) && ("genres" in it) && it.metaV === 2,
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
  // achOnly: skip HLTB and Metacritic entirely — used by bulk scans so a
  // chunk of 50 games finishes well inside the serverless time limit.
  const achOnly = body?.achOnly === true;

  const results = {};
  const playtimes = (key && steamId) ? await playtimeMap(key, steamId) : new Map();
  await Promise.all(
    items.map(async ({ appid, name, hasMeta, metaScore: knownMeta, genres: knownGenres }) => {
      const [ach, hltb, store] = await Promise.all([
        (key && steamId) ? steamAchievements(appid, key, steamId)
            : Promise.resolve({ achTotal: null, achUnlocked: null }),
        achOnly ? Promise.resolve(null) : hltbTimes(appid, name),
        achOnly ? Promise.resolve(null)
                : (hasMeta ? Promise.resolve({ metaScore: knownMeta, genres: knownGenres || [] }) : storeMeta(appid, name)),
      ]);
      // null = not owned; a number (possibly 0) = owned
      const playtimeMinutes = playtimes.has(appid) ? playtimes.get(appid) : null;
      results[appid] = achOnly
        ? { ...ach, playtimeMinutes }
        : { ...ach, ...hltb, playtimeMinutes, metaScore: store.metaScore, genres: store.genres, metaV: 2 };
    })
  );

  return res.status(200).json({ stats: results, at: Date.now() });
}
