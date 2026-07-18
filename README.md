# Backlog — a multi-user game backlog with Steam login

A phone-friendly website where anyone signs in with their Steam account and
gets their own backlog, synced across all their devices. Each game shows:

- **Achievement progress** (unlocked / total) — from their Steam account
- **Main story hours** and **Completionist (100%) hours** — from HowLongToBeat

Sort by name, achievement progress, or either time stat. Add games by searching
the Steam store, pasting a list of names, or one-tap importing your owned
library. Share the site URL with friends — they sign in with Steam and get
their own separate list. No passwords: login uses Steam's official OpenID flow.

---

## One-time setup (site owner)

You need, all free:

1. **Steam Web API key** — https://steamcommunity.com/dev/apikey
2. **A session secret** — any long random string you invent (30+ characters).
3. **Vercel** account + **GitHub** account.

### Deploy

1. **GitHub**: create a repo, upload every file keeping the structure
   (`api/` with its `auth/` subfolder, `public/`, `vercel.json`, `package.json`).
2. **Vercel**: Add New → Project → Import the repo. Framework preset: Other.
3. **Environment variables** (Settings → Environment Variables):
   | Name | Value |
   |------|-------|
   | `STEAM_API_KEY` | your Steam key |
   | `SESSION_SECRET` | your long random string |
4. **Storage** (required — this is where user lists live): in the project's
   **Storage** tab, create **Upstash Redis** (free plan), then **Connect
   Project**. Credentials are injected automatically.
5. **Deploy** (or Redeploy if you added vars after the first deploy).

Note: `STEAM_ID` is no longer needed — each user's SteamID comes from their login.

### Share it
Send friends the `.vercel.app` URL. They tap **Sign in through Steam**, approve
on Steam's own page, and get their own empty backlog. For achievements to show,
their Steam profile's **Game details** must be Public
(Steam → Edit Profile → Privacy Settings).

---

## Using it

- **Sign in through Steam** — official Steam login; the site never sees passwords.
- **Add games** — search the Steam store (Search tab) or paste a list of names,
  one per line (Paste list tab), review the matches, add them all at once.
- **Import library** — pulls your owned Steam games; tap Add on any.
- **Filter box** — type to filter your list instantly.
- **Sort chips** — A–Z, Achievements, Main story, 100% time; tap again to flip.
- **Hero bar** — always shows how many games and main-story hours you have left,
  with an overall achievement progress bar. Tap it to refresh all stats.
- **Profile** — tap your avatar: stats (games, achievements, completion %,
  hours left, hours to 100% everything), plus Share and Log out.
- **Share** — creates a public read-only snapshot of your list at a unique URL
  you can send to anyone (no login needed to view). Links expire after 90 days
  and don't update when your list changes — share again for a fresh one.
- Lists sync automatically across devices — sign in anywhere, same backlog.

---

## Notes

- **HowLongToBeat times** come from a community service mapping Steam appids to
  HLTB hours; if it's unavailable, cards show “—” for hours.
- **Image reading is disabled** in this multi-user version (it ran on the
  owner's paid Anthropic key). The paste-list feature covers bulk adding.
- Sync is last-write-wins per user; fine for personal lists.
- Each user's data is stored under their SteamID in your Upstash database.
