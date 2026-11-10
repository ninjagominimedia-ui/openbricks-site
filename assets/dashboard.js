// Dashboard: #/servers (server picker), #/server/<id> (settings), #/collection (your pack cards).
renderNav('dash'); renderFooter();
const app = $('#app');

// settings shown per server, grouped like Dyno modules. key = field the Worker accepts.
const MODULES = [
  { id: 'spawns', name: 'Card Spawns', desc: 'Where cards appear while people chat.', fields: [
    { key: 'spawnChannelId', label: 'Spawn channel', type: 'channel' },
    { key: 'announcementChannelId', label: 'Announcements channel', type: 'channel', help: 'Bot updates and event news.' },
    { key: 'ninjagoOnly', label: 'Ninjago cards only', type: 'toggle', help: 'Only spawn cards from the Ninjago universe.' },
    { key: 'activityReward', label: 'Activity reward (OBCoins)', type: 'number', min: 0, help: 'Coins for being active in chat. 0 = off.' },
  ] },
  { id: 'botchannels', name: 'Bot channels', desc: 'Keep the bot in its own channels. Moderation and admin commands still work everywhere.', fields: [
    { key: 'cardChannel', label: 'Card channel', type: 'channel', help: 'Card, economy, social and every other player command only works here. Empty = anywhere.' },
    { key: 'gameChannel', label: 'Game channel', type: 'channel', help: 'Games only work here. Empty = anywhere.' },
  ] },
  { id: 'welcome', name: 'Welcome', desc: 'Greet new members.', fields: [
    { key: 'welcomeChannel', label: 'Welcome channel', type: 'channel' },
    { key: 'welcomeText', label: 'Message', type: 'text', help: 'Placeholders: {user} {username} {server} {count}' },
  ] },
  { id: 'goodbye', name: 'Goodbye', desc: 'Say bye when someone leaves.', fields: [
    { key: 'goodbyeChannel', label: 'Goodbye channel', type: 'channel' },
    { key: 'goodbyeText', label: 'Message', type: 'text', help: 'Placeholders: {user} {username} {server} {count}' },
  ] },
  { id: 'logs', name: 'Logging', desc: 'Keep track of what happens.', fields: [
    { key: 'logsChannel', label: 'Server log channel', type: 'channel' },
    { key: 'invitesChannel', label: 'Invite log channel', type: 'channel' },
  ] },
  { id: 'star', name: 'Starboard', desc: 'Messages that get enough star reactions are reposted here.', fields: [
    { key: 'starChannel', label: 'Starboard channel', type: 'channel' },
    { key: 'starThreshold', label: 'Stars needed', type: 'number', min: 1, max: 100 },
  ] },
  { id: 'fun', name: 'Fun', desc: 'Community channels.', fields: [
    { key: 'lastLetterChannel', label: 'Last Letter game channel', type: 'channel' },
    { key: 'birthdayChannel', label: 'Birthday channel', type: 'channel' },
  ] },
];
const SLEEVE_NAMES = { ninja: 'Ninja Black', dragon: 'Dragon Scale', ice: 'Frost', neon: 'Neon Glow', gold: 'Golden Weapon', jade: 'Jade Temple', champion: 'Season Champion' };
const VERSION = { holo: ['Holo', 'Holo Foil', 250], fullart: ['Full Art', 'Full Art', 150], gold: ['Gold', 'Gold', 100], shadow: ['Shadow', 'Shadow', 50], ghost: ['Ghost', 'Ghost', 25] }; // [badge, name, print run]

let isAdmin = null;
let pageTimer = null; // live refresh of the open page (Be the bot feed); route() stops it
window.addEventListener('hashchange', route);
route();

async function route() {
  if (!Session.user) return loginScreen();
  // ask the server (not the login token) whether to show the Admin tab; the server re-checks every admin action anyway
  if (isAdmin === null) isAdmin = await api('/api/whoami').then((r) => !!r.admin).catch(() => false);
  const [, page, id] = location.hash.split('/');
  app.innerHTML = '<div class="spinner"></div>';
  $('#savebar').classList.remove('show');
  clearInterval(pageTimer);
  window.onbeforeunload = null; app.oninput = app.onchange = app.onclick = app.onsubmit = null; // handlers of the previous page
  try {
    if (page === 'server' && id) return await serverPage(id);
    if (page === 'collection') return await collectionPage();
    if (page === 'admin' && isAdmin) return adminPage();
    if (page === 'sus' && isAdmin) return susPage();
    return await serversPage();
  } catch (e) {
    if (e.status === 401) return loginScreen();
    app.innerHTML = `<div class="empty" style="margin:40px 0">${esc(e.message)}</div>`;
  }
}

function loginScreen() {
  app.innerHTML = `<section class="hero" style="padding:90px 0"><h1>Your <span>dashboard</span></h1>
    <p>Log in with Discord to manage your servers and see your card collection.</p>
    <div class="cta"><a class="btn discord big" href="${loginUrl()}">Login with Discord</a></div></section>`;
}

function shell(active, title, sub, body, side = '') {
  const t = document.createElement('div'); t.innerHTML = title; // title is already-escaped markup: take its plain text for the tab
  document.title = `${t.textContent.trim()} — OpenBricks`;
  const u = Session.user;
  app.innerHTML = `<div class="layout"><aside class="sidebar">
      <div class="head"><img src="${avatarUrl(u.id, u.avatar)}" alt="">${esc(u.name)}</div>
      <a href="#/servers" class="${active === 'servers' ? 'on' : ''}">My servers</a>
      <a href="#/collection" class="${active === 'collection' ? 'on' : ''}">My collection</a>
      ${isAdmin ? `<a href="#/admin" class="${active === 'admin' ? 'on' : ''}">Admin</a><a href="#/sus" class="${active === 'sus' ? 'on' : ''}">Sus users</a>` : ''}
      <a href="leaderboards.html">Leaderboards</a>${side}</aside>
    <main><h1 class="page-title">${title}</h1><p class="page-sub">${sub}</p>${body}</main></div>`;
}

// ---------------------------------------------------------------- server picker
async function serversPage() {
  const me = await api('/api/me');
  const card = (g) => {
    const icon = guildIcon(g.id, g.icon);
    return `<div class="server"><div class="bannerwrap"><div class="banner" style="background-image:url('${icon}');${icon ? '' : 'background:var(--card2)'}"></div></div>
      <div class="icon">${icon ? `<img src="${icon}" alt="">` : esc(g.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3))}</div>
      <h4 title="${esc(g.name)}">${esc(g.name)}</h4>${g.joined && Date.now() - g.joined < 7 * 864e5 ? `<span class="chip new" title="OpenBricks joined on ${new Date(g.joined).toLocaleString()}">New · ${ago(g.joined)} ago</span>` : ''}${g.viaOwner ? '<span class="chip" title="You can manage this server because you are a bot owner">bot owner</span>' : ''}
      ${g.botIn ? `<a class="btn primary small" href="#/server/${g.id}">Manage</a>`
        : `<a class="btn ghost small" target="_blank" rel="noopener" href="${me.inviteUrl}&guild_id=${g.id}&disable_guild_select=true">Add OpenBricks</a>`}</div>`;
  };
  shell('servers', 'Select a server', me.admin ? 'Your servers, plus <b>every server OpenBricks is in</b> (marked <span class="chip">bot owner</span>). Servers it joined this week are first, marked <span class="chip new">New</span>.' : 'Servers where you have <b>Manage Server</b>.',
    me.guilds.length ? `<div class="servers">${me.guilds.map(card).join('')}</div>` : '<div class="empty">You don\'t manage any servers. Ask a server owner for Manage Server permission.</div>');
}

// ---------------------------------------------------------------- server settings
async function serverPage(id) {
  const [data, mod, botChans] = await Promise.all([api(`/api/guilds/${id}`), api(`/api/guilds/${id}/mod`).catch(() => null), api(`/api/guilds/${id}/bot`).catch((e) => e)]);
  let saved = { ...data.settings };
  const icon = guildIcon(id, data.guild.icon);
  const side = `<div class="label">${esc(data.guild.name)}</div>${MODULES.map((m) => `<a href="#/server/${id}" data-jump="${m.id}">${m.name}</a>`).join('')}${mod ? `<a href="#/server/${id}" data-jump="mod">Moderation</a>` : ''}<a href="#/server/${id}" data-jump="bot">Be the bot</a>`;
  const chanOpts = (v) => `<option value="">Disabled</option>${data.channels.map((c) => `<option value="${c.id}" ${c.id === v ? 'selected' : ''}># ${esc(c.name)}</option>`).join('')}`;
  const field = (f) => {
    const v = saved[f.key];
    if (f.type === 'toggle') return `<div class="toggle-row" style="grid-column:1/-1"><div><b>${f.label}</b><span class="m">${f.help || ''}</span></div><label class="switch"><input type="checkbox" data-key="${f.key}" ${v ? 'checked' : ''}><span></span></label></div>`;
    const input = f.type === 'channel' ? `<select data-key="${f.key}">${chanOpts(v)}</select>`
      : f.type === 'number' ? `<input type="number" data-key="${f.key}" min="${f.min ?? ''}" max="${f.max ?? ''}" value="${v ?? ''}">`
        : `<textarea data-key="${f.key}" maxlength="1000" placeholder="Default message">${esc(v ?? '')}</textarea>`;
    return `<div class="field" ${f.type === 'text' ? 'style="grid-column:1/-1"' : ''}><label>${f.label}</label>${input}${f.help && f.type !== 'toggle' ? `<small>${f.help}</small>` : ''}</div>`;
  };
  shell('servers', `${icon ? `<img src="${icon}" style="width:44px;height:44px;border-radius:12px;display:inline-block;vertical-align:middle;margin-right:12px">` : ''}${esc(data.guild.name)}`,
    'Changes apply right away after you save.', MODULES.map((m) => `<section class="panel" id="m-${m.id}"><h3>${m.name}</h3><p class="desc">${m.desc}</p><div class="fields">${m.fields.map(field).join('')}</div></section>`).join('') + (mod ? modPanel(mod) : '') + botPanel(botChans), side);
  document.querySelectorAll('[data-jump]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); $(`#m-${a.dataset.jump}`).scrollIntoView(); }));
  if (mod) modWire(id, mod);
  if (Array.isArray(botChans)) botWire(id, botChans);

  const read = (el) => (el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value || null);
  const changes = () => {
    const out = {};
    document.querySelectorAll('[data-key]').forEach((el) => { const v = read(el); if ((saved[el.dataset.key] ?? null) !== v && !(el.type === 'checkbox' && !!saved[el.dataset.key] === v)) out[el.dataset.key] = v; });
    return out;
  };
  const bar = $('#savebar');
  app.oninput = app.onchange = () => bar.classList.toggle('show', Object.keys(changes()).length > 0);
  $('#reset').onclick = () => serverPage(id);
  $('#save').onclick = async () => {
    const body = changes();
    if (!Object.keys(body).length) return;
    $('#save').disabled = true;
    try { await api(`/api/guilds/${id}`, { method: 'PUT', body: JSON.stringify(body) }); saved = { ...saved, ...body }; bar.classList.remove('show'); toast('Settings saved '); }
    catch (e) { toast(e.message, 'bad'); }
    $('#save').disabled = false;
  };
  // closing the tab with unsaved changes asks first
  window.onbeforeunload = () => (Object.keys(changes()).length ? true : undefined);
}

// ---------------------------------------------------------------- moderation (the Worker re-checks every permission)
const LABEL = { ban: 'Ban', unban: 'Unban', kick: 'Kick', timeout: 'Time out', untimeout: 'Remove timeout for', warn: 'Warn', unwarn: 'Remove warning', nick: 'Rename',
  purge: 'Delete messages in', lock: 'Lock', unlock: 'Unlock', slowmode: 'Slowmode' };
const when = (ts) => new Date(ts).toLocaleString();
const row = (main, sub, right) => `<div class="toggle-row"><div><b>${main}</b><span class="m">${sub}</span></div>${right}</div>`;
const actBtn = (act, label, m, ok = true, extra = '') => `<button type="button" class="btn ghost small" data-act="${act}" data-uid="${m.id}" data-name="${esc(m.name)}" ${extra} ${ok ? '' : 'disabled title="You don\'t have that permission"'}>${label}</button>`;
const chBtn = (act, label, c) => `<button type="button" class="btn ghost small" data-act="${act}" data-ch="${c.id}" data-name="#${esc(c.name)}">${label}</button>`;
const TIMES = [[10, '10 minutes'], [60, '1 hour'], [360, '6 hours'], [1440, '1 day'], [10080, '1 week'], [40320, '28 days']];
const LOCK_TIMES = [[0, 'Until someone unlocks it'], [10, '10 minutes'], [60, '1 hour'], [360, '6 hours'], [1440, '1 day'], [10080, '7 days']];
const SLOW = [[0, 'Slowmode off'], [5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour'], [21600, '6 hours']];
const opts = (list, v) => (list.some(([k]) => k === v) ? list : [[v, `${v} seconds`], ...list]).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
const createdAt = (id) => Number(BigInt(id) >> 22n) + 1420070400000; // Discord ids carry the account's creation time
const TELLS = ['ban', 'kick', 'timeout', 'warn']; // these DM the member the reason

const logRows = (list) => (list.length ? list.map((a) => `<div class="logrow"><span class="t">${when(a.ts)}</span><b>${esc(a.action)}</b>
  <span>${a.target ? `${esc(a.target)} · ` : ''}${esc(a.reason)}</span><span class="m">by ${esc(a.mod || a.modId)}</span></div>`).join('') : '<div class="empty">No actions yet.</div>');
const chanRow = (c) => `<div class="toggle-row"><div><b>#${esc(c.name)}</b><span class="m">${c.locked ? `<span class="tag bad">Locked</span>${c.locked.until ? ` until ${when(c.locked.until)}` : ''}` : c.slow ? `Slowmode ${c.slow}s` : 'Open'}</span></div>
  <div class="acts">${c.edit ? `<select data-slow="${c.id}" aria-label="Slowmode in #${esc(c.name)}">${opts(SLOW, c.slow)}</select>` : ''}
  ${c.msgs ? chBtn('purge', 'Clear messages', c) : ''}${c.edit ? (c.locked ? chBtn('unlock', 'Unlock', c) : chBtn('lock', 'Lock', c)) : ''}</div></div>`;

function modPanel(mod) {
  const chans = mod.channels || [];
  return `<section class="panel" id="m-mod"><h3>Moderation</h3>
    <p class="desc">Same rules as the bot's commands: you need the Discord permission, and your highest role must be above theirs. Every action goes in your log channel.</p>
    <h4 class="sub-h">Members</h4>
    <form id="modfind" class="botsend"><input id="modq" placeholder="Name or user ID" autocomplete="off"><button class="btn ghost small" type="submit">Search</button></form>
    <div id="modres"></div>
    ${chans.length ? `<h4 class="sub-h">Channels</h4><p class="desc">Channels where you have Manage Messages or Manage Channels. Locks are the same as <code>!lock</code>, so <code>!unlock</code> also works.</p>${chans.map(chanRow).join('')}` : ''}
    <h4 class="sub-h">Recent actions</h4>
    <input id="logq" placeholder="Filter by name, action or reason" autocomplete="off" style="margin-bottom:8px"><div id="modlog">${logRows(mod.actions)}</div>
    ${mod.perms.ban ? `<h4 class="sub-h">Bans (${mod.bans.length})</h4>${mod.bans.length
      ? mod.bans.map((b) => row(esc(b.tag), `${esc(b.reason || 'No reason')} · ${b.id}`, actBtn('unban', 'Unban', { id: b.id, name: b.tag }))).join('')
      : '<div class="empty">Nobody is banned.</div>'}` : ''}</section>`;
}
function memberRow(m, p) {
  const timed = m.timedOutUntil && new Date(m.timedOutUntil) > new Date();
  return `<div class="toggle-row"><div class="who"><img src="${avatarUrl(m.id, m.avatar)}" alt="">
      <div><b>${esc(m.name)}</b>${m.bot ? ' <span class="tag">bot</span>' : ''}${timed ? ' <span class="tag bad">timed out</span>' : ''}
      <span class="m">@${esc(m.tag)} · ${m.id}<br>joined ${m.joined ? `${ago(m.joined)} ago` : '?'} · account ${ago(createdAt(m.id))} old · ${m.roles} role${m.roles === 1 ? '' : 's'}</span></div></div>
    <div class="acts">${actBtn('warnings', 'Warnings', m)}${actBtn('warn', 'Warn', m)}${actBtn('nick', 'Rename', m, p.nick)}${timed ? actBtn('untimeout', 'End timeout', m, p.timeout) : actBtn('timeout', 'Time out', m, p.timeout)}${actBtn('kick', 'Kick', m, p.kick)}${actBtn('ban', 'Ban', m, p.ban)}</div></div>
    <div id="w-${m.id}"></div>`;
}
// the small form that opens under a row instead of browser pop-ups
function actForm(act, name) {
  const f = [];
  if (act === 'timeout') f.push(`<div class="field"><label>How long</label><select name="minutes">${opts(TIMES, 60)}</select></div>`);
  if (act === 'lock') f.push(`<div class="field"><label>How long</label><select name="minutes">${opts(LOCK_TIMES, 0)}</select></div>`);
  if (act === 'purge') f.push('<div class="field"><label>How many, newest first</label><input name="count" type="number" min="1" max="100" value="20" required></div>',
    '<div class="field"><label>Only from this user ID</label><input name="userId" placeholder="Anyone" pattern="\\d{17,20}"></div>');
  if (act === 'nick') f.push('<div class="field"><label>New nickname</label><input name="nick" maxlength="32" placeholder="Empty = their normal name"></div>');
  f.push(`<div class="field" style="grid-column:1/-1"><label>Reason</label><input name="reason" maxlength="400" placeholder="Optional. Goes in the log${TELLS.includes(act) ? ' and in the DM they get' : ''}."></div>`);
  if (act === 'purge') f.push('<small style="grid-column:1/-1;color:var(--mute)">Pinned messages and messages older than 14 days stay.</small>');
  return `<form class="actform" data-act="${act}"><div class="fields">${f.join('')}</div>
    <div class="acts"><button class="btn ${['ban', 'kick', 'purge', 'lock'].includes(act) ? 'danger' : 'primary'} small" type="submit">${LABEL[act]} ${esc(name)}</button><button class="btn ghost small" type="button" data-cancel>Cancel</button></div></form>`;
}
async function showWarnings(id, uid, name) {
  const box = $(`#w-${uid}`);
  if (!box) return;
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const list = await api(`/api/guilds/${id}/warnings/${uid}`);
    box.innerHTML = `<div class="sublist">${list.length
      ? list.map((w) => row(`#${w.id}`, `${esc(w.reason)} · ${when(w.ts)}`, actBtn('unwarn', 'Remove', { id: uid, name }, true, `data-wid="${w.id}"`))).join('')
      : '<div class="empty">No warnings.</div>'}</div>`;
  } catch (e) { box.innerHTML = ''; toast(e.message, 'bad'); }
}
function modWire(id, mod) {
  const panel = $('#m-mod');
  let open = null; // { act, uid, ch, name, btn } of the form that is showing
  const search = async () => {
    const res = $('#modres'), q = $('#modq').value.trim();
    if (!q) { res.innerHTML = ''; return; }
    res.innerHTML = '<div class="spinner"></div>';
    try {
      const list = await api(`/api/guilds/${id}/members?q=${encodeURIComponent(q)}`);
      res.innerHTML = list.length ? list.map((m) => memberRow(m, mod.perms)).join('') : '<div class="empty">No members found.</div>';
    } catch (e) { res.innerHTML = ''; toast(e.message, 'bad'); }
  };
  // channel actions change locks, slowmode and the log: redraw the whole panel, keep the member search
  const reload = async () => {
    const q = $('#modq').value, fresh = await api(`/api/guilds/${id}/mod`);
    panel.outerHTML = modPanel(fresh);
    modWire(id, fresh);
    if (q) { $('#modq').value = q; await $('#m-mod')._search(); }
  };
  panel._search = search;
  const send = async (body, label) => {
    await api(`/api/guilds/${id}/mod`, { method: 'POST', body: JSON.stringify(body) }).then((r) => toast(r.deleted !== undefined ? `Deleted ${r.deleted} messages` : `${label}: done`));
  };
  const closeForm = () => { panel.querySelector('.actform')?.remove(); open = null; };

  panel.onclick = async (e) => {
    if (e.target.closest('[data-cancel]')) return closeForm();
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    const { act, uid, ch, name, wid } = btn.dataset;
    if (act === 'warnings') return showWarnings(id, uid, name);
    if (act === 'unwarn' || act === 'untimeout') { // small and undoable: no form
      btn.disabled = true;
      try { await send({ action: act, userId: uid, warnId: Number(wid) }, `${LABEL[act]} ${name}`); act === 'unwarn' ? showWarnings(id, uid, name) : search(); }
      catch (err) { toast(err.message, 'bad'); btn.disabled = false; }
      return;
    }
    const same = open && open.act === act && open.btn === btn;
    closeForm();
    if (same) return; // second click on the same button closes it
    open = { act, uid, ch, name, btn };
    btn.closest('.toggle-row').insertAdjacentHTML('afterend', actForm(act, name));
    panel.querySelector('.actform input, .actform select')?.focus();
  };
  panel.onsubmit = async (e) => {
    e.preventDefault();
    if (e.target.id === 'modfind') return search();
    if (!e.target.matches('.actform') || !open) return;
    const fd = Object.fromEntries(new FormData(e.target));
    const { act, uid, ch, name } = open;
    const body = { action: act, reason: fd.reason, ...(ch ? { channelId: ch } : { userId: uid }) };
    if (fd.minutes !== undefined) body.minutes = Number(fd.minutes);
    if (act === 'purge') { body.count = Number(fd.count); if (fd.userId) body.userId = fd.userId; }
    if (act === 'nick') body.nick = fd.nick;
    const go = e.target.querySelector('[type=submit]');
    go.disabled = true;
    try {
      await send(body, `${LABEL[act]} ${name}`);
      closeForm();
      if (ch || act === 'unban') return reload();
      await search();
      if (act === 'warn') showWarnings(id, uid, name);
    } catch (err) { toast(err.message, 'bad'); go.disabled = false; }
  };
  panel.onchange = async (e) => {
    const sel = e.target.closest('[data-slow]');
    if (!sel) return;
    sel.disabled = true;
    try { await send({ action: 'slowmode', channelId: sel.dataset.slow, seconds: Number(sel.value) }, 'Slowmode'); return reload(); }
    catch (err) { toast(err.message, 'bad'); sel.disabled = false; }
  };
  $('#logq').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    panel.querySelectorAll('.logrow').forEach((r) => (r.hidden = q && !r.textContent.toLowerCase().includes(q)));
  };
}

// ---------------------------------------------------------------- be the bot (web version of the OpenBricks Client's Messages tab)
function botPanel(chans) {
  const head = '<section class="panel" id="m-bot"><h3>Be the bot</h3>';
  if (!Array.isArray(chans)) return `${head}<div class="empty">${esc(chans?.message || 'Not available right now.')}</div></section>`;
  return `${head}<p class="desc">Read a channel and talk as OpenBricks. You only get channels you can see on Discord. Messages you send are logged with your name.</p>
    <div class="fields"><div class="field"><label>Channel</label><select id="botch"><option value="">Pick a channel</option>${chans.map((c) => `<option value="${c.id}">#${esc(c.name)}${c.send ? '' : ' (read only)'}</option>`).join('')}</select></div></div>
    <div id="botfeed" class="botfeed"><div class="empty">Pick a channel to see its messages.</div></div>
    <form id="botsend" class="botsend"><input id="botmsg" maxlength="2000" placeholder="Message as OpenBricks..." autocomplete="off" disabled><button class="btn primary small" type="submit" disabled>Send</button></form></section>`;
}
function botWire(id, chans) {
  const feed = $('#botfeed'), input = $('#botmsg'), btn = $('#botsend button');
  let ch = '', msgs = [], busy = false;
  const time = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const line = (m) => `<div class="bmsg"><img src="${avatarUrl(m.authorId, m.avatar, 32)}" alt=""><div><b class="${m.bot ? 'isbot' : ''}">${esc(m.author)}</b> <span class="t">${time(m.ts)}</span>
    <div class="txt">${esc(m.text)}${m.files.filter((f) => /^https:\/\//.test(f.url)).map((f) => ` <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join('')}${m.embeds.map((e) => ` <span class="chip">${esc(e)}</span>`).join('')}</div></div></div>`;
  const draw = (stick) => {
    feed.innerHTML = msgs.length ? msgs.map(line).join('') : '<div class="empty">No messages here yet.</div>';
    if (stick) feed.scrollTop = feed.scrollHeight;
  };
  const add = (list) => { const seen = new Set(msgs.map((m) => m.id)); msgs = [...msgs, ...list.filter((m) => !seen.has(m.id))].slice(-200); };
  // first call loads the last 50, then only newer ones
  const load = async () => {
    if (!ch || busy || document.hidden) return;
    busy = true;
    const want = ch, first = !msgs.length;
    try {
      const got = await api(`/api/guilds/${id}/bot/${ch}${first ? '' : `?after=${msgs.at(-1).id}`}`);
      if (want === ch && (first || got.length)) {
        const stick = first || feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
        add(got); draw(stick);
      }
    } catch (e) { if (first && want === ch) feed.innerHTML = `<div class="empty">${esc(e.message)}</div>`; } // a failed refresh just tries again
    busy = false;
    if (want !== ch) load(); // channel changed while this was loading
  };
  $('#botch').onchange = (e) => {
    ch = e.target.value; msgs = [];
    const c = chans.find((x) => x.id === ch);
    input.disabled = btn.disabled = !c?.send;
    input.placeholder = c && !c.send ? 'You can\'t send messages in this channel on Discord' : 'Message as OpenBricks...';
    feed.innerHTML = ch ? '<div class="spinner"></div>' : '<div class="empty">Pick a channel to see its messages.</div>';
    load();
  };
  $('#botsend').onsubmit = async (e) => {
    e.preventDefault();
    const content = input.value.trim();
    if (!content || !ch) return;
    btn.disabled = true;
    try {
      const m = await api(`/api/guilds/${id}/bot/${ch}`, { method: 'POST', body: JSON.stringify({ content }) });
      input.value = '';
      add([m]); draw(true);
    } catch (err) { toast(err.message, 'bad'); }
    btn.disabled = false; input.focus();
  };
  pageTimer = setInterval(load, 5000);
}

// ---------------------------------------------------------------- admin panel (bot owners; the Worker and the bot re-check every job)
const F = {
  user: { key: 'userId', label: 'User ID', ph: '123456789012345678' },
  guild: { key: 'guildId', label: 'Server', ph: 'Server ID (pick from the list)', list: 'srvlist' },
  channel: { key: 'channelId', label: 'Channel ID', ph: 'Channel ID' },
  channelOpt: { key: 'channelId', label: 'Channel ID (optional)', ph: 'Empty = system channel', optional: true },
  amount: { key: 'amount', label: 'Amount', type: 'number' },
  qty: { key: 'amount', label: 'Quantity per user', type: 'number', optional: true, ph: '1' },
  card: { key: 'card', label: 'Card name', ph: 'e.g. Lloyd' },
  message: { key: 'message', label: 'Message', type: 'textarea' },
  reason: { key: 'reason', label: 'Reason (for ban)', optional: true },
  name: { key: 'name', label: 'Webhook name (optional)', optional: true, ph: 'Ninjago Bot Webhook' },
  op: (opts) => ({ key: 'op', label: 'Action', type: 'select', options: opts }),
  scope: { key: 'scope', label: 'Server ID or "all"', list: 'srvlist', ph: 'all' },
  confirm: { key: 'confirm', label: 'Type RESET to confirm', ph: 'RESET' },
};
// '3h' / '12d' / '5mo' since a timestamp
const ago = (ts) => { const d = (Date.now() - ts) / 864e5; return d < 1 ? `${Math.max(0, Math.round(d * 24))}h` : d < 60 ? `${Math.round(d)}d` : `${Math.round(d / 30)}mo`; };
const ADMIN = [
  { group: 'Bot', items: [
    { action: 'stats', label: 'Bot stats', render: (d) => `<div class="kpis">${[['Servers', d.servers], ['Members', d.members], ['Cards collected', d.cards], ['Collectors', d.collectors], ['Uptime', `${Math.floor(d.uptimeMin / 60)}h ${d.uptimeMin % 60}m`]].map(([k, v]) => `<div class="kpi"><b>${typeof v === 'number' ? fmt(v) : esc(v)}</b><span>${k}</span></div>`).join('')}</div><p class="page-sub">Largest: ${esc(d.largest)}</p>` },
    { action: 'servers', label: 'Server list', render: (d) => `<div class="scroll">${d.map((g) => `<div class="toggle-row"><div><b>${esc(g.name)}</b><span class="m">${fmt(g.members)} members · ${g.id}</span></div></div>`).join('')}</div>` },
    { action: 'reloadconfig', label: 'Reload cards.json' },
    { action: 'reloadpacks', label: 'Reload pack cards', help: 'Pulls in pack cards published from the PC with import-pack-cards.js --publish. No re-zip or restart needed.' },
    { action: 'exportdb', label: 'Export database', help: 'The bot DMs you the database file.' },
    { action: 'restart', label: 'Restart bot', danger: 'Restart the bot now?' },
    { action: 'shutdown', label: 'Shut down bot', danger: 'Shut the bot DOWN? It stays off until someone starts it again on the host.' },
  ] },
  { group: 'Players', items: [
    { action: 'userinfo', label: 'User info', fields: [F.user], render: (d) => `<div class="toggle-row"><div style="display:flex;gap:12px;align-items:center"><img src="${avatarUrl(d.id, d.avatar)}" style="width:44px;height:44px;border-radius:50%" alt=""><div><b>${esc(d.tag)}</b><span class="m">${d.id} · account made ${new Date(d.created).toLocaleDateString()}</span></div></div></div>
      <div class="kpis">${[['OBCoins', fmt(d.coins)], ['Cards', fmt(d.cards)], ['Pack cards', fmt(d.packCards)], ['Bot-banned', d.blacklisted ? 'Yes' : 'No'], ['Jailed', d.jailedMs ? `${Math.ceil(d.jailedMs / 60000)}m` : 'No']].map(([k, v]) => `<div class="kpi"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
      <p><b>Bot added to their account:</b> ${d.install ? `yes, first used ${new Date(d.install.first).toLocaleDateString()}, last used ${ago(d.install.last)} ago` : 'not seen (only shows once they use a command through it)'}</p>
      <p><b>In ${(d.servers || []).length} of the bot's servers</b></p>
      ${(d.servers || []).length ? `<ul class="why">${d.servers.map((s) => `<li><a href="#/server/${s.id}">${esc(s.name)}</a>${s.owner ? ' (owner)' : ''} <span class="m">joined ${s.joined ? new Date(s.joined).toLocaleDateString() : 'unknown'}</span></li>`).join('')}</ul>` : '<div class="empty">Not in any server the bot is in.</div>'}` },
    { action: 'coins', label: 'Manage coins', fields: [F.user, F.op(['add', 'remove']), F.amount] },
    { action: 'addcard', label: 'Add card', fields: [F.user, F.card, F.amount] },
    { action: 'removecard', label: 'Remove card', fields: [F.user, F.card, F.amount] },
    { action: 'botban', label: 'Bot ban / unban', fields: [F.user, F.op(['ban', 'unban']), F.reason] },
    { action: 'dm', label: 'DM a user', fields: [F.user, F.message] },
  ] },
  { group: 'Security', items: [
    { action: 'raidscan', wide: true, label: 'Raid / alt scan', fields: [F.guild, { key: 'hours', label: 'Only members who joined in the last ... hours (empty = everyone)', optional: true, ph: '72' }],
      help: 'Flags accounts created close together, join waves, look-alike names, the same profile picture, and links to bot-banned users (linked alts, trades, joining right after them, similar names). Discord does not show bots anyone\'s friends, follows or bio.',
      render: (d) => `<p class="verdict ${d.verdict === 'Looks like a raid' ? 'bad' : d.verdict === 'Nothing unusual' ? 'ok' : 'warn'}"><b>${esc(d.verdict)}</b> · ${fmt(d.scanned)} members scanned${d.hours ? ` (joined in the last ${d.hours}h)` : ''} · ${d.newShare}% had accounts under a week old · <a href="#/server/${d.guildId}">open this server's moderation</a></p>
        ${d.suspects.length ? `<table class="lb rs"><thead><tr><th>Score</th><th>Member</th><th class="hide-sm">Account age</th><th>Why</th></tr></thead><tbody>${d.suspects.map((s) => `<tr><td class="pos">${s.score}</td><td><div class="who"><img src="${avatarUrl(s.id, s.avatar)}" alt="">${esc(s.tag)}</div><span class="m">${esc(s.name)} · ${s.id}</span></td><td class="hide-sm">${ago(s.created)}</td><td><ul class="why">${s.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No suspicious accounts.</div>'}
        ${d.clusters.length ? `<h4 style="margin:20px 0 6px">Groups</h4>${d.clusters.map((c) => `<div class="toggle-row"><div><b>${esc(c.type)} (${c.members.length})</b><span class="m">${c.members.map((m) => esc(m.tag)).join(', ')}</span></div></div>`).join('')}` : ''}` },
  ] },
  { group: 'Servers', items: [
    { action: 'invite', label: 'Generate invite', fields: [F.guild, F.channelOpt] },
    { action: 'announce', label: 'Server announcement', fields: [F.guild, F.channelOpt, F.message] },
    { action: 'webhook', label: 'Create webhook', fields: [F.guild, F.channel, F.name], render: (d) => `<p>Webhook URL (keep it secret):</p><code class="secret">${esc(d.url)}</code>` },
    { action: 'autodelete', label: 'Auto-delete bot messages', fields: [F.guild, F.op(['on', 'off'])],
      help: 'Deletes the bot messages 15 seconds after they are done. Spawns, games, trades and anything with buttons wait until finished.' },
    { action: 'purgebot', label: 'Purge all bot messages', fields: [F.guild, F.op(['start', 'status', 'stop'])],
      help: 'Deletes every message the bot ever sent in the server, in every channel. Nuclear option: BOTH bot owners must pick start within 24 hours, then the button in the email to ninjago.mini.media@gmail.com does it. Status shows progress.',
      danger: 'Vote to delete EVERY message the bot sent in this server?', dangerOp: 'start' },
    { action: 'leave', label: 'Leave server', fields: [F.guild], danger: 'Make the bot LEAVE this server?' },
  ] },
  { group: 'Everyone', items: [
    { action: 'globalannounce', label: 'Global announcement', fields: [F.message], danger: 'Post this in EVERY server the bot is in?' },
    { action: 'broadcast', label: 'Broadcast DM to all users', fields: [F.message], danger: 'DM this to EVERY user of the bot? This takes a while.' },
    { action: 'giveaway', label: 'Mass giveaway', fields: [F.card, F.qty], danger: 'Give this card to EVERY collector?' },
    { action: 'resetlb', label: 'Reset leaderboard', fields: [F.scope, F.confirm], danger: 'This DELETES card data and can\'t be undone. Continue?' },
  ] },
];

// queue a job, then wait for the bot to finish it
async function runJob(action, params, out) {
  out.className = 'out'; out.innerHTML = '<div class="spinner"></div>';
  const { id } = await api('/api/admin/jobs', { method: 'POST', body: JSON.stringify({ action, params }) });
  for (let i = 0; i < 400; i++) { // up to ~10 minutes, broadcasts are slow
    await new Promise((r) => setTimeout(r, i < 10 ? 1000 : 1500));
    const j = await api(`/api/admin/jobs/${id}`);
    if (j.status === 'pending' && i === 10) out.innerHTML = '<div class="spinner"></div><p class="page-sub">Waiting for the bot... is it online?</p>';
    if (j.status === 'running' && i === 10) out.innerHTML = '<div class="spinner"></div><p class="page-sub">The bot is working on it...</p>';
    if (j.status === 'expired') throw new Error('The bot was offline, so this was cancelled.');
    if (j.status === 'error') throw new Error(j.result?.text || 'Failed');
    if (j.status === 'done') return j.result;
  }
  throw new Error('Still running. Check "Recent admin actions" later.');
}

function adminPage() {
  const field = (f, a) => {
    const id = `${a.action}-${f.key}`, ph = f.ph ? `placeholder="${esc(f.ph)}"` : '';
    const input = f.type === 'textarea' ? `<textarea id="${id}" maxlength="2000" ${ph}></textarea>`
      : f.type === 'select' ? `<select id="${id}">${f.options.map((o) => `<option>${o}</option>`).join('')}</select>`
        : `<input id="${id}" ${f.type === 'number' ? 'type="number" min="1"' : ''} ${f.list ? `list="${f.list}"` : ''} ${ph} autocomplete="off">`;
    return `<div class="field" ${f.type === 'textarea' ? 'style="grid-column:1/-1"' : ''}><label>${f.label}</label>${input}</div>`;
  };
  const card = (a) => `<form class="panel admin-item${a.wide ? ' wide' : ''}" data-action="${a.action}"><h3>${a.label}</h3>${a.help ? `<p class="desc">${a.help}</p>` : ''}
    ${a.fields?.length ? `<div class="fields">${a.fields.map((f) => field(f, a)).join('')}</div>` : ''}
    <button class="btn ${a.danger ? 'danger' : 'primary'} small" type="submit">${a.label}</button><div class="out"></div></form>`;
  shell('admin', 'Admin panel', 'Bot owners only. Same actions as <code>/admin</code> in Discord. The bot does each one within a few seconds and logs it.',
    `<datalist id="srvlist"><option value="all">ALL servers</option></datalist>
    ${ADMIN.map((g) => `<h2 class="admin-group">${g.group}</h2><div class="admin-grid">${g.items.map(card).join('')}</div>`).join('')}
    <section class="panel"><h3>Recent admin actions <button class="btn ghost small" id="relog" type="button">Refresh</button></h3><div id="adminlog"><div class="spinner"></div></div></section>`);

  const loadLog = async () => {
    try {
      const rows = await api('/api/admin/log');
      $('#adminlog').innerHTML = rows.length ? rows.map((r) => `<div class="toggle-row"><div><b><i class="dot st-${esc(r.status)}" title="${esc(r.status)}"></i>${esc(r.action)}</b><span class="m">${esc(r.text)} · by ${esc(r.adminId)}</span></div><span class="chip">${new Date(r.createdAt).toLocaleString()}</span></div>`).join('') : '<div class="empty">Nothing yet.</div>';
    } catch (e) { $('#adminlog').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  $('#relog').onclick = loadLog;
  app.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target.closest('[data-action]'), a = ADMIN.flatMap((g) => g.items).find((x) => x.action === form.dataset.action);
    const params = {};
    for (const f of a.fields || []) {
      const v = $(`#${a.action}-${f.key}`).value.trim();
      if (!v && !f.optional) return toast(`Fill in: ${f.label}`, 'bad');
      if (v) params[f.key] = v;
    }
    if (a.danger && (!a.dangerOp || params.op === a.dangerOp) && !confirm(a.danger)) return;
    const btn = form.querySelector('button[type=submit]'), out = form.querySelector('.out');
    btn.disabled = true;
    try {
      // a purge start is a vote (needs both owners + the email button), not a bot job
      const res = a.action === 'purgebot' && params.op === 'start'
        ? await api('/api/admin/purge', { method: 'POST', body: JSON.stringify({ guildId: params.guildId }) })
        : await runJob(a.action, params, out);
      out.innerHTML = `<p class="ok">${esc(res.text)}</p>${a.render && res.data ? a.render(res.data) : ''}`;
      if (a.action === 'servers') fillServers(res.data);
      loadLog();
    } catch (err) { out.innerHTML = `<p class="bad">${esc(err.message)}</p>`; }
    btn.disabled = false;
  };
  const fillServers = (list) => { $('#srvlist').innerHTML = `<option value="all">ALL servers</option>${list.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}`; };
  // fill the server pickers in the background
  runJob('servers', {}, document.createElement('div')).then((r) => fillServers(r.data)).catch(() => {});
  loadLog();
}

// ---------------------------------------------------------------- sus users (bot owners): a saved list of user IDs,
// where each one is, how much they talk there, and a bot-ban button. The list is stored by the bot, so every owner sees it.
function susPage() {
  shell('sus', 'Sus users', 'Paste user IDs (any format, up to 100). Shows which bot servers each one is in and how many messages they sent there. The list is saved for every bot owner.',
    `<section class="panel"><textarea id="susids" rows="6" placeholder="One user ID per line"></textarea>
      <p><button class="btn primary small" id="susgo" type="button">Save and check</button></p></section><div id="susout"></div>`);
  const user = (u) => `<section class="panel" data-user="${u.id}">
      <div class="toggle-row"><div style="display:flex;gap:12px;align-items:center"><img src="${avatarUrl(u.id, u.avatar)}" style="width:44px;height:44px;border-radius:50%" alt="">
        <div><b>${esc(u.tag || 'Unknown user')}</b><span class="m">${u.id}${u.created ? ` · account made ${new Date(u.created).toLocaleDateString()} (${ago(u.created)} old)` : ''}</span></div></div>
        ${u.banned ? '<span class="chip">Bot-banned</span>' : ''}</div>
      ${u.servers.length ? `<table class="lb"><thead><tr><th>Server</th><th>Messages</th></tr></thead><tbody>${u.servers.map((g) => `<tr><td><a href="#/server/${g.id}">${esc(g.name)}</a></td><td>${fmt(g.messages)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">Not in any server the bot is in.</div>'}
      <p><button class="btn ${u.banned ? 'ghost' : 'danger'} small" type="button" data-ban="${u.id}" data-op="${u.banned ? 'unban' : 'ban'}">${u.banned ? 'Remove blacklist' : 'Blacklist'}</button></p><div class="out"></div></section>`;
  const show = (d) => {
    $('#susids').value = d.ids.join('\n');
    const inAny = d.users.filter((u) => u.servers.length).length, banned = d.users.filter((u) => u.banned).length;
    $('#susout').innerHTML = d.users.length ? `<p class="page-sub">${d.users.length} users · ${inAny} in at least one server · ${banned} bot-banned</p>${d.users.map(user).join('')}` : '<div class="empty">The list is empty.</div>';
  };
  const scan = async (params) => {
    const out = $('#susout'), btn = $('#susgo');
    btn.disabled = true;
    try { show((await runJob('susscan', params, out)).data); } catch (e) { out.innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
    btn.disabled = false;
  };
  $('#susgo').onclick = () => scan({ userIds: $('#susids').value });
  app.onclick = async (e) => {
    const b = e.target.closest('[data-ban]');
    if (!b) return;
    const ban = b.dataset.op === 'ban';
    if (ban && !confirm('Blacklist this user from the bot?')) return;
    const out = b.closest('section').querySelector('.out');
    b.disabled = true;
    try {
      const r = await runJob('botban', { userId: b.dataset.ban, op: b.dataset.op, reason: 'Sus users list' }, out);
      out.innerHTML = `<p class="ok">${esc(r.text)}</p>`;
      b.dataset.op = ban ? 'unban' : 'ban';
      b.textContent = ban ? 'Remove blacklist' : 'Blacklist';
      b.className = `btn ${ban ? 'ghost' : 'danger'} small`;
    } catch (err) { out.innerHTML = `<p class="bad">${esc(err.message)}</p>`; }
    b.disabled = false;
  };
  scan({}); // load the saved list
}

// ---------------------------------------------------------------- collection
async function collectionPage() {
  const [mine, cards, prof] = await Promise.all([api('/api/collection'), fetch('data/cards.json').then((r) => r.json()).catch(() => []), api('/api/profile').catch(() => null)]);
  const byCard = new Map();
  for (const r of mine.cards) { if (!byCard.has(r.cardId)) byCard.set(r.cardId, []); byCard.get(r.cardId).push(r); }
  const total = mine.cards.reduce((s, r) => s + r.n, 0), specials = mine.cards.filter((r) => r.finish).reduce((s, r) => s + r.n, 0);
  const sets = [...new Set(cards.map((c) => c.set))];
  const img = (c, finish) => `cards/${c.id}${finish && c.versions.includes(finish) ? '-' + finish : ''}.webp`;
  const tile = (c) => {
    const owned = byCard.get(c.id);
    if (!owned) return `<div class="tcard locked" data-card="${c.id}" title="Not owned yet: click to preview"><img src="${img(c)}" alt="" loading="lazy"></div>`;
    const best = ['ghost', 'shadow', 'gold', 'fullart', 'holo', null].find((f) => owned.some((r) => r.finish === f));
    return `<div class="tcard r-${String(c.rarity).toLowerCase()}" data-card="${c.id}"><img src="${img(c, best)}" alt="${esc(c.name)}" loading="lazy">
      <div class="badges">${owned.filter((r) => VERSION[r.finish]).map((r) => `<span class="v-${r.finish}">${VERSION[r.finish][0]}</span>`).join('')}</div>
      <div class="qty">×${owned.reduce((s, r) => s + r.n, 0)}</div></div>`;
  };
  const setHtml = sets.map((s) => {
    const list = cards.filter((c) => c.set === s), got = list.filter((c) => byCard.has(c.id)).length;
    return `<section class="panel"><h3>${esc(s)} <span style="color:var(--mute);font-weight:500;font-size:15px">${got}/${list.length}</span></h3>
      <div class="setbar"><i style="width:${(got / list.length) * 100}%"></i></div><div class="cards">${list.map(tile).join('')}</div></section>`;
  }).join('');
  const deck = mine.deck.map((d) => cards.find((c) => c.id === d.cardId)).filter(Boolean);
  shell('collection', 'My collection', 'Your pack cards. Click one for its versions and serial numbers, or a locked one for a preview.',
    `<div class="kpis">
      <div class="kpi"><b>${byCard.size}/${cards.length}</b><span>Unique cards</span></div>
      <div class="kpi"><b>${fmt(total)}</b><span>Total copies</span></div>
      <div class="kpi"><b>${fmt(specials)}</b><span>Special versions</span></div>
      <div class="kpi"><b>${mine.rank ? mine.rank.rating : '—'}</b><span>Battle rating (${esc(mine.season)})</span></div>
      <div class="kpi"><b>${mine.sleeve ? esc(SLEEVE_NAMES[mine.sleeve] || mine.sleeve) : '—'}</b><span>Equipped sleeve</span></div>
    </div>
    ${prof ? `<section class="panel"><div class="toggle-row"><div><b>Public profile</b><span class="m">Anyone with the link can see your pack cards, deck and battle rank. Never your coins or servers. <a href="profile.html?u=${Session.user.id}" style="color:var(--accent2);text-decoration:underline">Open my profile</a></span></div>
      <label class="switch" title="Show my public profile"><input type="checkbox" id="profpub" ${prof.hidden ? '' : 'checked'} aria-label="Show my public profile"><span></span></label></div></section>` : ''}
    ${deck.length ? `<section class="panel"><h3>Battle deck</h3><p class="desc">Change it in Discord with <code>!deck set</code>.</p><div class="cards" style="grid-template-columns:repeat(3,minmax(0,150px))">${deck.map(tile).join('')}</div></section>` : ''}
    ${cards.length ? setHtml : '<div class="empty">The card list isn\'t published yet.</div>'}`);
  const pub = $('#profpub');
  if (pub) pub.onchange = async () => {
    try { const r = await api('/api/profile', { method: 'PUT', body: JSON.stringify({ hidden: !pub.checked }) }); toast(r.hidden ? 'Your profile is hidden now' : 'Your profile is public now'); }
    catch (e) { pub.checked = !pub.checked; toast(e.message, 'bad'); }
  };
  app.onclick = (e) => {
    const t = e.target.closest('[data-card]');
    if (!t) return;
    const c = cards.find((x) => x.id === t.dataset.card), owned = byCard.get(c.id);
    const m = document.createElement('div');
    m.className = 'modal';
    const head = `<h2 style="margin:0">${esc(c.name)}</h2><p style="color:var(--mute);margin:4px 0 16px">${esc(c.title)}<br>${esc(c.rarity)} · ${esc(c.set)} · Card ${c.number} of ${c.total}</p>`;
    m.innerHTML = owned
      ? `<div class="box"><img src="${img(c, owned.find((r) => r.finish)?.finish)}" alt="">
      <div>${head}
      ${owned.map((r) => `<div class="toggle-row"><div><b>${r.finish ? esc(VERSION[r.finish]?.[1] || r.finish) : 'Original'}</b><span class="m">×${r.n}</span></div>
        <span class="chip">best #${r.serial ?? '?'}${VERSION[r.finish] ? ` / ${VERSION[r.finish][2]}` : ''}</span></div>`).join('')}
      <p style="margin-top:16px"><code>!flex ${esc(c.name.toLowerCase())}</code></p></div></div>`
      // not owned yet: a preview of the card and the versions it comes in
      : `<div class="box"><img src="${img(c)}" alt="${esc(c.name)}">
      <div>${head}<p class="verdict warn"><b>Not in your collection yet</b></p>
      <div class="toggle-row"><div><b>Original</b><span class="m">no print limit</span></div></div>
      ${c.versions.filter((f) => VERSION[f]).map((f) => `<div class="toggle-row"><div><b>${VERSION[f][1]}</b><span class="m">only ${VERSION[f][2]} ever printed</span></div></div>`).join('')}
      <p style="margin-top:16px">Open packs in Discord with <code>!buypack</code> to find it.</p></div></div>`;
    m.onclick = (ev) => { if (ev.target === m) m.remove(); };
    document.body.append(m);
  };
}
