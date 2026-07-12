// POST /api/share            (logged in)  -> creates a snapshot, returns { id }
// GET  /api/share?id=XXXXXXX (public)     -> returns the snapshot (read-only)
//
// Snapshots are stored under their own key with a 90-day expiry, so a shared
// link is a frozen copy — later edits to the list don't change it, and links
// naturally expire.

import crypto from "crypto";
import { getSession } from "./_session.js";

const REST_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const TTL_SECONDS = 90 * 24 * 60 * 60;

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

  if (!REST_URL || !REST_TOKEN) {
    return res.status(500).json({ error: "Storage not configured." });
  }

  try {
    if (req.method === "GET") {
      const id = String(req.query?.id || "");
      if (!/^[a-zA-Z0-9_-]{6,24}$/.test(id)) {
        return res.status(400).json({ error: "Invalid share id." });
      }
      const raw = await redis(["GET", `backlog:share:${id}`]);
      if (!raw) return res.status(404).json({ error: "This shared list doesn't exist or has expired." });
      return res.status(200).json(JSON.parse(raw));
    }

    if (req.method === "POST") {
      const session = getSession(req);
      if (!session) return res.status(401).json({ error: "Not logged in." });

      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      const list = Array.isArray(body?.list) ? body.list.slice(0, 2000) : [];
      const stats = body?.stats && typeof body.stats === "object" ? body.stats : {};
      const ownerName = typeof body?.ownerName === "string" ? body.ownerName.slice(0, 60) : null;
      if (!list.length) return res.status(400).json({ error: "Nothing to share yet." });

      const id = crypto.randomBytes(6).toString("base64url"); // 8 chars
      const snapshot = { list, stats, ownerName, createdAt: Date.now() };
      await redis(["SET", `backlog:share:${id}`, JSON.stringify(snapshot), "EX", String(TTL_SECONDS)]);
      return res.status(200).json({ id });
    }

    return res.status(405).json({ error: "Use GET or POST." });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
