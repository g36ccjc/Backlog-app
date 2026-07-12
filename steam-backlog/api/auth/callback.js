// GET /api/auth/callback
// Steam redirects here after login. We verify the response is genuine by
// posting it back to Steam (check_authentication), extract the SteamID,
// set the session cookie, and send the user to the app.

import { createSession } from "../_session.js";

export default async function handler(req, res) {
  try {
    const q = req.query || {};

    if (q["openid.mode"] !== "id_res") {
      res.statusCode = 302;
      res.setHeader("Location", "/?login=cancelled");
      return res.end();
    }

    // Re-post the exact params back to Steam with mode=check_authentication.
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
    const text = await verify.text();
    if (!/is_valid\s*:\s*true/.test(text)) {
      res.statusCode = 302;
      res.setHeader("Location", "/?login=failed");
      return res.end();
    }

    // claimed_id looks like https://steamcommunity.com/openid/id/7656119...
    const claimed = q["openid.claimed_id"] || "";
    const m = String(claimed).match(/\/openid\/id\/(\d{17})$/);
    if (!m) {
      res.statusCode = 302;
      res.setHeader("Location", "/?login=failed");
      return res.end();
    }

    createSession(res, m[1]);
    res.statusCode = 302;
    res.setHeader("Location", "/");
    res.end();
  } catch {
    res.statusCode = 302;
    res.setHeader("Location", "/?login=error");
    res.end();
  }
}
