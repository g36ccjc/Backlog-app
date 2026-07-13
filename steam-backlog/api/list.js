// GET  /api/list  -> the logged-in user's backlog { list, stats, updatedAt }
// POST /api/list  -> saves the logged-in user's backlog
// Requires login; each user's data is stored under their own SteamID.

import { getSession } from "./_session.js";

const REST_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command) {
  const r = await fetch(REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`Storage responded ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });

  if (!REST_URL || !REST_TOKEN) {
    return res.status(500).json({
      error: "Sync storage not configured. Install Upstash Redis from the Vercel Marketplace.",
    });
  }

  const KEY = `backlog:user:${session.uid}`;

  try {
    if (req.method === "GET") {
      const raw = await redis(["GET", KEY]);
      if (!raw) return res.status(200).json({ lists: null, list: [], stats: {}, updatedAt: 0 });
      const parsed = JSON.parse(raw);
      // Serve both shapes: `lists` (new) and a flattened `list` (legacy).
      const lists = Array.isArray(parsed.lists)
        ? parsed.lists
        : (Array.isArray(parsed.list)
            ? [{ id: "main", name: "Backlog", games: parsed.list }]
            : [{ id: "main", name: "Backlog", games: [] }]);
      const flat = lists.flatMap((l) => l.games);
      return res.status(200).json({
        lists,
        list: flat,
        stats: parsed.stats || {},
        history: parsed.history || [],
        notes: parsed.notes || {},
        showcase: parsed.showcase || [],
        updatedAt: parsed.updatedAt || 0,
      });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

      // New shape: { lists: [{id, name, games:[...]}], stats }
      // Legacy shape: { list: [...], stats } — wrapped into a single "main" list.
      let lists = null;
      if (Array.isArray(body?.lists)) {
        let totalGames = 0;
        lists = body.lists
          .filter((l) => l && typeof l === "object" && Array.isArray(l.games))
          .slice(0, 20)
          .map((l) => {
            const games = l.games.slice(0, Math.max(0, 2000 - totalGames));
            totalGames += games.length;
            return {
              id: String(l.id || "main").slice(0, 24),
              name: String(l.name || "Backlog").slice(0, 40),
              games,
            };
          });
      } else if (Array.isArray(body?.list)) {
        lists = [{ id: "main", name: "Backlog", games: body.list.slice(0, 2000) }];
      }
      if (!lists || !lists.length) lists = [{ id: "main", name: "Backlog", games: [] }];

      const stats = body?.stats && typeof body.stats === "object" ? body.stats : {};
      const history = Array.isArray(body?.history) ? body.history.slice(-400) : [];
      const notes = body?.notes && typeof body.notes === "object" ? body.notes : {};
      const showcase = Array.isArray(body?.showcase) ? body.showcase.slice(0, 10) : [];
      const record = { lists, stats, history, notes, showcase, updatedAt: Date.now() };
      const serialized = JSON.stringify(record);
      if (serialized.length > 2_000_000) {
        return res.status(413).json({ error: "List data too large." });
      }
      await redis(["SET", KEY, serialized]);
      return res.status(200).json({ ok: true, updatedAt: record.updatedAt });
    }

    return res.status(405).json({ error: "Use GET or POST." });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
