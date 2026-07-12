// POST /api/auth/logout — clears the session cookie.

import { clearSession } from "../_session.js";

export default function handler(req, res) {
  clearSession(res);
  res.status(200).json({ ok: true });
}
