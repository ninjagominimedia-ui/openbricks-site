// Dashboard: #/servers (server picker), #/server/<id> (settings), #/collection (your pack cards).
renderNav('dash'); renderFooter();
const app = $('#app');

// settings shown per server, grouped like Dyno modules. key = field the Worker accepts.
const MODULES = [
  { id: 'spawns', icon: '🃏', name: 'Card Spawns', desc: 'Where cards appear while people chat.', fields: [
    { key: 'spawnChannelId', label: 'Spawn channel', type: 'channel' },
    { key: 'announcementChannelId', label: 'Announcements channel', type: 'channel', help: 'Bot updates and event news.' },
    { key: 'ninjagoOnly', label: 'Ninjago cards only', type: 'toggle', help: 'Only spawn cards from the Ninjago universe.' },
    { key: 'activityReward', label: 'Activity reward (OBCoins)', type: 'number', min: 0, help: 'Coins for being active in chat. 0 = off.' },
  ] },
  { id: 'welcome', icon: '👋', name: 'Welcome', desc: 'Greet new members.', fields: [
    { key: 'welcomeChannel', label: 'Welcome channel', type: 'channel' },
    { key: 'welcomeText', label: 'Message', type: 'text', help: 'Placeholders: {user} {username} {server} {count}' },
  ] },
  { id: 'goodbye', icon: '🚪', name: 'Goodbye', desc: 'Say bye when someone leaves.', fields: [
    { key: 'goodbyeChannel', label: 'Goodbye channel', type: 'channel' },
    { key: 'goodbyeText', label: 'Message', type: 'text', help: 'Placeholders: {user} {username} {server} {count}' },
  ] },
  { id: 'logs', icon: '📜', name: 'Logging', desc: 'Keep track of what happens.', fields: [
    { key: 'logsChannel', label: 'Server log channel', type: 'channel' },
    { key: 'invitesChannel', label: 'Invite log channel', type: 'channel' },
  ] },
  { id: 'star', icon: '⭐', name: 'Starboard', desc: 'Messages with enough ⭐ get reposted.', fields: [
    { key: 'starChannel', label: 'Starboard channel', type: 'channel' },
    { key: 'starThreshold', label: 'Stars needed', type: 'number', min: 1, max: 100 },
  ] },
  { id: 'fun', icon: '🎉', name: 'Fun', desc: 'Community channels.', fields: [
    { key: 'lastLetterChannel', label: 'Last Letter game channel', type: 'channel' },
    { key: 'birthdayChannel', label: 'Birthday channel', type: 'channel' },
  ] },
];
const SLEEVE_NAMES = { ninja: '🥷 Ninja Black', dragon: '🐉 Dragon Scale', ice: '❄️ Frost', neon: '💜 Neon Glow', gold: '🏆 Golden Weapon', jade: '🟢 Jade Temple', champion: '👑 Season Champion' };
const VERSION = { holo: ['🌈', 'Holo Foil', 250], fullart: ['🖼️', 'Full Art', 150], gold: ['🥇', 'Gold', 100], shadow: ['🌑', 'Shadow', 50], ghost: ['👻', 'Ghost', 25] };

window.addEventListener('hashchange', route);
route();

async function route() {
  if (!Session.user) return loginScreen();
  const [, page, id] = location.hash.split('/');
  app.innerHTML = '<div class="spinner"></div>';
  $('#savebar').classList.remove('show');
  window.onbeforeunload = null; app.oninput = app.onchange = app.onclick = null; // handlers of the previous page
  try {
    if (page === 'server' && id) return await serverPage(id);
    if (page === 'collection') return await collectionPage();
    return await serversPage();
  } catch (e) {
    if (e.status === 401) return loginScreen();
    app.innerHTML = `<div class="empty" style="margin:40px 0">⚠️ ${esc(e.message)}</div>`;
  }
}

function loginScreen() {
  app.innerHTML = `<section class="hero" style="padding:90px 0"><h1>Your <span>dashboard</span></h1>
    <p>Log in with Discord to manage your servers and see your card collection.</p>
    <div class="cta"><a class="btn discord big" href="${loginUrl()}">Login with Discord</a></div></section>`;
}

function shell(active, title, sub, body, side = '') {
  const u = Session.user;
  app.innerHTML = `<div class="layout"><aside class="sidebar">
      <div class="head"><img src="${avatarUrl(u.id, u.avatar)}" alt="">${esc(u.name)}</div>
      <a href="#/servers" class="${active === 'servers' ? 'on' : ''}">🖥️ My servers</a>
      <a href="#/collection" class="${active === 'collection' ? 'on' : ''}">🃏 My collection</a>
      <a href="leaderboards.html">🏆 Leaderboards</a>${side}</aside>
    <main><h1 class="page-title">${title}</h1><p class="page-sub">${sub}</p>${body}</main></div>`;
}

// ---------------------------------------------------------------- server picker
async function serversPage() {
  const me = await api('/api/me');
  const card = (g) => {
    const icon = guildIcon(g.id, g.icon);
    return `<div class="server"><div class="bannerwrap"><div class="banner" style="background-image:url('${icon}');${icon ? '' : 'background:var(--card2)'}"></div></div>
      <div class="icon">${icon ? `<img src="${icon}" alt="">` : esc(g.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3))}</div>
      <h4 title="${esc(g.name)}">${esc(g.name)}</h4>
      ${g.botIn ? `<a class="btn primary small" href="#/server/${g.id}">Manage</a>`
        : `<a class="btn ghost small" target="_blank" rel="noopener" href="${me.inviteUrl}&guild_id=${g.id}&disable_guild_select=true">Add OpenBricks</a>`}</div>`;
  };
  shell('servers', 'Select a server', 'Servers where you have <b>Manage Server</b>.',
    me.guilds.length ? `<div class="servers">${me.guilds.map(card).join('')}</div>` : '<div class="empty">You don\'t manage any servers. Ask a server owner for Manage Server permission.</div>');
}

// ---------------------------------------------------------------- server settings
async function serverPage(id) {
  const data = await api(`/api/guilds/${id}`);
  let saved = { ...data.settings };
  const icon = guildIcon(id, data.guild.icon);
  const side = `<div class="label">${esc(data.guild.name)}</div>${MODULES.map((m) => `<a href="#/server/${id}" data-jump="${m.id}">${m.icon} ${m.name}</a>`).join('')}`;
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
    'Changes apply right away after you save.', MODULES.map((m) => `<section class="panel" id="m-${m.id}"><h3>${m.icon} ${m.name}</h3><p class="desc">${m.desc}</p><div class="fields">${m.fields.map(field).join('')}</div></section>`).join(''), side);
  document.querySelectorAll('[data-jump]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); $(`#m-${a.dataset.jump}`).scrollIntoView(); }));

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
    try { await api(`/api/guilds/${id}`, { method: 'PUT', body: JSON.stringify(body) }); saved = { ...saved, ...body }; bar.classList.remove('show'); toast('Settings saved ✅'); }
    catch (e) { toast(e.message, 'bad'); }
    $('#save').disabled = false;
  };
  // closing the tab with unsaved changes asks first
  window.onbeforeunload = () => (Object.keys(changes()).length ? true : undefined);
}

// ---------------------------------------------------------------- collection
async function collectionPage() {
  const [mine, cards] = await Promise.all([api('/api/collection'), fetch('data/cards.json').then((r) => r.json()).catch(() => [])]);
  const byCard = new Map();
  for (const r of mine.cards) { if (!byCard.has(r.cardId)) byCard.set(r.cardId, []); byCard.get(r.cardId).push(r); }
  const total = mine.cards.reduce((s, r) => s + r.n, 0), specials = mine.cards.filter((r) => r.finish).reduce((s, r) => s + r.n, 0);
  const sets = [...new Set(cards.map((c) => c.set))];
  const img = (c, finish) => `cards/${c.id}${finish && c.versions.includes(finish) ? '-' + finish : ''}.webp`;
  const tile = (c) => {
    const owned = byCard.get(c.id);
    if (!owned) return `<div class="tcard locked"><img src="${img(c)}" alt="" loading="lazy"></div>`;
    const best = ['ghost', 'shadow', 'gold', 'fullart', 'holo', null].find((f) => owned.some((r) => r.finish === f));
    return `<div class="tcard r-${String(c.rarity).toLowerCase()}" data-card="${c.id}"><img src="${img(c, best)}" alt="${esc(c.name)}" loading="lazy">
      <div class="badges">${owned.filter((r) => r.finish).map((r) => `<span>${VERSION[r.finish]?.[0] || ''}</span>`).join('')}</div>
      <div class="qty">×${owned.reduce((s, r) => s + r.n, 0)}</div></div>`;
  };
  const setHtml = sets.map((s) => {
    const list = cards.filter((c) => c.set === s), got = list.filter((c) => byCard.has(c.id)).length;
    return `<section class="panel"><h3>${esc(s)} <span style="color:var(--mute);font-weight:500;font-size:15px">${got}/${list.length}</span></h3>
      <div class="setbar"><i style="width:${(got / list.length) * 100}%"></i></div><div class="cards">${list.map(tile).join('')}</div></section>`;
  }).join('');
  const deck = mine.deck.map((d) => cards.find((c) => c.id === d.cardId)).filter(Boolean);
  shell('collection', 'My collection', 'Your pack cards. Click one for its versions and serial numbers.',
    `<div class="kpis">
      <div class="kpi"><b>${byCard.size}/${cards.length}</b><span>Unique cards</span></div>
      <div class="kpi"><b>${fmt(total)}</b><span>Total copies</span></div>
      <div class="kpi"><b>${fmt(specials)}</b><span>Special versions</span></div>
      <div class="kpi"><b>${mine.rank ? mine.rank.rating : '—'}</b><span>Battle rating (${esc(mine.season)})</span></div>
      <div class="kpi"><b>${mine.sleeve ? esc(SLEEVE_NAMES[mine.sleeve] || mine.sleeve) : '—'}</b><span>Equipped sleeve</span></div>
    </div>
    ${deck.length ? `<section class="panel"><h3>⚔️ Battle deck</h3><p class="desc">Change it in Discord with <code>!deck set</code>.</p><div class="cards" style="grid-template-columns:repeat(3,minmax(0,150px))">${deck.map(tile).join('')}</div></section>` : ''}
    ${cards.length ? setHtml : '<div class="empty">The card list isn\'t published yet.</div>'}`);
  app.onclick = (e) => {
    const t = e.target.closest('[data-card]');
    if (!t) return;
    const c = cards.find((x) => x.id === t.dataset.card), owned = byCard.get(c.id);
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="box"><img src="${img(c, owned.find((r) => r.finish)?.finish)}" alt="">
      <div><h2 style="margin:0">${esc(c.name)}</h2><p style="color:var(--mute);margin:4px 0 16px">${esc(c.title)}<br>${esc(c.rarity)} · ${esc(c.set)} · Card ${c.number} of ${c.total}</p>
      ${owned.map((r) => `<div class="toggle-row"><div><b>${r.finish ? `${VERSION[r.finish][0]} ${VERSION[r.finish][1]}` : 'Original'}</b><span class="m">×${r.n}</span></div>
        <span class="chip">best #${r.serial ?? '?'}${r.finish ? ` / ${VERSION[r.finish][2]}` : ''}</span></div>`).join('')}
      <p style="margin-top:16px"><code>!flex ${esc(c.name.toLowerCase())}</code></p></div></div>`;
    m.onclick = (ev) => { if (ev.target === m) m.remove(); };
    document.body.append(m);
  };
}
