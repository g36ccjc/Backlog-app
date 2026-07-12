// POST /api/read-image   body: { image: "data:image/...;base64,...." }
// Sends the image to Claude, which returns a plain list of game titles it can
// read (from a Steam list screenshot, wishlist, shelf photo, etc.).
// The titles are then resolved to real Steam appids client-side via /api/search.
//
// Env var (set in Vercel):
//   ANTHROPIC_API_KEY   your Anthropic API key (https://console.anthropic.com)

const MODEL = "claude-sonnet-4-6";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Server missing ANTHROPIC_API_KEY. Add it in Vercel to use image reading.",
    });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const dataUrl = body?.image;
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return res.status(400).json({ error: "No image provided." });
  }

  // Split "data:image/png;base64,AAAA" into media type + base64 payload
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: "Unsupported image format." });
  const mediaType = match[1];
  const base64 = match[2];

  // Guard against oversized payloads (base64 is ~33% larger than the file)
  if (base64.length > 7_000_000) {
    return res.status(413).json({ error: "Image too large. Try a smaller screenshot." });
  }

  const prompt =
    "This image is a list of video games — likely a Steam library, wishlist, " +
    "or a photo of game cases. Read every game title you can identify. " +
    "Respond with ONLY a JSON array of strings, each string one game title, " +
    "in the order they appear. No commentary, no markdown, no code fences. " +
    'If you cannot read any titles, respond with []. Example: ["Hollow Knight","Hades"].';

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: `Vision request failed (${r.status}).`, detail });
    }

    const data = await r.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    // Parse the JSON array, tolerating stray code fences just in case
    let titles = [];
    try {
      const clean = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(clean);
      if (Array.isArray(parsed)) {
        titles = parsed.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
      }
    } catch {
      // Model didn't return clean JSON — return empty rather than guessing
      titles = [];
    }

    // De-duplicate case-insensitively, preserve order
    const seen = new Set();
    titles = titles.filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return res.status(200).json({ titles });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
