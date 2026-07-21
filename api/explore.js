// Explore feeds, all from Steam's free public endpoints (no API key):
//   /api/explore            -> { newReleases, upcoming, topSellers }
//   /api/explore?feed=new|upcoming|top  -> a single refreshed feed
//
// Steam's store "featuredcategories" endpoint returns new releases, coming
// soon, and top sellers in one call. Results are cached briefly in Redis so
// the tab is instant and we stay well within rate limits. Prices are pulled
// in AUD to match the rest of the app.

import { getSession } from "./_session.js";
import { redis, storageReady } from "./_accounts.js";

const CACHE_KEY = "backlog:explore:v1";
const CACHE_TTL = 30 * 60; // seconds — feeds move slowly; 30 min is plenty

function mapItem(it) {
  if (!it || !it.id) return null;
  const cents = typeof it.final_price === "number" ? it.final_price : null;
  const orig = typeof it.original_price === "number" ? it.original_price : null;
  return {
    appid: it.id,
    name: String(it.name || "").slice(0, 200),
    discount: it.discount_percent || 0,
    genres: [],
    // Steam-provided art URLs — reliable, unlike constructed CDN paths
    img: it.large_capsule_image || it.header_image || it.small_capsule_image || null,
    price: it.is_free
      ? { free: true }
      : cents != null
      ? {
          final: cents,
          discount: it.discount_percent || 0,
          str: (it.currency || "AUD") + " " + (cents / 100).toFixed(2),
          orig: orig != null ? orig / 100 : null,
        }
      : null,
    // coming-soon items carry a release string instead of a price
    release: it.discounted === false && it.released === false ? null : undefined,
  };
}

function dedupeCap(list, n) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const m = mapItem(raw);
    if (!m || seen.has(m.appid)) continue;
    seen.add(m.appid);
    out.push(m);
    if (out.length >= n) break;
  }
  return out;
}

async function fetchFeeds() {
  const r = await fetch(
    "https://store.steampowered.com/api/featuredcategories?cc=au&l=english",
    { headers: { "Accept": "application/json" } }
  );
  if (!r.ok) throw new Error("Steam store responded " + r.status);
  const d = await r.json();
  return {
    newReleases: dedupeCap(d?.new_releases?.items, 24),
    upcoming: dedupeCap(d?.coming_soon?.items, 24),
    topSellers: dedupeCap(d?.top_sellers?.items, 24),
    at: Date.now(),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });

  try {
    let feeds = null;
    if (storageReady()) {
      try {
        const raw = await redis(["GET", CACHE_KEY]);
        if (raw) feeds = JSON.parse(raw);
      } catch {}
    }
    if (!feeds || Date.now() - (feeds.at || 0) > CACHE_TTL * 1000) {
      feeds = await fetchFeeds();
      if (storageReady()) {
        try { await redis(["SET", CACHE_KEY, JSON.stringify(feeds), "EX", String(CACHE_TTL)]); } catch {}
      }
    }

    // Category browse: Steam's store search returns games for a genre term,
    // sorted by popularity. Cached per-category so chips are snappy.
    const cat = req.query?.cat;
    if (cat) {
      const key = `${CACHE_KEY}:cat:${cat.toLowerCase()}`;
      let items = null;
      if (storageReady()) {
        try { const raw = await redis(["GET", key]); if (raw) items = JSON.parse(raw); } catch {}
      }
      if (!items) {
        try {
          const r = await fetch(
            `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(cat)}&cc=au&l=english`,
            { headers: { "Accept": "application/json" } }
          );
          const d = r.ok ? await r.json() : null;
          items = (d?.items || []).slice(0, 24).map((it) => ({
            appid: it.id,
            name: String(it.name || "").slice(0, 200),
            discount: 0,
            price: it.price
              ? { final: it.price.final, discount: 0, str: "AUD " + (it.price.final / 100).toFixed(2), orig: null }
              : it.price === undefined ? null : { free: true },
            genres: [cat],
            img: it.tiny_image || it.large_capsule_image || null,
          })).filter((x) => x.appid);
          if (storageReady() && items.length) {
            try { await redis(["SET", key, JSON.stringify(items), "EX", String(CACHE_TTL)]); } catch {}
          }
        } catch { items = []; }
      }
      return res.status(200).json({ items });
    }

    const one = req.query?.feed;
    if (one === "new") return res.status(200).json({ items: feeds.newReleases });
    if (one === "upcoming") return res.status(200).json({ items: feeds.upcoming });
    if (one === "top") return res.status(200).json({ items: feeds.topSellers });

    return res.status(200).json({
      newReleases: feeds.newReleases,
      upcoming: feeds.upcoming,
      topSellers: feeds.topSellers,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
