# OpenBricks website: setup

The site has two parts:

- **The website**: everything in this folder except `worker/` and `tools/`. Hosted for free on GitHub Pages.
- **The API**: `worker/`. A free Cloudflare Worker that handles Discord login, reads the bot's database and saves server settings. It keeps the secrets, so they are never in the website files.

Both are free. Do the steps in this order.

## 1. Put the website on GitHub Pages

1. Make a free account on github.com.
2. Create a new public repository called `openbricks-site`.
3. Upload this folder to it. Use GitHub Desktop, or run `git init`, `git add .`, `git commit` and `git push`.
4. In the repository, open **Settings → Pages**. Set **Source** to "Deploy from a branch", the branch to `main` and the folder to `/ (root)`, then save.
5. After a minute the site is live at `https://YOUR-NAME.github.io/openbricks-site`.

## 2. Deploy the API (Cloudflare Worker)

1. Make a free account on dash.cloudflare.com.
2. In a terminal, from the `worker` folder:
   ```
   npx wrangler login
   ```
3. Open `worker/wrangler.toml` and set `SITE_URL` to your GitHub Pages address from step 1, with no slash at the end.
4. Add the secrets. Each command asks you to paste a value, which is never stored in a file:
   ```
   npx wrangler secret put DISCORD_CLIENT_SECRET   # Discord Developer Portal → your app → OAuth2 → Client Secret
   npx wrangler secret put BOT_TOKEN               # the same token as config.js TOKEN
   npx wrangler secret put TURSO_URL               # the same as config.js TURSO_IMPORT_URL
   npx wrangler secret put TURSO_TOKEN             # the same as config.js TURSO_IMPORT_TOKEN
   npx wrangler secret put SESSION_SECRET          # any long random text, e.g. 40+ random letters
   ```
5. Deploy it:
   ```
   npx wrangler deploy
   ```
   It prints an address like `https://openbricks-api.YOUR-SUBDOMAIN.workers.dev`.

## 3. Connect the pieces

1. Open `assets/config.js` and set `API` to the Worker address from step 2.5, then push the change to GitHub.
2. Go to discord.com/developers → your bot's application → **OAuth2 → Redirects** and add:
   `https://openbricks-api.YOUR-SUBDOMAIN.workers.dev/callback`
3. Open the site and press **Login**.

## Updating the commands and card pictures

After the bot gets new commands, or after you run `import-pack-cards.js` in the bot folder:
```
node tools/build-data.js
```
This rewrites `data/commands.json`, `data/cards.json` and the small card pictures in `cards/`. Push the result to GitHub.

## What the dashboard can change

These are the same settings as the bot's commands: spawn and announcement channels, Ninjago-only spawns, activity reward, welcome and goodbye (channel and message), log and invite-log channels, starboard (channel and stars needed), and the Last Letter and birthday channels. Only people with **Manage Server** in a server can see or change that server's settings.
