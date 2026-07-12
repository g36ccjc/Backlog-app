// GET /api/auth/login
// Redirects the browser to Steam's official "Sign in through Steam" page.
// Steam sends the user back to /api/auth/callback after they approve.

export default function handler(req, res) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = `${proto}://${host}`;
  const returnTo = `${base}/api/auth/callback`;

  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": base,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });

  res.statusCode = 302;
  res.setHeader("Location", `https://steamcommunity.com/openid/login?${params}`);
  res.end();
}
