// GET /api/auth/callback[?link=1]
// Steam redirects here after login. We verify with Steam, then either:
//   - normal sign-in: session for the Steam account (or the local account
//     this SteamID is linked to), or
//   - link mode (?link=1): attach this SteamID to the already-signed-in
//     local account, unless the SteamID is already in use.

import { createSession, getSession } from "../_session.js";
import { redis, storageReady } from "../_accounts.js";

export default async function handler(req, res) {
  const go = (path) => { res.statusCode = 302; res.setHeader("Location", path); res.end(); };
  try {
    const q = req.query || {};
    if (q["openid.mode"] !== "id_res") return go("/?login=cancelled");

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (k.startsWith("openid.")) params.set(k, Array.isArray(v) ? v[0] : v);
    }
    params.set("openid.mode", "check_authentication");
    const verify = await fetch("https://steamcommunity.com/openid/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!/is_valid\s*:\s*true/.test(await verify.text())) return go("/?login=failed");

    const m = String(q["openid.claimed_id"] || "").match(/\/openid\/id\/(\d{17})$/);
    if (!m) return go("/?login=failed");
    const steamId = m[1];

    if (q.link === "1") {
      // Attach to the signed-in local account
      const session = getSession(req);
      if (!session || !session.uid.startsWith("u_")) return go("/?link=failed");
      if (!storageReady()) return go("/?link=failed");
      // refuse if this Steam identity already has its own account or link
      const [ownData, linked] = await Promise.all([
        redis(["EXISTS", `backlog:user:${steamId}`]),
        redis(["GET", `backlog:link:${steamId}`]),
      ]);
      if (ownData === 1 || (linked && linked !== session.uid)) return go("/?link=conflict");
      await redis(["SET", `backlog:link:${steamId}`, session.uid]);
      try {
        const prof = JSON.parse(await redis(["GET", `backlog:profile:${session.uid}`]) || "{}");
        prof.steamId = steamId;
        await redis(["SET", `backlog:profile:${session.uid}`, JSON.stringify(prof)]);
      } catch {}
      createSession(res, session.uid, steamId);
      return go("/?link=ok");
    }

    // Normal sign-in: route to the linked local account if one exists
    let uid = steamId;
    if (storageReady()) {
      try {
        const linked = await redis(["GET", `backlog:link:${steamId}`]);
        if (linked) uid = linked;
      } catch {}
    }
    createSession(res, uid, steamId);
    return go("/");
  } catch {
    return go("/?login=error");
  }
}
