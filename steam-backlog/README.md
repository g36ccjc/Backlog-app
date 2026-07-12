# Backlog — a manual game backlog with Steam achievements + HowLongToBeat times

A phone-friendly website where you build a backlog by hand and each game shows:

- **Achievement progress** (unlocked / total) — from Steam, for games you own
- **Main story hours** — from HowLongToBeat
- **Completionist (100%) hours** — from HowLongToBeat

Sort the list on the fly by name, achievement progress, main-story length, or
completionist length. Add games two ways: search the Steam store for any game,
or one-tap import from your own owned library. Your list lives on your device.

---

## What you need (all free)

1. **Steam Web API key** — https://steamcommunity.com/dev/apikey
2. **Your steamID64** — paste your profile URL into https://steamid.io
3. **Public privacy** — Steam → Edit Profile → Privacy → set **My profile** and
   **Game details** to **Public** (needed for achievements + library import)
4. **Anthropic API key** — https://console.anthropic.com (only needed for the
   "read games from an image" feature; the rest of the app works without it)
5. A **Vercel** account (hosting) and a **GitHub** account (easiest deploy)

Only the achievement and library-import features need the key + public profile.
Store search and HowLongToBeat times work regardless.

---

## Deploy (about 5 minutes)

1. **Put this folder on GitHub** — create a repo and upload every file, keeping
   the structure: the `api/` folder (with `search.js`, `stats.js`, `library.js`),
   the `public/` folder (with `index.html`), plus `vercel.json` and `package.json`.
2. **Import into Vercel** — Add New → Project → Import your repo. Framework
   preset: **Other**.
3. **Add environment variables** (Settings → Environment Variables):
   | Name | Value |
   |------|-------|
   | `STEAM_API_KEY` | your key |
   | `STEAM_ID` | your steamID64 |
   | `ANTHROPIC_API_KEY` | your Anthropic key (for image reading) |
   Apply to Production, then **Deploy** (or Redeploy).
4. **Open the `.vercel.app` URL** on your phone. On iOS Safari: Share → Add to
   Home Screen so it opens full-screen like an app.

### Test locally first (optional, needs a computer with Node 18+)
```
npm i -g vercel
cd steam-backlog
```
Create a `.env` file with:
```
STEAM_API_KEY=your_key
STEAM_ID=your_steamid
ANTHROPIC_API_KEY=your_anthropic_key
```
Then run `vercel dev` and open the localhost URL it prints.

---

## Using it

- **+ Add** — search the Steam store, tap Add on any result.
- **Import** — pulls your owned games; tap any to add to the backlog.
- **📷 Image** — pick a screenshot or photo (Steam list, wishlist, or game
  shelf). The app reads the game titles, matches each to Steam, and shows a
  review screen: untick any wrong matches, tap a match to cycle to an
  alternative, then "Add selected". You can also **drag an image onto the page**
  or **paste** a screenshot straight from your clipboard.
- **Sort bar** — tap a sort (A–Z, Achievements, Main story, Completionist).
  Tap the same one again to flip direction. Games missing that stat sort to
  the bottom.
- **Tap the game count** (top right) to refresh all stats.
- **✕** on a card removes it.

---

## How the data works

- **Achievements** come from Steam's `GetPlayerAchievements` using your key.
  A game only shows achievement numbers if you own it and your profile is public;
  otherwise it shows `—`.
- **HowLongToBeat times** come from a community REST service that maps a Steam
  appid to HLTB main-story and completionist hours. It's third-party and
  best-effort: if it's ever unreachable, cards show `—` for hours and everything
  else keeps working. HLTB has no official API, which is why this indirect route
  is used.
- Your backlog list and fetched stats are cached on your device (localStorage),
  so the app loads instantly and works offline for browsing.

## Customizing
- Colors: the `:root` CSS variables near the top of `public/index.html`.
- Sort options: the `SORTS` array in the script.
- HLTB source: the `HLTB_BASE` constant in `api/stats.js` if you host your own.
