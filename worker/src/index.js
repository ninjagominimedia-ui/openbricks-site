// OpenBricks website API (Cloudflare Worker). The website itself is static on GitHub Pages; this Worker does the
// parts that need secrets: Discord login, reading the bot's Turso database, and saving server settings.
//
// Routes
//   GET  /login                     -> Discord login page
//   GET  /callback                  -> back from Discord, sends the browser to the site with a session token
//   GET  /api/me                    -> your profile + the servers you can manage (and whether the bot is in them)
//   GET  /api/guilds/:id            -> settings + text channels of a server you manage
//   PUT  /api/guilds/:id            -> save settings
//   GET  /api/guilds/:id/members?q= -> member search (moderation)
//   GET  /api/guilds/:id/mod        -> your mod permissions, bans, recent mod actions
//   POST /api/guilds/:id/mod        -> ban / unban / kick / timeout / untimeout / warn / unwarn
//   GET  /api/guilds/:id/warnings/:userId
//   GET  /api/guilds/:id/bot        -> "Be the bot": channels you can see there
//   GET  /api/guilds/:id/bot/:ch    -> last 50 messages of a channel (?after=<messageId> for newer ones)
//   POST /api/guilds/:id/bot/:ch    -> send a message as the bot
//   POST /api/admin/jobs            -> bot owners only: queue an /admin action for the bot (commands/modules/webadmin.js)
//   GET  /api/admin/jobs/:id        -> status + result of your job
//   GET  /api/admin/log             -> last 40 website admin actions
//   POST /api/admin/purge           -> bot owners: vote to purge every bot message in a server (needs 2 owners, then the email button)
//   GET  /purge/confirm?t=          -> page with the final purge button (linked from the email)
//   POST /purge/confirm             -> the final button: queues the purge for the bot
//   GET  /api/collection            -> your pack cards, deck, battle rank, sleeves
//   GET  /api/leaderboards          -> public top lists
//   GET  /api/stats                 -> public counters for the home page
//   POST /votes/topgg, /votes/dbl   -> vote webhooks of top.gg / discordbotlist.com (the bot pays them: growth.js)
//
// Secrets (wrangler secret put ...): DISCORD_CLIENT_SECRET, BOT_TOKEN, TURSO_URL, TURSO_TOKEN, SESSION_SECRET,
//   RESEND_KEY (resend.com API key of the account registered with PURGE_EMAIL; sends the purge email),
//   TOPGG_WEBHOOK_SECRET, DBL_WEBHOOK_SECRET (the same text typed into each site's webhook "Authorization" box)
// Vars (wrangler.toml): DISCORD_CLIENT_ID, SITE_URL

const DISCORD = 'https://discord.com/api/v10';
const SESSION_DAYS = 7;
const MANAGE_GUILD = 0x20n, ADMINISTRATOR = 0x8n;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));
    try {
      if (url.pathname === '/login') return login(env, url);
      if (url.pathname === '/callback') return await callback(env, url, req);
      if (url.pathname === '/purge/confirm') return await purgeConfirm(env, req, url);
      if (url.pathname === '/api/stats') return json(env, await cached('stats', 300e3, () => publicStats(env)), 300);
      if (url.pathname === '/api/leaderboards') return json(env, await cached('lb', 120e3, () => leaderboards(env)), 120);
      const vote = url.pathname.match(/^\/votes\/(topgg|dbl)$/);
      if (vote && req.method === 'POST') return await voteHook(env, req, vote[1]);
      const session = await readSession(env, req);
      if (!session) return json(env, { error: 'Not logged in' }, 0, 401);
      if (url.pathname === '/api/me') return json(env, await me(env, session));
      if (url.pathname === '/api/whoami') return json(env, { admin: await isBotOwner(env, session.uid) }); // no Discord call: cheap
      if (url.pathname === '/api/collection') return json(env, await collection(env, session));
      // these use the bot's token or queue bot work: cap them per person so nobody can get the bot rate-limited
      if (url.pathname.startsWith('/api/guilds/') || (url.pathname === '/api/admin/jobs' && req.method === 'POST')) rateLimit(session.uid);
      const g = url.pathname.match(/^\/api\/guilds\/(\d{17,20})$/);
      if (g && req.method === 'GET') return json(env, await guildSettings(env, session, g[1]));
      if (g && req.method === 'PUT') return json(env, await saveGuild(env, session, g[1], await req.json()));
      if (url.pathname === '/api/admin/jobs' && req.method === 'POST') return json(env, await adminQueue(env, session, await req.json()));
      if (url.pathname === '/api/admin/log') return json(env, await adminLog(env, session));
      if (url.pathname === '/api/admin/purge' && req.method === 'POST') { rateLimit(session.uid, 10); return json(env, await purgeVote(env, session, await req.json(), url.origin)); }
      const job = url.pathname.match(/^\/api\/admin\/jobs\/(\d+)$/);
      if (job) return json(env, await adminJob(env, session, Number(job[1])));
      const m = url.pathname.match(/^\/api\/guilds\/(\d{17,20})\/(members|mod|warnings\/(\d{17,20}))$/);
      if (m && m[2] === 'members') return json(env, await findMembers(env, session, m[1], url.searchParams.get('q')));
      if (m && m[2] === 'mod' && req.method === 'GET') return json(env, await modOverview(env, session, m[1]));
      if (m && m[2] === 'mod' && req.method === 'POST') return json(env, await modAction(env, session, m[1], await req.json()));
      if (m && m[3]) return json(env, await memberWarnings(env, session, m[1], m[3]));
      const b = url.pathname.match(/^\/api\/guilds\/(\d{17,20})\/bot(?:\/(\d{17,20}))?$/);
      if (b && !b[2]) return json(env, await botChannels(env, session, b[1]));
      if (b && req.method === 'GET') return json(env, await botMessages(env, session, b[1], b[2], url.searchParams.get('after')));
      if (b && req.method === 'POST') { rateLimit(`${session.uid}:send`, 10); return json(env, await botSend(env, session, b[1], b[2], await req.json())); }
      return json(env, { error: 'Not found' }, 0, 404);
    } catch (e) {
      return json(env, { error: e.message || String(e) }, 0, e.status || 500);
    }
  },
};

// ---------------------------------------------------------------- helpers
// Public endpoints use the bot's token for Discord lookups. Spamming them must not burn the bot's rate limit,
// so their results are reused for a while (shared by every request one Worker instance serves).
const memo = new Map(); // key -> { at, ttl, promise }
function cached(key, ttl, make) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = make().catch((e) => { memo.delete(key); throw e; });
  if (memo.size > 2000) memo.clear(); // per-person keys (Be the bot) would otherwise pile up
  memo.set(key, { at: Date.now(), promise });
  return promise;
}
function cors(env, res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', new URL(env.SITE_URL).origin);
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  h.set('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  return new Response(res.body, { status: res.status, headers: h });
}
function json(env, data, maxAge = 0, status = 200) {
  return cors(env, new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store' },
  }));
}
const fail = (status, message) => Object.assign(new Error(message), { status });
// shortcut: counts per Worker instance (Cloudflare runs several), so the real cap is a few times higher; use a Durable Object if abuse shows up
const hits = new Map(); // userId -> { start, n }
function rateLimit(uid, max = 40, windowMs = 60e3) {
  const now = Date.now(), h = hits.get(uid);
  if (!h || now - h.start > windowMs) { hits.set(uid, { start: now, n: 1 }); if (hits.size > 5000) hits.clear(); return; }
  if (++h.n > max) throw fail(429, 'Too many requests. Wait a minute and try again.');
}
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
const fromB64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}
// tiny signed token (JWT layout): payload holds the user's own Discord access token, so only they can use it
async function sign(env, payload) {
  const body = `${b64urlText(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64urlText(JSON.stringify(payload))}`;
  return `${body}.${await hmac(env, body)}`;
}
async function verify(env, token) {
  const [h, p, s] = String(token || '').split('.');
  if (!h || !p || !s) return null;
  const expected = await hmac(env, `${h}.${p}`);
  if (expected.length !== s.length) return null;
  let diff = 0; for (let i = 0; i < s.length; i++) diff |= expected.charCodeAt(i) ^ s.charCodeAt(i); // constant time
  if (diff) return null;
  const payload = JSON.parse(fromB64url(p));
  return payload.exp > Date.now() ? payload : null;
}
const readSession = (env, req) => verify(env, (req.headers.get('Authorization') || '').replace(/^Bearer /, ''));

async function discord(path, auth, init = {}, retry = true) {
  const res = await fetch(DISCORD + path, { ...init, headers: { Authorization: auth, ...(init.headers || {}) } });
  if (res.status === 429 && retry) { // rate limited: wait what Discord asks (if short) and try once more
    const wait = Number((await res.json().catch(() => ({}))).retry_after) || 1;
    if (wait <= 5) { await new Promise((r) => setTimeout(r, wait * 1000 + 150)); return discord(path, auth, init, false); }
  }
  if (res.status === 401) throw fail(401, 'Discord login expired, log in again');
  if (!res.ok) throw fail(502, `Discord ${res.status} on ${path}`);
  return res.json();
}
const botAuth = (env) => `Bot ${env.BOT_TOKEN}`;

// ---------------------------------------------------------------- Turso (same HTTP pipeline the bot uses)
const arg = (v) => (v === null || v === undefined ? { type: 'null' }
  : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v })
    : { type: 'text', value: String(v) });
// loose: a failing statement (e.g. a table the bot hasn't made yet) gives [] instead of failing the whole batch
async function sql(env, stmts, loose = false) {
  const base = env.TURSO_URL.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
  const res = await fetch(`${base}/v2/pipeline`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.TURSO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [...stmts.map(([q, a = []]) => ({ type: 'execute', stmt: { sql: q, args: a.map(arg) } })), { type: 'close' }] }),
  });
  if (!res.ok) throw fail(502, `Database ${res.status}`);
  const out = await res.json();
  return out.results.slice(0, stmts.length).map((r) => {
    if (r.type === 'error') { if (loose) return []; throw fail(500, 'Database: ' + r.error.message); }
    const { cols, rows } = r.response.result;
    return rows.map((row) => Object.fromEntries(cols.map((c, i) => [c.name, row[i].type === 'null' ? null : row[i].type === 'integer' ? Number(row[i].value) : row[i].value])));
  });
}
const one = async (env, q, a) => (await sql(env, [[q, a]]))[0];

// ---------------------------------------------------------------- bot list votes (the bot pays them: commands/modules/growth.js)
// Both sites send the secret typed into their webhook settings as the Authorization header.
const VOTE_SITES = { topgg: ['top.gg', 'TOPGG_WEBHOOK_SECRET'], dbl: ['discordbotlist.com', 'DBL_WEBHOOK_SECRET'] };
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); // constant time
  return !diff;
}
async function voteHook(env, req, key) {
  const [site, secretName] = VOTE_SITES[key];
  const secret = env[secretName];
  if (!secret || !sameText(req.headers.get('Authorization') || '', secret)) return new Response('Unauthorized', { status: 401 });
  const body = await req.json().catch(() => ({}));
  // top.gg sends { user, isWeekend, type: 'upvote' | 'test' }, discordbotlist.com sends { id }. Test votes pay too, so the
  // owner can try the whole path once (the 11h duplicate check below stops repeats).
  const uid = String((key === 'topgg' ? body.user : body.id) || '');
  if (!/^\d{17,20}$/.test(uid)) return new Response('Bad user id', { status: 400 });
  const now = Date.now();
  await sql(env, [
    ["CREATE TABLE IF NOT EXISTS bot_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT, site TEXT, weekend INTEGER DEFAULT 0, at INTEGER, status TEXT DEFAULT 'pending')"],
    // a site resends the same vote when we answer slowly: anything within 11h of the last vote is that retry, so drop it
    ["INSERT INTO bot_votes (userId, site, weekend, at, status) SELECT ?,?,?,?,'pending' WHERE NOT EXISTS (SELECT 1 FROM bot_votes WHERE userId=? AND site=? AND at>?)",
      [uid, site, body.isWeekend ? 1 : 0, now, uid, site, now - 11 * 36e5]],
  ]);
  return new Response('ok');
}

// ---------------------------------------------------------------- login
function login(env, url) {
  const state = crypto.randomUUID();
  const auth = new URL('https://discord.com/oauth2/authorize');
  auth.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', scope: 'identify guilds', redirect_uri: `${url.origin}/callback`, state, prompt: 'none' });
  // state cookie stops someone else's login link from logging you into their account
  return new Response(null, { status: 302, headers: { Location: auth.toString(), 'Set-Cookie': `ob_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` } });
}
async function callback(env, url, req) {
  const cookie = (/(?:^|;\s*)ob_state=([^;]+)/.exec(req.headers.get('Cookie') || '') || [])[1];
  if (!cookie || cookie !== url.searchParams.get('state')) return Response.redirect(`${env.SITE_URL}/dashboard.html#error=${encodeURIComponent('Login expired, try again')}`, 302);
  const code = url.searchParams.get('code');
  if (!code) return Response.redirect(`${env.SITE_URL}/dashboard.html#error=${encodeURIComponent(url.searchParams.get('error') || 'login cancelled')}`, 302);
  const tok = await fetch(`${DISCORD}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: `${url.origin}/callback` }),
  }).then((r) => r.json());
  if (!tok.access_token) return Response.redirect(`${env.SITE_URL}/dashboard.html#error=${encodeURIComponent(tok.error_description || 'Discord login failed')}`, 302);
  const user = await discord('/users/@me', `Bearer ${tok.access_token}`);
  const session = await sign(env, {
    uid: user.id, name: user.global_name || user.username, avatar: user.avatar,
    admin: await isBotOwner(env, user.id).catch(() => false), // only shows the Admin tab; every admin request re-checks
    at: tok.access_token, exp: Date.now() + Math.min(SESSION_DAYS * 864e5, (tok.expires_in || 604800) * 1000),
  });
  return new Response(null, { status: 302, headers: { Location: `${env.SITE_URL}/dashboard.html#session=${session}`, 'Set-Cookie': 'ob_state=; Path=/; Max-Age=0' } });
}

// ---------------------------------------------------------------- servers
let botGuildCache = { at: 0, ids: new Map() };
// -> Map of every server the bot is in: id -> { id, name, icon }
async function botGuildIds(env) {
  if (Date.now() - botGuildCache.at < 60e3) return botGuildCache.ids;
  const ids = new Map();
  let after = '0';
  for (let page = 0; page < 10; page++) { // up to 2000 servers
    const list = await discord(`/users/@me/guilds?limit=200&after=${after}`, botAuth(env));
    list.forEach((g) => ids.set(g.id, { id: g.id, name: g.name, icon: g.icon }));
    if (list.length < 200) break;
    after = list[list.length - 1].id;
  }
  botGuildCache = { at: Date.now(), ids };
  return ids;
}
// Discord allows each person only ~1 "my servers" request per second, and a server page needs it 2-3 times at once:
// share one answer per login for 30s (also means losing Manage Server takes up to 30s to apply)
const userGuildCache = new Map(); // access token -> { at, promise }
function userGuilds(s) {
  const hit = userGuildCache.get(s.at);
  if (hit && Date.now() - hit.at < 30e3) return hit.promise;
  const promise = discord('/users/@me/guilds', `Bearer ${s.at}`).catch((e) => { userGuildCache.delete(s.at); throw e; });
  if (userGuildCache.size > 2000) userGuildCache.clear();
  userGuildCache.set(s.at, { at: Date.now(), promise });
  return promise;
}
const NEW_SERVER_MS = 7 * 864e5; // bot owners see a "New" tag on servers the bot joined in the last week
const canManage = (g) => g.owner || (BigInt(g.permissions) & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n;
async function me(env, s) {
  const [guilds, botIds, owner] = await Promise.all([userGuilds(s), botGuildIds(env), isBotOwner(env, s.uid)]);
  const list = guilds.filter(canManage).map((g) => ({ id: g.id, name: g.name, icon: g.icon, botIn: botIds.has(g.id) }));
  // bot owners manage every server the bot is in, not only their own
  if (owner) {
    const mine = new Set(list.map((g) => g.id));
    for (const g of botIds.values()) if (!mine.has(g.id)) list.push({ ...g, botIn: true, viaOwner: true });
    // when the bot joined each server: the bot publishes it in its status snapshot (commands/modules/remote.js)
    const snap = await kvGet(env, 'remote_snapshot').catch(() => null);
    const joined = new Map((snap?.guilds || []).map((g) => [g.id, g.joined]));
    for (const g of list) if (joined.get(g.id)) g.joined = joined.get(g.id);
  }
  const isNew = (g) => (g.joined && Date.now() - g.joined < NEW_SERVER_MS ? 1 : 0);
  return {
    user: { id: s.uid, name: s.name, avatar: s.avatar }, admin: owner,
    guilds: list.sort((a, b) => (b.botIn - a.botIn) || (isNew(b) - isNew(a)) || (a.viaOwner || 0) - (b.viaOwner || 0) || a.name.localeCompare(b.name)),
    inviteUrl: `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_CLIENT_ID}&permissions=1512634182855&scope=bot%20applications.commands`,
  };
}
async function requireManage(env, s, guildId) {
  if (await isBotOwner(env, s.uid)) { // bot owners: every server the bot is in, with every permission
    const bg = (await botGuildIds(env)).get(guildId);
    if (!bg) throw fail(404, 'OpenBricks is not in that server');
    return { ...bg, owner: true, botOwner: true };
  }
  const g = (await userGuilds(s)).find((x) => x.id === guildId);
  if (!g || !canManage(g)) throw fail(403, 'You need Manage Server in that server');
  if (!(await botGuildIds(env)).has(guildId)) throw fail(404, 'OpenBricks is not in that server');
  return g;
}

// Settings the dashboard can edit. channel = must be a text channel of that server.
const CHANNEL_KEYS = ['cardChannel', 'gameChannel', 'welcomeChannel', 'goodbyeChannel', 'invitesChannel', 'logsChannel', 'starChannel', 'lastLetterChannel', 'birthdayChannel'];
const TEXT_KEYS = { welcomeText: 1000, goodbyeText: 1000 };
const NUMBER_KEYS = { starThreshold: [1, 100], activityReward: [0, 1000000] };
const CONFIG_CHANNELS = ['spawnChannelId', 'announcementChannelId'];

async function guildSettings(env, s, id) {
  const g = await requireManage(env, s, id);
  const keys = [...CHANNEL_KEYS, ...Object.keys(TEXT_KEYS), ...Object.keys(NUMBER_KEYS), 'ninjagoOnly'];
  const [cfg, kv] = await sql(env, [
    ['SELECT spawnChannelId, announcementChannelId FROM server_config WHERE guildId=?', [id]],
    [`SELECT key, value FROM kv_store WHERE key IN (${keys.map(() => '?').join(',')})`, keys.map((k) => `guild:${id}:${k}`)],
  ]);
  const settings = { spawnChannelId: cfg[0]?.spawnChannelId || null, announcementChannelId: cfg[0]?.announcementChannelId || null };
  for (const k of keys) settings[k] = null;
  for (const r of kv) { try { settings[r.key.split(':').pop()] = JSON.parse(r.value); } catch { settings[r.key.split(':').pop()] = r.value; } }
  const channels = (await discord(`/guilds/${id}/channels`, botAuth(env))).filter((c) => c.type === 0 || c.type === 5)
    .sort((a, b) => a.position - b.position).map((c) => ({ id: c.id, name: c.name }));
  return { guild: { id, name: g.name, icon: g.icon }, settings, channels };
}
async function saveGuild(env, s, id, body) {
  await requireManage(env, s, id);
  const channels = new Set((await discord(`/guilds/${id}/channels`, botAuth(env))).filter((c) => c.type === 0 || c.type === 5).map((c) => c.id));
  const chan = (v) => { if (v === null || v === '') return null; if (!channels.has(String(v))) throw fail(400, 'Unknown channel'); return String(v); };
  const stmts = [];
  const cfg = {};
  for (const k of CONFIG_CHANNELS) if (k in body) cfg[k] = chan(body[k]);
  if (Object.keys(cfg).length) {
    stmts.push(['INSERT OR IGNORE INTO server_config (guildId) VALUES (?)', [id]]);
    for (const [k, v] of Object.entries(cfg)) stmts.push([`UPDATE server_config SET ${k}=? WHERE guildId=?`, [v, id]]);
  }
  const put = (k, v) => stmts.push(v === null
    ? ['DELETE FROM kv_store WHERE key=?', [`guild:${id}:${k}`]]
    : ['INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [`guild:${id}:${k}`, JSON.stringify(v)]]);
  for (const k of CHANNEL_KEYS) if (k in body) put(k, chan(body[k]));
  for (const [k, max] of Object.entries(TEXT_KEYS)) if (k in body) put(k, body[k] ? String(body[k]).slice(0, max) : null);
  for (const [k, [lo, hi]] of Object.entries(NUMBER_KEYS)) if (k in body) {
    const n = Math.round(Number(body[k]));
    if (!Number.isFinite(n) || n < lo || n > hi) throw fail(400, `${k} must be ${lo}-${hi}`);
    put(k, n);
  }
  if ('ninjagoOnly' in body) put('ninjagoOnly', body.ninjagoOnly ? true : null);
  if (stmts.length) await sql(env, stmts);
  return { ok: true };
}

// ---------------------------------------------------------------- moderation (same rules as the bot's moderation.js)
const PERM = { kick: [0x2n, 'Kick Members'], ban: [0x4n, 'Ban Members'], timeout: [1n << 40n, 'Timeout Members'], nick: [0x8000000n, 'Manage Nicknames'] };
const NEEDS = { ban: 'ban', unban: 'ban', kick: 'kick', timeout: 'timeout', untimeout: 'timeout', warn: null, unwarn: null, nick: 'nick' };
// channel tools, checked per channel like Discord does: msgs = Manage Messages there, edit = Manage Channels there
const CHANNEL_ACTS = { purge: 'msgs', slowmode: 'edit', lock: 'edit', unlock: 'edit' };
const MANAGE_MESSAGES = 0x2000n, MANAGE_CHANNELS = 0x10n;
const has = (g, perm) => g.owner || (BigInt(g.permissions) & (ADMINISTRATOR | PERM[perm][0])) !== 0n;
const memberOut = (m) => ({ id: m.user.id, name: m.nick || m.user.global_name || m.user.username, tag: m.user.username, avatar: m.user.avatar, bot: !!m.user.bot,
  nick: m.nick || '', joined: m.joined_at ? Date.parse(m.joined_at) : null, roles: m.roles.length, timedOutUntil: m.communication_disabled_until || null });
const dur = (min) => (min % 1440 === 0 ? `${min / 1440}d` : min % 60 === 0 ? `${min / 60}h` : `${min}m`);

async function findMembers(env, s, id, q) {
  await requireManage(env, s, id);
  q = String(q || '').trim().slice(0, 100);
  if (!q) return [];
  const list = /^\d{17,20}$/.test(q)
    ? [await discord(`/guilds/${id}/members/${q}`, botAuth(env)).catch(() => null)].filter(Boolean)
    : await discord(`/guilds/${id}/members/search?query=${encodeURIComponent(q)}&limit=10`, botAuth(env));
  return list.map(memberOut);
}
async function modOverview(env, s, id) {
  const g = await requireManage(env, s, id);
  const [bans, [actions, kv], access] = await Promise.all([
    has(g, 'ban') ? discord(`/guilds/${id}/bans?limit=100`, botAuth(env)).catch(() => []) : [],
    sql(env, [['SELECT modId, targetId, action, reason, ts FROM mod_actions WHERE guildId=? ORDER BY ts DESC LIMIT 50', [id]],
      ["SELECT key, value FROM kv_store WHERE key IN (?, 'web:names')", [`locks:${id}`]]]),
    botAccess(env, s, id),
  ]);
  const kvv = Object.fromEntries(kv.map((r) => { try { return [r.key, JSON.parse(r.value)]; } catch { return [r.key, null]; } }));
  const locks = kvv[`locks:${id}`] || {};
  // lock/purge/slowmode rows point at a channel, not a person
  const ids = actions.flatMap((a) => (/^(Lock|Unlock|Purge|Slowmode)/.test(a.action) ? [a.modId] : [a.modId, a.targetId]));
  const names = await users(env, ids, kvv['web:names'] || {});
  return {
    perms: Object.fromEntries(Object.keys(PERM).map((p) => [p, has(g, p)])),
    bans: bans.map((b) => ({ id: b.user.id, tag: b.user.username, reason: b.reason })),
    actions: actions.map((a) => ({ ...a, mod: names[a.modId]?.name, target: names[a.targetId]?.name })),
    channels: [...access.values()].filter((c) => c.msgs || c.edit).map((c) => ({ ...c, locked: locks[c.id] ? { until: locks[c.id].until || 0 } : null })),
  };
}
async function memberWarnings(env, s, id, uid) {
  await requireManage(env, s, id);
  return one(env, 'SELECT id, modId, reason, ts FROM warnings WHERE guildId=? AND userId=? ORDER BY ts DESC', [id, uid]);
}

// Discord's own check stops the bot acting on roles above its own; this stops the *person* doing it.
async function checkRank(env, id, actorId, target) {
  const guild = await discord(`/guilds/${id}`, botAuth(env));
  if (target.user.id === guild.owner_id) throw fail(403, 'You can\'t moderate the server owner.');
  if (actorId === guild.owner_id) return;
  const actor = await discord(`/guilds/${id}/members/${actorId}`, botAuth(env));
  const pos = new Map(guild.roles.map((r) => [r.id, r.position]));
  const top = (m) => Math.max(0, ...m.roles.map((r) => pos.get(r) ?? 0));
  if (top(actor) <= top(target)) throw fail(403, 'Your highest role must be strictly above theirs.');
}
async function botDo(env, path, method, body, reason) {
  const res = await fetch(DISCORD + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: botAuth(env), 'Content-Type': 'application/json', 'X-Audit-Log-Reason': encodeURIComponent(reason.slice(0, 400)) },
  });
  if (res.status === 403) throw fail(403, 'OpenBricks can\'t do that. Its role must be above theirs and it needs that permission.');
  if (res.status === 404) throw fail(404, 'Not found (maybe already done?)');
  if (!res.ok) throw fail(502, `Discord ${res.status}`);
}
async function dmUser(env, uid, content) {
  try {
    const ch = await discord('/users/@me/channels', botAuth(env), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient_id: uid }) });
    await botDo(env, `/channels/${ch.id}/messages`, 'POST', { content, allowed_mentions: { parse: [] } }, '');
  } catch { /* DMs closed: the action still happens, like in the bot */ }
}
async function record(env, id, modId, targetId, action, reason) {
  const [, logs] = await sql(env, [
    ['INSERT INTO mod_actions (guildId, modId, targetId, action, reason, ts) VALUES (?,?,?,?,?,?)', [id, modId, targetId, action, reason, Date.now()]],
    ['SELECT value FROM kv_store WHERE key=?', [`guild:${id}:logsChannel`]],
  ]);
  let ch = logs[0]?.value;
  try { ch = JSON.parse(ch); } catch { /* stored raw */ }
  if (ch) await botDo(env, `/channels/${ch}/messages`, 'POST', {
    allowed_mentions: { parse: [] },
    embeds: [{ title: `🛡️ ${action}`, color: 0xE74C3C, description: `**Target:** <@${targetId}> (\`${targetId}\`)\n**Moderator:** <@${modId}> (website dashboard)\n**Reason:** ${reason}`.slice(0, 4096) }],
  }, '').catch(() => {});
}

async function modAction(env, s, id, body) {
  const g = await requireManage(env, s, id);
  const action = String(body.action || '');
  if (Object.hasOwn(CHANNEL_ACTS, action)) return channelAction(env, s, id, action, body);
  if (!Object.hasOwn(NEEDS, action)) throw fail(400, 'Unknown action');
  const need = NEEDS[action];
  if (need && !has(g, need)) throw fail(403, `You need ${PERM[need][1]} in this server.`);
  const uid = String(body.userId || '');
  if (!/^\d{17,20}$/.test(uid)) throw fail(400, 'Pick a member first.');
  if (uid === s.uid) throw fail(400, 'You can\'t do that to yourself.');
  const reason = String(body.reason || '').trim().slice(0, 400) || 'No reason given';
  const audit = `${s.name} (dashboard): ${reason}`;
  if (action !== 'unban') {
    const target = await discord(`/guilds/${id}/members/${uid}`, botAuth(env)).catch(() => null);
    if (!target && action !== 'unwarn') throw fail(404, 'That user is not in this server.');
    if (target && !g.botOwner) await checkRank(env, id, s.uid, target); // bot owners skip the role check, like in the bot (Discord still stops the bot acting above its own role)
  }
  if (action === 'ban') {
    await dmUser(env, uid, `🔨 You were banned from **${g.name}**: ${reason}`);
    await botDo(env, `/guilds/${id}/bans/${uid}`, 'PUT', {}, audit);
    await record(env, id, s.uid, uid, 'Ban', reason);
  } else if (action === 'unban') {
    await botDo(env, `/guilds/${id}/bans/${uid}`, 'DELETE', undefined, audit);
    await record(env, id, s.uid, uid, 'Unban', reason);
  } else if (action === 'kick') {
    await dmUser(env, uid, `👢 You were kicked from **${g.name}**: ${reason}`);
    await botDo(env, `/guilds/${id}/members/${uid}`, 'DELETE', undefined, audit);
    await record(env, id, s.uid, uid, 'Kick', reason);
  } else if (action === 'timeout') {
    const min = Math.round(Number(body.minutes));
    if (!Number.isFinite(min) || min < 1 || min > 28 * 1440) throw fail(400, 'Timeout must be 1 minute to 28 days.');
    await botDo(env, `/guilds/${id}/members/${uid}`, 'PATCH', { communication_disabled_until: new Date(Date.now() + min * 60e3).toISOString() }, audit);
    await record(env, id, s.uid, uid, `Timeout (${dur(min)})`, reason);
    await dmUser(env, uid, `🔇 You were timed out in **${g.name}** for ${dur(min)}: ${reason}`);
  } else if (action === 'untimeout') {
    await botDo(env, `/guilds/${id}/members/${uid}`, 'PATCH', { communication_disabled_until: null }, audit);
    await record(env, id, s.uid, uid, 'Timeout removed', reason);
  } else if (action === 'warn') {
    const [, [{ c }]] = await sql(env, [
      ['INSERT INTO warnings (guildId, userId, modId, reason, ts) VALUES (?,?,?,?,?)', [id, uid, s.uid, reason, Date.now()]],
      ['SELECT COUNT(*) c FROM warnings WHERE guildId=? AND userId=?', [id, uid]],
    ]);
    await record(env, id, s.uid, uid, 'Warn', reason);
    await dmUser(env, uid, `⚠️ You were warned in **${g.name}**: ${reason} (warning #${c})`);
  } else if (action === 'unwarn') {
    const wid = Math.round(Number(body.warnId));
    const [w] = await one(env, 'SELECT id FROM warnings WHERE id=? AND guildId=? AND userId=?', [wid, id, uid]);
    if (!w) throw fail(404, 'No matching warning found.');
    await one(env, 'DELETE FROM warnings WHERE id=?', [w.id]);
    await record(env, id, s.uid, uid, 'Unwarn', `Removed warning #${w.id}`);
  } else if (action === 'nick') {
    const nick = String(body.nick || '').trim().slice(0, 32);
    await botDo(env, `/guilds/${id}/members/${uid}`, 'PATCH', { nick: nick || null }, audit);
    await record(env, id, s.uid, uid, nick ? `Nickname: ${nick}` : 'Nickname reset', reason);
  }
  return { ok: true };
}

// Locks use the bot's own format (kv locks:<guildId>, commands/modules/moderation.js), so !unlock undoes a website lock,
// the dashboard undoes a !lock, and the bot's 30s sweep ends timed locks from either side.
const LOCK_BITS = { SendMessages: 0x800n, SendMessagesInThreads: 1n << 38n, CreatePublicThreads: 1n << 35n, CreatePrivateThreads: 1n << 36n };
const LOCK_MASK = Object.values(LOCK_BITS).reduce((a, b) => a | b, 0n);
const STAFF_BITS = ADMINISTRATOR | MANAGE_MESSAGES | MANAGE_CHANNELS | (1n << 40n); // roles that keep talking, like the bot's staffRole()
const setOverwrite = (env, ch, roleId, allow, deny, audit) => botDo(env, `/channels/${ch}/permissions/${roleId}`, 'PUT', { type: 0, allow: String(allow), deny: String(deny) }, audit);

async function channelAction(env, s, id, action, body) {
  const chId = String(body.channelId || '');
  const c = (await botAccess(env, s, id)).get(chId);
  const need = CHANNEL_ACTS[action];
  if (!c || !c[need]) throw fail(403, need === 'msgs' ? 'You need Manage Messages in that channel.' : 'You need Manage Channels in that channel.');
  const reason = String(body.reason || '').trim().slice(0, 400) || 'No reason given';
  const audit = `${s.name} (dashboard): ${reason}`;
  if (action === 'purge') {
    const n = Math.round(Number(body.count));
    if (!(n >= 1 && n <= 100)) throw fail(400, 'Pick 1 to 100 messages.');
    const from = /^\d{17,20}$/.test(String(body.userId || '')) ? String(body.userId) : null;
    const cutoff = Date.now() - 14 * 864e5 + 60e3; // Discord only bulk-deletes messages younger than 14 days
    const list = await discord(`/channels/${chId}/messages?limit=100`, botAuth(env));
    const ids = list.filter((m) => !m.pinned && (!from || m.author.id === from) && Date.parse(m.timestamp) > cutoff).slice(0, n).map((m) => m.id);
    if (ids.length > 1) await botDo(env, `/channels/${chId}/messages/bulk-delete`, 'POST', { messages: ids }, audit);
    else if (ids.length) await botDo(env, `/channels/${chId}/messages/${ids[0]}`, 'DELETE', undefined, audit);
    await record(env, id, s.uid, chId, `Purge (${ids.length} messages in #${c.name}${from ? `, from ${from}` : ''})`, reason);
    return { ok: true, deleted: ids.length };
  }
  if (action === 'slowmode') {
    const sec = Math.round(Number(body.seconds));
    if (!(sec >= 0 && sec <= 21600)) throw fail(400, 'Slowmode goes from off to 6 hours.');
    await botDo(env, `/channels/${chId}`, 'PATCH', { rate_limit_per_user: sec }, audit);
    c.slow = sec; // the cached channel list shows the new value straight away
    await record(env, id, s.uid, chId, sec ? `Slowmode #${c.name} (${sec}s)` : `Slowmode off #${c.name}`, reason);
    return { ok: true };
  }
  const key = `locks:${id}`;
  const all = (await kvGet(env, key)) || {};
  const ch = await discord(`/channels/${chId}`, botAuth(env));
  const ows = new Map((ch.permission_overwrites || []).map((o) => [o.id, o]));
  const bits = (rid) => [BigInt(ows.get(rid)?.allow || 0), BigInt(ows.get(rid)?.deny || 0)];
  if (action === 'lock') {
    if (all[chId]) throw fail(400, 'That channel is already locked.');
    const min = Math.round(Number(body.minutes || 0));
    if (!(min >= 0 && min <= 7 * 1440)) throw fail(400, 'The longest lock is 7 days.');
    const roles = new Map((await discord(`/guilds/${id}`, botAuth(env))).roles.map((r) => [r.id, BigInt(r.permissions)]));
    // @everyone plus every non-staff role that was allowed to talk here
    const targets = [id, ...[...ows.values()].filter((o) => o.type === 0 && o.id !== id && (BigInt(o.allow) & LOCK_BITS.SendMessages) && roles.has(o.id) && !(roles.get(o.id) & STAFF_BITS)).map((o) => o.id)];
    const saved = {};
    try {
      for (const rid of targets) {
        const [allow, deny] = bits(rid);
        saved[rid] = Object.fromEntries(Object.entries(LOCK_BITS).map(([k, b]) => [k, allow & b ? 'allow' : deny & b ? 'deny' : null]));
        await setOverwrite(env, chId, rid, allow & ~LOCK_MASK, deny | LOCK_MASK, audit);
      }
    } finally { // whatever got locked is remembered, so unlock can always put it back
      if (Object.keys(saved).length) { all[chId] = { saved, until: min ? Date.now() + min * 60e3 : 0, by: s.uid }; await kvPut(env, key, all); }
    }
    await record(env, id, s.uid, chId, `Lock #${c.name}${min ? ` (${dur(min)})` : ''}`, reason);
    await botDo(env, `/channels/${chId}/messages`, 'POST', { allowed_mentions: { parse: [] }, embeds: [{ title: '🔒 This channel is locked', color: 0xE74C3C,
      description: `${reason}${min ? `\nIt unlocks <t:${Math.floor((Date.now() + min * 60e3) / 1000)}:R>.` : ''}` }] }, '').catch(() => {});
    return { ok: true };
  }
  // unlock
  const e = all[chId];
  if (!e) throw fail(400, 'That channel wasn\'t locked with OpenBricks.');
  for (const [rid, st] of Object.entries(e.saved || {})) {
    let [allow, deny] = bits(rid);
    for (const [k, b] of Object.entries(LOCK_BITS)) { allow &= ~b; deny &= ~b; if (st[k] === 'allow') allow |= b; else if (st[k] === 'deny') deny |= b; }
    await setOverwrite(env, chId, rid, allow, deny, audit).catch((err) => { if (err.status !== 404) throw err; }); // 404 = role deleted meanwhile
  }
  delete all[chId];
  await kvPut(env, key, Object.keys(all).length ? all : null);
  await record(env, id, s.uid, chId, `Unlock #${c.name}`, reason);
  await botDo(env, `/channels/${chId}/messages`, 'POST', { allowed_mentions: { parse: [] }, embeds: [{ title: '🔓 This channel is unlocked', description: 'You can talk again.', color: 0x2ECC71 }] }, '').catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------- "Be the bot": read a channel and talk as OpenBricks
// The web version of the old OpenBricks Client's Messages tab, limited to one server you manage. It uses the bot's token
// straight from here, so it works live without the bot process. You only get channels Discord lets YOU see (and send in):
// Manage Server must not open staff channels you're not allowed into.
const VIEW = 0x400n, SEND = 0x800n, HISTORY = 0x10000n;
const allowed = (p, need) => (p & need) === need;
function channelPerms(guildId, roles, member, c) {
  let base = roles.get(guildId) || 0n; // @everyone role has the server's id
  for (const r of member.roles) base |= roles.get(r) || 0n;
  if (base & ADMINISTRATOR) return -1n; // every bit
  const ow = new Map((c.permission_overwrites || []).map((o) => [o.id, o]));
  const apply = (p, o) => (o ? (p & ~BigInt(o.deny)) | BigInt(o.allow) : p);
  let p = apply(base, ow.get(guildId));
  let allow = 0n, deny = 0n;
  for (const r of member.roles) { const o = ow.get(r); if (o) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); } }
  p = (p & ~deny) | allow;
  return apply(p, ow.get(member.user.id));
}
// -> Map channelId -> { id, name, read, send } of text channels the person may see. Cached 30s per person + server.
function botAccess(env, s, id) {
  return cached(`acc:${s.uid}:${id}`, 30e3, async () => {
    const g = await requireManage(env, s, id);
    const chans = (await discord(`/guilds/${id}/channels`, botAuth(env))).filter((c) => c.type === 0 || c.type === 5).sort((a, b) => a.position - b.position);
    let perms = () => -1n; // server owners and bot owners see everything
    if (!g.owner) {
      const [guild, member] = await Promise.all([discord(`/guilds/${id}`, botAuth(env)), discord(`/guilds/${id}/members/${s.uid}`, botAuth(env))]);
      const roles = new Map(guild.roles.map((r) => [r.id, BigInt(r.permissions)]));
      perms = (c) => channelPerms(id, roles, member, c);
    }
    const out = new Map();
    for (const c of chans) {
      const p = perms(c);
      if (allowed(p, VIEW)) out.set(c.id, { id: c.id, name: c.name, read: allowed(p, VIEW | HISTORY), send: allowed(p, VIEW | SEND),
        msgs: allowed(p, VIEW | MANAGE_MESSAGES), edit: allowed(p, VIEW | MANAGE_CHANNELS), slow: c.rate_limit_per_user || 0 });
    }
    return out;
  });
}
async function botChannel(env, s, id, ch, what) {
  const c = (await botAccess(env, s, id)).get(ch);
  if (!c || !c[what]) throw fail(403, what === 'send' ? 'You can\'t send messages in that channel on Discord.' : 'You can\'t read that channel on Discord.');
  return c;
}
async function botChannels(env, s, id) {
  return [...(await botAccess(env, s, id)).values()];
}
const msgOut = (m) => {
  let text = m.content || '';
  for (const u of m.mentions || []) text = text.replace(new RegExp(`<@!?${u.id}>`, 'g'), `@${u.global_name || u.username}`);
  return {
    id: m.id, ts: Date.parse(m.timestamp), author: m.author.global_name || m.author.username, authorId: m.author.id, avatar: m.author.avatar, bot: !!m.author.bot,
    text, files: (m.attachments || []).map((a) => ({ name: a.filename, url: a.url })), embeds: (m.embeds || []).map((e) => e.title || e.author?.name || e.description?.slice(0, 80) || 'embed'),
  };
};
async function botMessages(env, s, id, ch, after) {
  await botChannel(env, s, id, ch, 'read');
  const q = /^\d{17,20}$/.test(after || '') ? `&after=${after}` : '';
  const list = await discord(`/channels/${ch}/messages?limit=50${q}`, botAuth(env)).catch((e) => {
    throw e.status === 502 && / 403 /.test(e.message) ? fail(403, 'OpenBricks can\'t read that channel. Give its role View Channel + Read Message History there.') : e;
  });
  return list.map(msgOut).sort((a, b) => a.ts - b.ts || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}
async function botSend(env, s, id, ch, body) {
  const content = String(body.content || '').trim();
  if (!content) throw fail(400, 'Write something first.');
  if (content.length > 2000) throw fail(400, 'Discord messages can be 2000 characters at most.');
  const c = await botChannel(env, s, id, ch, 'send');
  const m = await discord(`/channels/${ch}/messages`, botAuth(env), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: ['users'] } }), // never @everyone or role pings
  }).catch((e) => { throw e.status === 502 && / 403 /.test(e.message) ? fail(403, 'OpenBricks can\'t talk in that channel. Give its role Send Messages there.') : e; });
  // who said what as the bot: shows up in the OpenBricks Client's Activity search
  await sql(env, [['INSERT INTO activity_log (ts, type, userId, name, guildId, channelId, text) VALUES (?,?,?,?,?,?,?)',
    [Date.now(), 'webbot', s.uid, s.name, id, ch, `as bot in #${c.name}: ${content}`.slice(0, 300)]]], true).catch(() => {});
  return msgOut(m);
}

// ---------------------------------------------------------------- admin panel (bot owners only)
// The bot publishes its owner list (config.authorizedAdmins) in kv webadmin:owners and runs the queued jobs itself.
const ADMIN_ACTIONS = new Set(['stats', 'servers', 'invite', 'leave', 'announce', 'webhook', 'userinfo', 'coins', 'addcard', 'removecard',
  'giveaway', 'botban', 'dm', 'broadcast', 'globalannounce', 'resetlb', 'exportdb', 'reloadconfig', 'reloadpacks', 'raidscan', 'susscan', 'autodelete', 'purgebot', 'restart', 'shutdown']);
let ownersCache = { at: 0, ids: [] };
async function isBotOwner(env, uid) {
  if (Date.now() - ownersCache.at > 60e3) {
    const [r] = await one(env, "SELECT value FROM kv_store WHERE key='webadmin:owners'").catch(() => []);
    let ids = [];
    try { ids = r ? JSON.parse(r.value) : []; } catch { /* broken value = nobody */ }
    ownersCache = { at: Date.now(), ids: Array.isArray(ids) ? ids.map(String) : [] };
  }
  return ownersCache.ids.includes(String(uid));
}
async function requireOwner(env, s) { if (!(await isBotOwner(env, s.uid))) throw fail(403, 'Bot owners only'); }
async function adminQueue(env, s, body) {
  await requireOwner(env, s);
  const action = String(body.action || '');
  if (!ADMIN_ACTIONS.has(action)) throw fail(400, 'Unknown action');
  const params = JSON.stringify(body.params && typeof body.params === 'object' ? body.params : {});
  if (params.length > 8000) throw fail(400, 'Too long');
  if (action === 'purgebot' && body.params?.op === 'start') throw fail(403, 'A purge needs both owners and the email button: use the purge vote.');
  const [row] = await one(env, 'INSERT INTO web_admin_jobs (adminId, action, params, status, createdAt) VALUES (?,?,?,?,?) RETURNING id',
    [s.uid, action, params, 'pending', Date.now()]).catch((e) => { throw /no such table/i.test(e.message) ? fail(503, 'The bot hasn\'t started with the admin panel code yet') : e; });
  return { id: row.id };
}
async function adminJob(env, s, id) {
  await requireOwner(env, s);
  const [j] = await one(env, 'SELECT id, action, status, result, createdAt, doneAt FROM web_admin_jobs WHERE id=? AND adminId=?', [id, s.uid]);
  if (!j) throw fail(404, 'Job not found');
  return { ...j, result: j.result ? JSON.parse(j.result) : null };
}
async function adminLog(env, s) {
  await requireOwner(env, s);
  const rows = await one(env, 'SELECT id, adminId, action, status, result, createdAt FROM web_admin_jobs ORDER BY id DESC LIMIT 40').catch(() => []);
  // other admins' results stay short and never include data (webhook URLs etc.)
  return rows.map((r) => { let text = ''; try { text = JSON.parse(r.result || '{}').text || ''; } catch { /* ignore */ } return { ...r, result: undefined, text: String(text).slice(0, 200) }; });
}

// ---------------------------------------------------------------- purge: the nuclear option
// Deleting every bot message in a server can't be undone, so it needs (1) two different bot owners to press Purge on the
// website within 24h, then (2) the button in an email sent to PURGE_EMAIL. Only that button queues the job, and the bot
// re-checks the purge:ok:<guildId> flag it sets before starting.
const PURGE_EMAIL = 'ninjago.mini.media@gmail.com';
const VOTE_MS = 24 * 3600e3, LINK_MS = 3600e3;
const sha256 = async (t) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
const kvGet = async (env, key) => { const [r] = await one(env, 'SELECT value FROM kv_store WHERE key=?', [key]); try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
const kvPut = (env, key, v) => (v === null ? one(env, 'DELETE FROM kv_store WHERE key=?', [key])
  : one(env, 'INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(v)]));
const logRow = (env, uid, action, text) => one(env, 'INSERT INTO web_admin_jobs (adminId, action, params, status, result, createdAt, doneAt) VALUES (?,?,?,?,?,?,?)',
  [uid, action, '{}', 'done', JSON.stringify({ text }), Date.now(), Date.now()]).catch(() => {});
const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function purgeVote(env, s, body, origin) {
  await requireOwner(env, s);
  const guildId = String(body.guildId || '').trim();
  const g = (await botGuildIds(env)).get(guildId);
  if (!g) throw fail(404, 'The bot is not in that server');
  const key = `purge:req:${guildId}`;
  let req = await kvGet(env, key);
  if (!req || Date.now() - req.at > VOTE_MS) req = { at: Date.now(), votes: [] };
  if (!req.votes.includes(s.uid)) req.votes.push(s.uid);
  if (req.votes.length < 2) {
    await kvPut(env, key, req);
    await logRow(env, s.uid, 'purge vote', `Asked to purge ${g.name} (1 of 2 owners). The other owner must press Purge within 24h.`);
    return { text: `Vote saved (1 of 2). The other bot owner must also press Purge for ${g.name} within 24 hours.` };
  }
  // both agreed: email the final button (pressing Purge again sends a fresh email; the old link stops working)
  if (!env.RESEND_KEY) throw fail(503, 'Both owners agreed, but the purge email is not set up yet (RESEND_KEY missing). Nothing was deleted.');
  const secret = b64url(crypto.getRandomValues(new Uint8Array(24)));
  req.token = await sha256(secret); req.tokenExp = Date.now() + LINK_MS; req.by = s.uid;
  await kvPut(env, key, req);
  const link = `${origin}/purge/confirm?t=${guildId}.${secret}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'OpenBricks <onboarding@resend.dev>', to: [PURGE_EMAIL],
      subject: `Confirm: delete every OpenBricks message in ${g.name}`,
      html: `<p>Both bot owners asked to delete <b>every message OpenBricks ever sent</b> in <b>${escHtml(g.name)}</b> (${guildId}).</p>
        <p>This can't be undone. If that is right, open this link and press the final button (it works once, for 1 hour):</p>
        <p><a href="${link}">${link}</a></p><p>If you didn't expect this, ignore this email and nothing happens.</p>`,
    }),
  });
  if (!res.ok) throw fail(502, `Both owners agreed, but the email failed (${res.status}: ${(await res.text()).slice(0, 200)}). Nothing was deleted; press Purge again to retry.`);
  await logRow(env, s.uid, 'purge vote', `Both owners agreed to purge ${g.name}. Final button emailed.`);
  return { text: `Both owners agreed. The final button was emailed to ${PURGE_EMAIL.replace(/^(.{3}).*@/, '$1***@')}. Nothing is deleted until it is pressed (within 1 hour).` };
}

function page(title, body, status = 200) {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escHtml(title)}</title><style>body{background:#0d1017;color:#e8e6e1;font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px}
h1{font-size:22px}button{background:#d8432d;color:#fff;border:0;border-radius:4px;padding:14px 22px;font:inherit;font-weight:700;cursor:pointer}</style></head>
<body><h1>${escHtml(title)}</h1>${body}</body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
}
async function purgeConfirm(env, req, url) {
  const t = req.method === 'POST' ? String((await req.formData()).get('t') || '') : String(url.searchParams.get('t') || '');
  const [guildId, secret] = t.split('.');
  const bad = () => page('Link not valid', '<p>This link expired, was already used, or was replaced by a newer email. Nothing was deleted.</p>', 410);
  if (!/^\d{17,20}$/.test(guildId || '') || !secret) return bad();
  const key = `purge:req:${guildId}`, r = await kvGet(env, key);
  if (!r?.token || r.tokenExp < Date.now() || r.token !== await sha256(secret)) return bad();
  const name = (await botGuildIds(env)).get(guildId)?.name || guildId;
  // GET only shows the button: mail scanners open links, so opening it must never delete anything
  if (req.method !== 'POST') {
    return page('Final step: purge', `<p>This deletes <b>every message OpenBricks ever sent in ${escHtml(name)}</b>, in every channel. It can't be undone.</p>
      <form method="post"><input type="hidden" name="t" value="${escHtml(t)}"><button type="submit">Delete every bot message in ${escHtml(name)}</button></form>`);
  }
  await kvPut(env, key, null); // single use
  await kvPut(env, `purge:ok:${guildId}`, Date.now());
  await one(env, 'INSERT INTO web_admin_jobs (adminId, action, params, status, createdAt) VALUES (?,?,?,?,?)',
    [r.by, 'purgebot', JSON.stringify({ guildId, op: 'start' }), 'pending', Date.now()]);
  return page('Purge started', `<p>The bot starts deleting its messages in <b>${escHtml(name)}</b> within a few seconds (if it is online). Progress: website Admin, Purge, "status".</p>`);
}

// ---------------------------------------------------------------- collection + leaderboards
async function collection(env, s) {
  const season = new Date().toISOString().slice(0, 7);
  const [cards, kv, rank, sleeves] = await sql(env, [
    ['SELECT cardId, finish, COUNT(*) AS n, MIN(serial) AS serial FROM pack_cards WHERE userId=? GROUP BY cardId, finish', [s.uid]],
    ['SELECT key, value FROM kv_store WHERE key IN (?, ?)', [`deck:${s.uid}`, `sleeve:${s.uid}`]],
    ['SELECT rating, wins, losses FROM battle_stats WHERE userId=? AND season=?', [s.uid, season]],
    ['SELECT sleeve FROM user_sleeves WHERE userId=?', [s.uid]],
  ]).catch(async () => sql(env, [ // fresh installs may not have the battle/sleeve tables yet
    ['SELECT cardId, finish, COUNT(*) AS n, MIN(serial) AS serial FROM pack_cards WHERE userId=? GROUP BY cardId, finish', [s.uid]],
    ['SELECT key, value FROM kv_store WHERE key IN (?, ?)', [`deck:${s.uid}`, `sleeve:${s.uid}`]],
  ]).then((r) => [...r, [], []]));
  const kvv = Object.fromEntries(kv.map((r) => [r.key.split(':')[0], JSON.parse(r.value)]));
  return { cards, deck: kvv.deck || [], sleeve: kvv.sleeve || null, sleeves: sleeves.map((r) => r.sleeve), rank: rank[0] || null, season };
}

// Names survive Worker restarts in kv web:names, so a refresh only asks Discord about people it hasn't looked up for a day.
// A free Worker may make 50 subrequests per request: at most NAME_LOOKUPS go to Discord, the rest fill in on later refreshes.
const NAME_LOOKUPS = 30, NAME_TTL = 864e5;
async function users(env, ids, stored) {
  const now = Date.now(), out = {}, todo = [];
  for (const id of new Set(ids)) { const c = stored[id]; if (c && now - c.at < NAME_TTL) out[id] = c; else todo.push(id); }
  let changed = false;
  await Promise.all(todo.slice(0, NAME_LOOKUPS).map(async (id) => {
    try { const u = await discord(`/users/${id}`, botAuth(env)); out[id] = stored[id] = { name: u.global_name || u.username, avatar: u.avatar, at: now }; changed = true; }
    catch { /* keeps the old name below, or Unknown */ }
  }));
  for (const id of todo) out[id] ||= stored[id] || { name: 'Unknown player', avatar: null };
  if (changed) {
    for (const k of Object.keys(stored)) if (now - stored[k].at > 30 * NAME_TTL) delete stored[k]; // people who left every board
    await kvPut(env, 'web:names', stored).catch(() => {});
  }
  return out;
}
async function leaderboards(env) {
  const season = new Date().toISOString().slice(0, 7);
  const Q = { // every board in one database round trip
    collectors: ['SELECT userId, COUNT(DISTINCT cardId) AS unique_cards, COUNT(*) AS total, SUM(finish IS NOT NULL) AS specials FROM pack_cards GROUP BY userId ORDER BY unique_cards DESC, specials DESC LIMIT 25'],
    completion: ['SELECT userId, COUNT(DISTINCT cardName) AS unique_cards, SUM(quantity) AS total FROM inventory WHERE quantity>0 GROUP BY userId ORDER BY unique_cards DESC, total DESC LIMIT 25'],
    cards: ['SELECT userId, SUM(quantity) AS total, COUNT(DISTINCT cardName) AS unique_cards FROM inventory WHERE quantity>0 GROUP BY userId ORDER BY total DESC LIMIT 25'],
    catchers: ['SELECT userId, COUNT(*) AS n FROM catches WHERE timestamp>=? GROUP BY userId ORDER BY n DESC LIMIT 25', [Date.now() - 7 * 864e5]],
    battle: ['SELECT userId, rating, wins, losses FROM battle_stats WHERE season=? AND (wins+losses)>0 ORDER BY rating DESC LIMIT 25', [season]],
    battleAll: ['SELECT userId, SUM(wins) AS wins, SUM(losses) AS losses, MAX(rating) AS best FROM battle_stats GROUP BY userId HAVING SUM(wins)>0 ORDER BY wins DESC, best DESC LIMIT 25'],
    // wallet + bank: banked coins still count (the bot's shops spend them directly)
    rich: [`SELECT * FROM (SELECT u.userId, COALESCE(e.nfcoins,0) AS wallet, COALESCE(b.balance,0) AS bank, COALESCE(e.nfcoins,0)+COALESCE(b.balance,0) AS coins
      FROM (SELECT userId FROM economy UNION SELECT userId FROM bank) u LEFT JOIN economy e ON e.userId=u.userId LEFT JOIN bank b ON b.userId=u.userId) WHERE coins>0 ORDER BY coins DESC LIMIT 25`],
    sellers: ["SELECT sellerId AS userId, COUNT(*) AS n, SUM(price) AS v FROM secondhand WHERE status='sold' GROUP BY sellerId ORDER BY n DESC, v DESC LIMIT 25"],
    games: ['SELECT statKey, userId, wins FROM (SELECT statKey, userId, wins, ROW_NUMBER() OVER (PARTITION BY statKey ORDER BY wins DESC) AS rn FROM game_stats WHERE wins>0) WHERE rn<=10 ORDER BY statKey, wins DESC'],
    clans: ['SELECT c.name, c.ownerId AS userId, c.level, c.xp, c.wins, COUNT(m.userId) AS members FROM clans c LEFT JOIN clan_members m ON m.clanId=c.id GROUP BY c.id ORDER BY c.level DESC, c.xp DESC LIMIT 25'],
    exam: ["SELECT key, value FROM kv_store WHERE key LIKE 'exam:%'"],
    nicks: ["SELECT key, value FROM kv_store WHERE key LIKE 'nick:%'"],
    names: ["SELECT value FROM kv_store WHERE key='web:names'"],
  };
  const keys = Object.keys(Q);
  const r = Object.fromEntries((await sql(env, keys.map((k) => Q[k]), true)).map((rows, i) => [keys[i], rows]));
  const parse = (v) => { try { return JSON.parse(v); } catch { return null; } };
  // the bot's Ninjago Master Exam: kv exam:<uid>, finished ones only; best score, then fastest, then fewest hints
  const exam = r.exam.map((x) => [x.key.slice(5), parse(x.value)]).filter(([, s]) => s?.s === 'done')
    .map(([userId, s]) => ({ userId, score: s.score, correct: s.correct, gm: !!s.gm, bonus: !!s.bonus, hints: 5 - s.hints, secs: Math.round((s.finishedAt - s.startedAt) / 1000) }))
    .sort((a, b) => b.score - a.score || a.secs - b.secs || a.hints - b.hints).slice(0, 25);
  const games = {};
  for (const g of r.games) (games[g.statKey] ||= []).push({ userId: g.userId, wins: g.wins });
  const lists = { collectors: r.collectors, completion: r.completion, cards: r.cards, catchers: r.catchers, battle: r.battle, battleAll: r.battleAll, rich: r.rich, sellers: r.sellers, clans: r.clans, exam };
  const ids = [...Object.values(lists), ...Object.values(games)].flat().map((x) => x.userId);
  const names = await users(env, ids, parse(r.names[0]?.value) || {});
  // the name people picked with the bot's !nickname wins over their Discord name
  const nicks = Object.fromEntries(r.nicks.map((x) => [x.key.slice(5), parse(x.value)]));
  const withUser = (rows) => rows.map((x) => ({ ...x, user: { avatar: names[x.userId]?.avatar ?? null, name: nicks[x.userId] || names[x.userId]?.name } }));
  const out = { season };
  for (const [k, rows] of Object.entries(lists)) out[k] = withUser(rows);
  out.games = Object.fromEntries(Object.entries(games).map(([k, rows]) => [k, withUser(rows)]));
  return out;
}
async function publicStats(env) {
  const [servers, counts] = await Promise.all([
    botGuildIds(env).then((s) => s.size).catch(() => null),
    sql(env, [['SELECT COUNT(*) AS n FROM pack_cards'], ['SELECT COUNT(DISTINCT userId) AS n FROM economy'], ['SELECT COALESCE(SUM(quantity),0) AS n FROM inventory']]).catch(() => null),
  ]);
  return { servers, packCards: counts?.[0][0].n ?? null, players: counts?.[1][0].n ?? null, cardsCaught: counts?.[2][0].n ?? null };
}
