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

  const KEY = `backlog:user:${session.steamId}`;

  try {
    if (req.method === "GET") {
      let raw = await redis(["GET", KEY]);

      // One-time migration: the original single-user version stored the list
      // under "backlog:shared". If this account has no list yet but that old
      // record exists, adopt it into this account and remove the old record.
      // (First empty account to log in claims it — in practice, the owner.)
      if (!raw) {
        const legacy = await redis(["GET", "backlog:shared"]);
        if (legacy) {
          await redis(["SET", KEY, legacy]);
          await redis(["DEL", "backlog:shared"]);
          raw = legacy;
        }
      }

      if (!raw) return res.status(200).json({ list: [], stats: {}, updatedAt: 0 });
      const parsed = JSON.parse(raw);
      return res.status(200).json({
        list: parsed.list || [],
        stats: parsed.stats || {},
        updatedAt: parsed.updatedAt || 0,
      });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      const list = Array.isArray(body?.list) ? body.list.slice(0, 2000) : [];
      const stats = body?.stats && typeof body.stats === "object" ? body.stats : {};
      const record = { list, stats, updatedAt: Date.now() };
      await redis(["SET", KEY, JSON.stringify(record)]);
      return res.status(200).json({ ok: true, updatedAt: record.updatedAt });
    }

    return res.status(405).json({ error: "Use GET or POST." });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
