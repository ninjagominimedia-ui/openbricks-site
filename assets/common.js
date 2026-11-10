// Shared bits for every page: header/footer, login session, API calls, small helpers.
const OB = window.OB_CONFIG;
// the dashboard can ban and delete: never let another site show these pages inside a frame and trick clicks onto them
if (window.top !== window.self) { try { window.top.location = window.self.location.href; } catch { document.documentElement.hidden = true; } }
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const avatarUrl = (id, hash, size = 64) => (hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=${size}` : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(id || 0) >> 22n) % 6}.png`);
// A saved avatar hash dies when someone changes their Discord picture (the login keeps it 7 days, leaderboards cache it),
// so a broken avatar falls back to Discord's default one instead of an empty box.
const freshAvatar = new Map(); // user id -> promise of their current avatar hash (or null)
document.addEventListener('error', (e) => {
  const img = e.target;
  const m = img.tagName === 'IMG' && /cdn\.discordapp\.com\/avatars\/(\d+)\/([^.]+)\./.exec(img.src);
  if (!m) return;
  const [, id, dead] = m;
  if (!freshAvatar.has(id)) freshAvatar.set(id, fetch(`${OB.API}/api/profile/${id}`).then((r) => (r.ok ? r.json() : null)).then((p) => p?.user?.avatar || null).catch(() => null));
  freshAvatar.get(id).then((hash) => { img.src = avatarUrl(id, hash && hash !== dead ? hash : null, 128); });
}, true);
const guildIcon = (id, hash, size = 128) => (hash ? `https://cdn.discordapp.com/icons/${id}/${hash}.png?size=${size}` : '');

// ---- session: the Worker hands us a signed token after Discord login (dashboard.html#session=...)
const Session = {
  get token() { return localStorage.getItem('ob_session'); },
  get user() {
    try { const p = JSON.parse(atob(this.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return p.exp > Date.now() ? { id: p.uid, name: p.name, avatar: p.avatar, admin: !!p.admin } : null; }
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
    <a class="brand" href="index.html"><img class="logo" src="assets/favicon.svg" alt="" width="34" height="34">OpenBricks</a>
    <nav class="links" id="navlinks">${link('cards.html', 'Cards', 'cards')}${link('commands.html', 'Commands', 'commands')}${link('leaderboards.html', 'Leaderboards', 'lb')}${link('dashboard.html', 'Dashboard', 'dash')}${link(OB.SUPPORT, 'Support', '')}<a class="mob-only" href="${OB.INVITE}" target="_blank" rel="noopener">Add to Discord</a></nav>
    <div class="right">
      <a class="btn small ghost desk-only" href="${OB.INVITE}" target="_blank" rel="noopener">Add to Discord</a>
      ${u ? `<div class="me" id="me"><img src="${avatarUrl(u.id, u.avatar)}" alt="">${esc(u.name)}
          <div class="menu" hidden><a href="dashboard.html#/servers">My servers</a><a href="dashboard.html#/collection">My collection</a><a href="#" id="logout">Log out</a></div></div>`
        : `<a class="btn small discord" href="${loginUrl()}">Login</a>`}
      <button class="burger" id="burger" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="navlinks"><span></span><span></span><span></span></button>
    </div></div>`;
  document.body.prepend(header);
  // phone menu: the links fold into a dropdown under the bar
  const burger = $('#burger'), links = $('#navlinks');
  const setOpen = (open) => { links.classList.toggle('open', open); burger.classList.toggle('open', open); burger.setAttribute('aria-expanded', open); burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); };
  burger.onclick = (e) => { e.stopPropagation(); setOpen(!links.classList.contains('open')); };
  links.onclick = () => setOpen(false);
  document.addEventListener('click', (e) => { if (!header.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  const me = $('#me');
  if (me) {
    me.onclick = (e) => { if (!e.target.closest('.menu')) $('.menu', me).hidden = !$('.menu', me).hidden; };
    document.addEventListener('click', (e) => { if (!me.contains(e.target)) $('.menu', me).hidden = true; });
    $('#logout').onclick = (e) => { e.preventDefault(); Session.clear(); location.href = 'index.html'; };
  }
}

// elements with class "reveal" fade up the first time they scroll into view (style.css keeps them visible without JS)
function revealOnScroll() {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach((el) => el.classList.add('in')); return; }
  const io = new IntersectionObserver((list) => list.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
  els.forEach((el) => io.observe(el));
}
// counts a number up from 0 once (plain value when motion is off or the number is missing)
function countUp(el, to, ms = 900) {
  if (to == null) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); el.textContent = fmt(Math.round(to * (1 - (1 - k) ** 3))); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

function renderFooter() {
  const f = document.createElement('footer');
  f.className = 'footer';
  f.innerHTML = `<div class="wrap">
    <div><a class="brand" href="index.html"><img class="logo" src="assets/favicon.svg" alt="" width="34" height="34">OpenBricks</a><p style="max-width:320px">The Ninjago card collecting bot for Discord. Not affiliated with LEGO or Discord.</p><p>&copy; ${new Date().getFullYear()} OpenBricks</p></div>
    <div class="cols">
      <div><h4>Bot</h4><a href="${OB.INVITE}" target="_blank" rel="noopener">Add to Discord</a><a href="cards.html">Cards</a><a href="commands.html">Commands</a><a href="leaderboards.html">Leaderboards</a></div>
      <div><h4>Account</h4><a href="dashboard.html">Dashboard</a><a href="dashboard.html#/collection">My collection</a><a href="${OB.SUPPORT}">Support server</a></div>
      <div><h4>Legal</h4><a href="terms.html">Terms</a><a href="privacy.html">Privacy</a><a href="mailto:${OB.EMAIL}">Contact</a></div>
    </div></div>`;
  document.body.append(f);
}
