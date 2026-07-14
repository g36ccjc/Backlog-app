// GET /api/friends
// Uses the logged-in user's Steam friends list to find friends who also use
// this app, and returns aggregate stats for each — never their actual lists.
// Requires the user's Steam friends list to be public.

import { getSession } from "./_session.js";

const STEAM_API = "https://api.steampowered.com";
const REST_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}
async function redis(command) {
  const r = await fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`Storage responded ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// Aggregate stats from a stored record without exposing the list contents
function aggregate(record) {
  const lists = Array.isArray(record.lists) ? record.lists
    : (Array.isArray(record.list) ? [{ games: record.list }] : []);
  const stats = record.stats || {};
  const seen = new Set();
  let games = 0, achU = 0, achT = 0, done = 0;
  for (const l of lists) for (const g of l.games || []) {
    if (seen.has(g.appid)) continue;
    seen.add(g.appid);
    games++;
    const s = stats[g.appid];
    if (s && s.achTotal > 0) {
      achU += s.achUnlocked || 0;
      achT += s.achTotal;
      if (s.achUnlocked === s.achTotal) done++;
    }
  }
  // XP: 10 per achievement + 250 per 100%'d game + flat trophy bonuses.
  // (Keep in sync with the same formulas in public/index.html.)
  const TROPHY_XP = [[1,100],[10,500],[25,1500],[50,4000],[100,10000],[250,30000],[1000,150000]];
  let bonus = 0;
  for (const [min, b] of TROPHY_XP) if (done >= min) bonus += b;
  const xp = achU * 10 + done * 250 + bonus;
  const level = Math.floor(Math.sqrt(xp / 100));
  return { games, done, achPct: achT ? Math.round((achU / achT) * 100) : null, level };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  const key = process.env.STEAM_API_KEY;
  if (!key) return res.status(500).json({ error: "Server missing STEAM_API_KEY." });
  if (!session.steamId) return res.status(400).json({ error: "Link your Steam account to find friends." });
  if (!REST_URL || !REST_TOKEN) return res.status(500).json({ error: "Storage not configured." });

  try {
    // 1. Steam friends list (requires their friends list to be public)
    let friendIds = [];
    try {
      const fl = await getJson(
        `${STEAM_API}/ISteamUser/GetFriendList/v1/?key=${key}&steamid=${session.steamId}&relationship=friend`
      );
      friendIds = (fl?.friendslist?.friends || []).map((f) => f.steamid).slice(0, 300);
    } catch {
      return res.status(200).json({
        friends: [],
        note: "Couldn't read your Steam friends list — it may be set to private.",
      });
    }
    if (!friendIds.length) return res.status(200).json({ friends: [] });

    // 2. Which of them have an account here?
    const checks = await Promise.all(
      friendIds.map(async (id) => {
        try {
          if ((await redis(["EXISTS", `backlog:user:${id}`])) === 1) return { id, dataKey: `backlog:user:${id}` };
          const linked = await redis(["GET", `backlog:link:${id}`]);
          if (linked) return { id, dataKey: `backlog:user:${linked}` };
          return null;
        } catch { return null; }
      })
    );
    const users = checks.filter(Boolean).slice(0, 50);
    if (!users.length) return res.status(200).json({ friends: [] });

    // 3. Names + avatars in one batch call
    const nameMap = new Map();
    try {
      const sum = await getJson(
        `${STEAM_API}/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${users.map(u=>u.id).join(",")}`
      );
      for (const p of sum?.response?.players || []) {
        nameMap.set(p.steamid, { name: p.personaname || null, avatar: p.avatarmedium || null });
      }
    } catch { /* cosmetic */ }

    // 4. Aggregate stats per friend (never their raw lists)
    const friends = [];
    await Promise.all(
      users.map(async ({ id, dataKey }) => {
        try {
          const raw = await redis(["GET", dataKey]);
          if (!raw) return;
          const agg = aggregate(JSON.parse(raw));
          const info = nameMap.get(id) || {};
          friends.push({ steamId: id, name: info.name, avatar: info.avatar, ...agg });
        } catch { /* skip unreadable */ }
      })
    );
    friends.sort((a, b) => (b.achPct ?? -1) - (a.achPct ?? -1));

    return res.status(200).json({ friends });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
