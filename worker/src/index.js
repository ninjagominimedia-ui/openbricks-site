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
//   POST /api/admin/jobs            -> bot owners only: queue an /admin action for the bot (commands/modules/webadmin.js)
//   GET  /api/admin/jobs/:id        -> status + result of your job
//   GET  /api/admin/log             -> last 40 website admin actions
//   GET  /api/collection            -> your pack cards, deck, battle rank, sleeves
//   GET  /api/leaderboards          -> public top lists
//   GET  /api/stats                 -> public counters for the home page
//
// Secrets (wrangler secret put ...): DISCORD_CLIENT_SECRET, BOT_TOKEN, TURSO_URL, TURSO_TOKEN, SESSION_SECRET
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
      if (url.pathname === '/api/stats') return json(env, await cached('stats', 300e3, () => publicStats(env)), 300);
      if (url.pathname === '/api/leaderboards') return json(env, await cached('lb', 120e3, () => leaderboards(env)), 120);
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
      const job = url.pathname.match(/^\/api\/admin\/jobs\/(\d+)$/);
      if (job) return json(env, await adminJob(env, session, Number(job[1])));
      const m = url.pathname.match(/^\/api\/guilds\/(\d{17,20})\/(members|mod|warnings\/(\d{17,20}))$/);
      if (m && m[2] === 'members') return json(env, await findMembers(env, session, m[1], url.searchParams.get('q')));
      if (m && m[2] === 'mod' && req.method === 'GET') return json(env, await modOverview(env, session, m[1]));
      if (m && m[2] === 'mod' && req.method === 'POST') return json(env, await modAction(env, session, m[1], await req.json()));
      if (m && m[3]) return json(env, await memberWarnings(env, session, m[1], m[3]));
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
async function sql(env, stmts) {
  const base = env.TURSO_URL.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
  const res = await fetch(`${base}/v2/pipeline`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.TURSO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [...stmts.map(([q, a = []]) => ({ type: 'execute', stmt: { sql: q, args: a.map(arg) } })), { type: 'close' }] }),
  });
  if (!res.ok) throw fail(502, `Database ${res.status}`);
  const out = await res.json();
  return out.results.slice(0, stmts.length).map((r) => {
    if (r.type === 'error') throw fail(500, 'Database: ' + r.error.message);
    const { cols, rows } = r.response.result;
    return rows.map((row) => Object.fromEntries(cols.map((c, i) => [c.name, row[i].type === 'null' ? null : row[i].type === 'integer' ? Number(row[i].value) : row[i].value])));
  });
}
const one = async (env, q, a) => (await sql(env, [[q, a]]))[0];

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
const canManage = (g) => g.owner || (BigInt(g.permissions) & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n;
async function me(env, s) {
  const [guilds, botIds, owner] = await Promise.all([userGuilds(s), botGuildIds(env), isBotOwner(env, s.uid)]);
  const list = guilds.filter(canManage).map((g) => ({ id: g.id, name: g.name, icon: g.icon, botIn: botIds.has(g.id) }));
  // bot owners manage every server the bot is in, not only their own
  if (owner) { const mine = new Set(list.map((g) => g.id)); for (const g of botIds.values()) if (!mine.has(g.id)) list.push({ ...g, botIn: true, viaOwner: true }); }
  return {
    user: { id: s.uid, name: s.name, avatar: s.avatar }, admin: owner,
    guilds: list.sort((a, b) => (b.botIn - a.botIn) || (a.viaOwner || 0) - (b.viaOwner || 0) || a.name.localeCompare(b.name)),
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
const CHANNEL_KEYS = ['welcomeChannel', 'goodbyeChannel', 'invitesChannel', 'logsChannel', 'starChannel', 'lastLetterChannel', 'birthdayChannel'];
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
const PERM = { kick: [0x2n, 'Kick Members'], ban: [0x4n, 'Ban Members'], timeout: [1n << 40n, 'Timeout Members'] };
const NEEDS = { ban: 'ban', unban: 'ban', kick: 'kick', timeout: 'timeout', untimeout: 'timeout', warn: null, unwarn: null };
const has = (g, perm) => g.owner || (BigInt(g.permissions) & (ADMINISTRATOR | PERM[perm][0])) !== 0n;
const memberOut = (m) => ({ id: m.user.id, name: m.nick || m.user.global_name || m.user.username, tag: m.user.username, avatar: m.user.avatar, timedOutUntil: m.communication_disabled_until || null });
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
  const [bans, [actions]] = await Promise.all([
    has(g, 'ban') ? discord(`/guilds/${id}/bans?limit=100`, botAuth(env)).catch(() => []) : [],
    sql(env, [['SELECT modId, targetId, action, reason, ts FROM mod_actions WHERE guildId=? ORDER BY ts DESC LIMIT 25', [id]]]),
  ]);
  return {
    perms: Object.fromEntries(Object.keys(PERM).map((p) => [p, has(g, p)])),
    bans: bans.map((b) => ({ id: b.user.id, tag: b.user.username, reason: b.reason })), actions,
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
  }
  return { ok: true };
}

// ---------------------------------------------------------------- admin panel (bot owners only)
// The bot publishes its owner list (config.authorizedAdmins) in kv webadmin:owners and runs the queued jobs itself.
const ADMIN_ACTIONS = new Set(['stats', 'servers', 'invite', 'leave', 'announce', 'webhook', 'userinfo', 'coins', 'addcard', 'removecard',
  'giveaway', 'botban', 'dm', 'broadcast', 'globalannounce', 'resetlb', 'exportdb', 'reloadconfig', 'reloadpacks', 'raidscan', 'restart', 'shutdown']);
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

const userCache = new Map(); // id -> { name, avatar, at }
async function users(env, ids) {
  const out = {};
  await Promise.all([...new Set(ids)].map(async (id) => {
    const c = userCache.get(id);
    if (c && Date.now() - c.at < 36e5) { out[id] = c; return; }
    try { const u = await discord(`/users/${id}`, botAuth(env)); out[id] = { name: u.global_name || u.username, avatar: u.avatar, at: Date.now() }; userCache.set(id, out[id]); }
    catch { out[id] = { name: 'Unknown user', avatar: null }; }
  }));
  return out;
}
async function leaderboards(env) {
  const season = new Date().toISOString().slice(0, 7);
  const run = async (q, a = []) => { try { return await one(env, q, a); } catch { return []; } }; // missing table = empty list
  const [collectors, battle, rich] = await Promise.all([
    run('SELECT userId, COUNT(DISTINCT cardId) AS unique_cards, COUNT(*) AS total, SUM(finish IS NOT NULL) AS specials FROM pack_cards GROUP BY userId ORDER BY unique_cards DESC, specials DESC LIMIT 25'),
    run('SELECT userId, rating, wins, losses FROM battle_stats WHERE season=? AND (wins+losses)>0 ORDER BY rating DESC LIMIT 25', [season]),
    run('SELECT userId, nfcoins AS coins FROM economy ORDER BY nfcoins DESC LIMIT 25'),
  ]);
  const ids = [...new Set([...collectors, ...battle, ...rich].map((r) => r.userId))];
  const [names, nickRows] = await Promise.all([users(env, ids),
    ids.length ? run(`SELECT key, value FROM kv_store WHERE key IN (${ids.map(() => '?').join(',')})`, ids.map((id) => `nick:${id}`)) : []]);
  // the name people picked with the bot's !nickname wins over their Discord name
  const nicks = Object.fromEntries(nickRows.map((r) => { try { return [r.key.slice(5), JSON.parse(r.value)]; } catch { return [r.key.slice(5), null]; } }));
  const withUser = (rows) => rows.map((r) => ({ ...r, user: { ...names[r.userId], name: nicks[r.userId] || names[r.userId]?.name } }));
  return { season, collectors: withUser(collectors), battle: withUser(battle), rich: withUser(rich) };
}
async function publicStats(env) {
  const [servers, counts] = await Promise.all([
    botGuildIds(env).then((s) => s.size).catch(() => null),
    sql(env, [['SELECT COUNT(*) AS n FROM pack_cards'], ['SELECT COUNT(DISTINCT userId) AS n FROM economy'], ['SELECT COALESCE(SUM(quantity),0) AS n FROM inventory']]).catch(() => null),
  ]);
  return { servers, packCards: counts?.[0][0].n ?? null, players: counts?.[1][0].n ?? null, cardsCaught: counts?.[2][0].n ?? null };
}
