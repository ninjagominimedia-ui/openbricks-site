// Sends the Worker's secrets to Cloudflare without printing them: node set-secrets.js
// BOT_TOKEN, TURSO_URL and TURSO_TOKEN come from the bot's config.js, SESSION_SECRET is made fresh.
// DISCORD_CLIENT_SECRET is not here: run `npx wrangler secret put DISCORD_CLIENT_SECRET` and paste it yourself.
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const BOT_CONFIG = process.argv[2] || 'A:/Python/NFC BOTTTT/OpenBricks Bot/config.js';
const cfg = require(BOT_CONFIG);

const secrets = {
  BOT_TOKEN: cfg.TOKEN,
  TURSO_URL: cfg.TURSO_IMPORT_URL,
  TURSO_TOKEN: cfg.TURSO_IMPORT_TOKEN,
  SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
};
for (const [name, value] of Object.entries(secrets)) {
  if (!value) { console.log(`✘ ${name}: missing in config.js, skipped`); continue; }
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], { input: String(value).trim(), cwd: __dirname, shell: true, encoding: 'utf8' });
  console.log(r.status === 0 ? `✔ ${name}` : `✘ ${name}\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n')}`);
}
