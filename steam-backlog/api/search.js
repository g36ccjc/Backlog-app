// GET /api/search?q=hollow+knight
// Searches the Steam store storefront for games matching a name.
// Returns lightweight results (appid, name, icon) to add to the backlog.
// No API key needed — this is the public storefront suggest endpoint.

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3600");
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing search term." });

  try {
    // Steam's storefront search-suggest returns JSON with app entries.
    const url =
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}` +
      `&l=english&cc=us`;
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error(`Store responded ${r.status}`);
    const data = await r.json();

    const items = (data.items || [])
      .filter((it) => it.type === "app" || it.type === "game" || it.id)
      .map((it) => ({
        appid: it.id,
        name: it.name,
        icon: it.tiny_image || null,
      }))
      .slice(0, 12);

    return res.status(200).json({ results: items });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
