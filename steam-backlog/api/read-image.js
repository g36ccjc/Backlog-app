// Image reading is currently disabled for this deployment.
// (It runs on the site owner's paid Anthropic API key, so it's off while the
// site is shared with multiple users. To re-enable, restore the previous
// version of this file from the project history and add ANTHROPIC_API_KEY.)

export default function handler(req, res) {
  res.status(403).json({ error: "Image reading is disabled on this site." });
}
