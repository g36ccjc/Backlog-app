// GET /api/details?appid=123
// Returns store details for a game: description, genres, release date,
// developers, header image. Data comes from Steam's public store API.

import { getSession } from "./_session.js";

export default async function handler(req, res) {
  // Descriptions are public, static data — allow CDN caching for a day.
  res.setHeader("Cache-Control", "s-maxage=86400");

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });

  const appid = parseInt(req.query?.appid, 10);
  if (!Number.isFinite(appid)) return res.status(400).json({ error: "Missing appid." });

  try {
    const r = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`
    );
    if (!r.ok) throw new Error(`Store responded ${r.status}`);
    const d = await r.json();
    const entry = d?.[appid];
    if (!entry?.success || !entry.data) {
      return res.status(200).json({ details: null, note: "No store page found for this game." });
    }
    const g = entry.data;
    return res.status(200).json({
      details: {
        description: g.short_description || "",
        headerImage: g.header_image || null,
        genres: (g.genres || []).map((x) => x.description).slice(0, 5),
        releaseDate: g.release_date?.date || null,
        developers: (g.developers || []).slice(0, 3),
      },
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
