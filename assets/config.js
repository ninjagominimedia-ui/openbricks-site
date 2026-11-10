// Site settings. API = the Cloudflare Worker address you get from `npx wrangler deploy` (no trailing slash).
window.OB_CONFIG = {
  // on your own PC (http://localhost) the site talks to a local copy of the Worker instead of the live one
  API: ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://localhost:8787' : 'https://openbricks-api.poscabro94.workers.dev',
  CLIENT_ID: '1148315577014820904',
  INVITE: 'https://discord.com/oauth2/authorize?client_id=1148315577014820904&permissions=1512634182855&scope=bot%20applications.commands',
  SUPPORT: 'https://discord.gg/UKvZVfjuGu',
  EMAIL: 'david@open-bricks.site',
};
