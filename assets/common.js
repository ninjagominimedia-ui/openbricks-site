// Shared bits for every page: header/footer, login session, API calls, small helpers.
const OB = window.OB_CONFIG;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const avatarUrl = (id, hash, size = 64) => (hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=${size}` : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(id || 0) >> 22n) % 6}.png`);
const guildIcon = (id, hash, size = 128) => (hash ? `https://cdn.discordapp.com/icons/${id}/${hash}.png?size=${size}` : '');

// ---- session: the Worker hands us a signed token after Discord login (dashboard.html#session=...)
const Session = {
  get token() { return localStorage.getItem('ob_session'); },
  get user() {
    try { const p = JSON.parse(atob(this.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return p.exp > Date.now() ? { id: p.uid, name: p.name, avatar: p.avatar } : null; }
    catch { return null; }
  },
  set(t) { localStorage.setItem('ob_session', t); },
  clear() { localStorage.removeItem('ob_session'); },
};
const loginUrl = () => `${OB.API}/login`;

async function api(path, opts = {}) {
  const res = await fetch(OB.API + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(Session.token ? { Authorization: `Bearer ${Session.token}` } : {}), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { Session.clear(); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
  return data;
}

function toast(text, kind = 'ok') {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.append(t); }
  t.textContent = text; t.className = `toast ${kind} show`;
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3000);
}

function renderNav(active) {
  const u = Session.user;
  const link = (href, label, key) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  const header = document.createElement('header');
  header.className = 'nav';
  header.innerHTML = `<div class="wrap">
    <a class="brand" href="index.html"><span class="logo">🃏</span>OpenBricks</a>
    <nav class="links">${link('commands.html', 'Commands', 'commands')}${link('leaderboards.html', 'Leaderboards', 'lb')}${link('dashboard.html', 'Dashboard', 'dash')}${link(OB.SUPPORT, 'Support', '')}</nav>
    <div class="right">
      <a class="btn small ghost" href="${OB.INVITE}" target="_blank" rel="noopener">Add to Discord</a>
      ${u ? `<div class="me" id="me"><img src="${avatarUrl(u.id, u.avatar)}" alt="">${esc(u.name)}
          <div class="menu" hidden><a href="dashboard.html#/servers">My servers</a><a href="dashboard.html#/collection">My collection</a><a href="#" id="logout">Log out</a></div></div>`
        : `<a class="btn small discord" href="${loginUrl()}">Login</a>`}
    </div></div>`;
  document.body.prepend(header);
  const me = $('#me');
  if (me) {
    me.onclick = (e) => { if (!e.target.closest('.menu')) $('.menu', me).hidden = !$('.menu', me).hidden; };
    document.addEventListener('click', (e) => { if (!me.contains(e.target)) $('.menu', me).hidden = true; });
    $('#logout').onclick = (e) => { e.preventDefault(); Session.clear(); location.href = 'index.html'; };
  }
}

function renderFooter() {
  const f = document.createElement('footer');
  f.className = 'footer';
  f.innerHTML = `<div class="wrap">
    <div><a class="brand" href="index.html"><span class="logo">🃏</span>OpenBricks</a><p style="max-width:320px">The Ninjago card collecting bot for Discord. Not affiliated with LEGO or Discord.</p><p>© ${new Date().getFullYear()} OpenBricks</p></div>
    <div class="cols">
      <div><h4>Bot</h4><a href="${OB.INVITE}" target="_blank" rel="noopener">Add to Discord</a><a href="commands.html">Commands</a><a href="leaderboards.html">Leaderboards</a></div>
      <div><h4>Account</h4><a href="dashboard.html">Dashboard</a><a href="dashboard.html#/collection">My collection</a><a href="${OB.SUPPORT}">Support server</a></div>
      <div><h4>Legal</h4><a href="terms.html">Terms</a><a href="privacy.html">Privacy</a><a href="mailto:${OB.EMAIL}">Contact</a></div>
    </div></div>`;
  document.body.append(f);
}
