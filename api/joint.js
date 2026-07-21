// Joint lists: a list shared between two Backlog users who are Steam friends.
//   GET  /api/joint            -> my joint lists (full contents)
//   POST /api/joint?a=create   -> { friendId, name }        creates + adds both members
//   POST /api/joint?a=save     -> { id, games, name? }      last-write-wins save (members only)
//   POST /api/joint?a=leave    -> { id }                    leave; last member out deletes it
//
// Storage:
//   backlog:joint:{id}  -> { id, name, members:[uid,uid], games:[], updatedAt }
//   backlog:jmem:{uid}  -> SET of joint ids the user belongs to

import crypto from "crypto";
import { getSession } from "./_session.js";
import { redis, storageReady } from "./_accounts.js";

async function resolveUid(friendId) {
  const id = String(friendId || "");
  if (/^\d{17}$/.test(id)) {
    if ((await redis(["EXISTS", `backlog:user:${id}`])) === 1) return id;
    const linked = await redis(["GET", `backlog:link:${id}`]);
    if (linked) return linked;
    return null;
  }
  if (/^u_[A-Za-z0-9_-]{6,40}$/.test(id)) {
    if ((await redis(["EXISTS", `backlog:user:${id}`])) === 1) return id;
  }
  return null;
}

function sanitizeGames(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const g of arr.slice(0, 2000)) {
    const appid = +g?.appid;
    if (!Number.isFinite(appid) || seen.has(appid)) continue;
    seen.add(appid);
    out.push({
      appid,
      name: String(g?.name || "").slice(0, 200),
      icon: typeof g?.icon === "string" ? g.icon.slice(0, 300) : null,
    });
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  if (!storageReady()) return res.status(500).json({ error: "Storage not configured." });
  const uid = session.uid;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = req.query?.a || null;

  try {
    if (req.method === "GET") {
      const ids = (await redis(["SMEMBERS", `backlog:jmem:${uid}`])) || [];
      const lists = [];
      for (const id of ids.slice(0, 20)) {
        const raw = await redis(["GET", `backlog:joint:${id}`]);
        if (!raw) { await redis(["SREM", `backlog:jmem:${uid}`, id]); continue; }
        const rec = JSON.parse(raw);
        if (!Array.isArray(rec.members) || !rec.members.includes(uid)) continue;
        lists.push(rec);
      }
      const invIds = (await redis(["SMEMBERS", `backlog:jinv:${uid}`])) || [];
      const invites = [];
      for (const id of invIds.slice(0, 10)) {
        const raw = await redis(["GET", `backlog:joint:${id}`]);
        if (!raw) { await redis(["SREM", `backlog:jinv:${uid}`, id]); continue; }
        const rec = JSON.parse(raw);
        if (rec.pending !== uid) { await redis(["SREM", `backlog:jinv:${uid}`, id]); continue; }
        let fromName = null;
        const creator = (rec.members || []).find((m) => m !== uid);
        const key = process.env.STEAM_API_KEY;
        if (key && /^\d{17}$/.test(creator || "")) {
          try {
            const r = await fetch(
              `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${creator}`
            );
            const d = await r.json();
            fromName = d?.response?.players?.[0]?.personaname || null;
          } catch {}
        }
        invites.push({ id: rec.id, name: rec.name, fromName });
      }
      return res.status(200).json({ lists, invites });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Use GET or POST." });

    if (action === "create") {
      const fuid = await resolveUid(body?.friendId);
      if (!fuid) return res.status(404).json({ error: "That friend isn't on Backlog." });
      if (fuid === uid) return res.status(400).json({ error: "That's you." });
      const myCount = ((await redis(["SMEMBERS", `backlog:jmem:${uid}`])) || []).length;
      if (myCount >= 10) return res.status(400).json({ error: "Joint list limit reached (10)." });
      const id = "j_" + crypto.randomBytes(5).toString("base64url");
      const rec = {
        id,
        name: Array.from(String(body?.name || "Joint list").trim()).slice(0, 40).join("") || "Joint list",
        members: [uid, fuid],
        pending: fuid, // invitee must accept before the list reaches them
        updatedAt: Date.now(),
        games: [],
      };
      await redis(["SET", `backlog:joint:${id}`, JSON.stringify(rec)]);
      await redis(["SADD", `backlog:jmem:${uid}`, id]);
      await redis(["SADD", `backlog:jinv:${fuid}`, id]);
      return res.status(200).json({ list: rec });
    }

    if (action === "save") {
      const id = String(body?.id || "");
      if (!/^j_[A-Za-z0-9_-]{4,16}$/.test(id)) return res.status(400).json({ error: "Bad id." });
      const raw = await redis(["GET", `backlog:joint:${id}`]);
      if (!raw) return res.status(404).json({ error: "List no longer exists." });
      const rec = JSON.parse(raw);
      if (!rec.members?.includes(uid)) return res.status(403).json({ error: "Not your list." });
      if (rec.pending === uid) return res.status(403).json({ error: "Accept the invite first." });
      rec.games = sanitizeGames(body?.games);
      if (typeof body?.name === "string" && body.name.trim()) rec.name = Array.from(body.name.trim()).slice(0, 40).join("");
      rec.updatedAt = Date.now();
      const serialized = JSON.stringify(rec);
      if (serialized.length > 1_000_000) return res.status(413).json({ error: "List too large." });
      await redis(["SET", `backlog:joint:${id}`, serialized]);
      return res.status(200).json({ ok: true, updatedAt: rec.updatedAt });
    }

    if (action === "accept") {
      const id = String(body?.id || "");
      const raw = await redis(["GET", `backlog:joint:${id}`]);
      if (!raw) return res.status(404).json({ error: "That invite has expired." });
      const rec = JSON.parse(raw);
      if (rec.pending !== uid) return res.status(403).json({ error: "Not your invite." });
      delete rec.pending;
      rec.updatedAt = Date.now();
      await redis(["SET", `backlog:joint:${id}`, JSON.stringify(rec)]);
      await redis(["SREM", `backlog:jinv:${uid}`, id]);
      await redis(["SADD", `backlog:jmem:${uid}`, id]);
      return res.status(200).json({ list: rec });
    }

    if (action === "decline") {
      const id = String(body?.id || "");
      await redis(["SREM", `backlog:jinv:${uid}`, id]);
      const raw = await redis(["GET", `backlog:joint:${id}`]);
      if (raw) {
        const rec = JSON.parse(raw);
        if (rec.pending === uid) {
          // cancelling the request removes the list for the creator too
          for (const m of rec.members || []) await redis(["SREM", `backlog:jmem:${m}`, id]);
          await redis(["DEL", `backlog:joint:${id}`]);
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (action === "leave") {
      const id = String(body?.id || "");
      const raw = await redis(["GET", `backlog:joint:${id}`]);
      await redis(["SREM", `backlog:jmem:${uid}`, id]);
      if (raw) {
        const rec = JSON.parse(raw);
        if (rec.pending) { await redis(["SREM", `backlog:jinv:${rec.pending}`, id]); }
        rec.members = (rec.members || []).filter((m) => m !== uid);
        if (!rec.members.length || rec.pending) {
          for (const m of rec.members) await redis(["SREM", `backlog:jmem:${m}`, id]);
          await redis(["DEL", `backlog:joint:${id}`]);
        }
        else await redis(["SET", `backlog:joint:${id}`, JSON.stringify(rec)]);
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
