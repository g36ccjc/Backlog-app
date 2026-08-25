// Shared storage helpers (Upstash Redis over REST).
// Records:
//   backlog:profile:{uid}  -> { username, steamId|null }
//   backlog:link:{steamId} -> uid  (legacy Steam links from the old account system)

const REST_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export function storageReady() { return Boolean(REST_URL && REST_TOKEN); }

export async function redis(command) {
  const r = await fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`Storage responded ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

