// Card helpers shared by the home page, the card gallery and public profiles.
// Needs common.js ($, esc, fmt). Card data = data/cards.json (tools/build-data.js).
const CK = (() => {
  // key -> [badge, full name, print run]; order = rarest first
  const VERSION = { ghost: ['Ghost', 'Ghost', 25], shadow: ['Shadow', 'Shadow', 50], gold: ['Gold', 'Gold', 100], fullart: ['Full Art', 'Full Art', 150], holo: ['Holo', 'Holo Foil', 250] };
  const ORDER = Object.keys(VERSION);
  const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'];
  const tier = (c) => (RARITIES.includes(String(c.rarity).toLowerCase()) ? String(c.rarity).toLowerCase() : 'common');
  const img = (c, finish) => `cards/${c.id}${finish && c.versions.includes(finish) ? '-' + finish : ''}.webp`;
  const vName = (f) => (VERSION[f] ? VERSION[f][1] : 'Original');
  const serial = (n, f) => (n ? `#${n}${VERSION[f] ? ` / ${VERSION[f][2]}` : ''}` : '');
  let cache = null;
  const load = () => (cache ||= fetch('data/cards.json').then((r) => r.json()));
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The card leans toward the pointer. Plain 3D transform: the foil is already printed in the card image.
  function tilt(el, max = 14) {
    if (calm) return;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(900px) rotateY(${(x * max * 2).toFixed(1)}deg) rotateX(${(-y * max * 2).toFixed(1)}deg) scale(1.03)`;
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  }

  // Buttons that switch which version of a card an <img> shows. onPick(finish) is optional.
  function versionButtons(c, current, onPick) {
    const opts = [null, ...ORDER.slice().reverse().filter((f) => c.versions.includes(f))];
    return `<div class="vpick" role="group" aria-label="Card version">${opts.map((f) =>
      `<button type="button" data-v="${f || ''}" class="${(f || null) === (current || null) ? 'on' : ''}">${f ? VERSION[f][0] : 'Original'}</button>`).join('')}</div>`;
  }
  function wireVersions(root, c, imgEl, onPick) {
    root.querySelectorAll('.vpick button').forEach((b) => (b.onclick = () => {
      const f = b.dataset.v || null;
      root.querySelectorAll('.vpick button').forEach((x) => x.classList.toggle('on', x === b));
      imgEl.src = img(c, f);
      if (onPick) onPick(f);
    }));
  }

  // Preview window: big card, version switcher, how many of each exist. owned = [{finish, n, serial}] (profiles) or null.
  function modal(c, owned, startFinish = null) {
    const m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', c.name);
    const note = (f) => (f ? `Only ${VERSION[f][2]} of this ${VERSION[f][1]} will ever exist.` : 'The normal card. No print limit.');
    m.innerHTML = `<div class="box"><div class="stage"><img src="${img(c, startFinish)}" alt="${esc(c.name)}, ${esc(vName(startFinish))} version"></div>
      <div><h2 style="margin:0">${esc(c.name)}</h2>
      <p style="color:var(--mute);margin:4px 0 14px">${esc(c.title || '')}<br><span class="rar r-${tier(c)}">${esc(c.rarity)}</span> · ${esc(c.set)} · Card ${esc(c.number)} of ${esc(c.total)}</p>
      ${versionButtons(c, startFinish)}
      <p class="vnote" style="color:var(--mute);margin:12px 0 0">${note(startFinish)}</p>
      ${owned ? `<h3 class="sub-h">Owned</h3>${owned.map((r) => `<div class="toggle-row"><div><b>${esc(vName(r.finish))}</b><span class="m">×${fmt(r.n)}</span></div><span class="chip">best ${esc(serial(r.serial, r.finish) || '#?')}</span></div>`).join('')}` : ''}
      <p style="margin-top:16px;color:var(--mute)">Find it in packs: <code>!buypack</code></p>
      <button type="button" class="btn ghost small" data-close>Close</button></div></div>`;
    const big = m.querySelector('.stage img');
    wireVersions(m, c, big, (f) => { m.querySelector('.vnote').textContent = note(f); big.alt = `${c.name}, ${vName(f)} version`; });
    tilt(m.querySelector('.stage'), 9);
    const close = () => { m.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    m.onclick = (e) => { if (e.target === m || e.target.closest('[data-close]')) close(); };
    document.addEventListener('keydown', onKey);
    document.body.append(m);
    m.querySelector('[data-close]').focus();
    return m;
  }

  // ---- pack odds: the same numbers as the bot (commands/modules/zpacks.js). Change them there AND here.
  const CARD_WEIGHT = { common: 100, uncommon: 60, rare: 35, epic: 18, legendary: 8, mythical: 3 };
  const FINISH_ODDS = { ghost: 2, shadow: 1, gold: 3, holo: 8 }; // % per card, rarest first
  const FULLART_PACK_CHANCE = 20, PACK_SIZE = 10;
  const SYNODIC = 29.530588853 * 864e5, NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14);
  const moonAge = (ts = Date.now()) => (((ts - NEW_MOON_REF) % SYNODIC) + SYNODIC) % SYNODIC;
  const isFullMoon = (ts = Date.now()) => Math.abs(moonAge(ts) - SYNODIC / 2) < 864e5;
  function nextFullMoon(ts = Date.now()) { const start = ts - moonAge(ts) + SYNODIC / 2 - 864e5; return start > ts ? start : start + SYNODIC; }
  function weights(pool) {
    const n = {};
    for (const c of pool) n[tier(c)] = (n[tier(c)] || 0) + 1;
    const w = {};
    let prevW = Infinity, prevTotal = Infinity;
    for (const k of RARITIES) {
      if (!n[k]) continue;
      w[k] = Math.min(CARD_WEIGHT[k], prevW * 0.9, (prevTotal * 0.8) / n[k]);
      prevW = w[k]; prevTotal = w[k] * n[k];
    }
    return w;
  }
  function rollPack(pool, ghost = isFullMoon(), rnd = Math.random) {
    const w = weights(pool), total = pool.reduce((s, c) => s + w[tier(c)], 0);
    const pull = () => { let roll = rnd() * total; for (const c of pool) { roll -= w[tier(c)]; if (roll < 0) return c; } return pool[pool.length - 1]; };
    const finish = (c) => {
      let roll = rnd() * 100;
      for (const [k, pct] of Object.entries(FINISH_ODDS)) { if (k === 'ghost' && !ghost) continue; roll -= pct; if (roll < 0) return c.versions.includes(k) ? k : null; }
      return null;
    };
    const pack = Array.from({ length: PACK_SIZE }, () => { const c = pull(); return { c, finish: finish(c) }; });
    if (rnd() * 100 < FULLART_PACK_CHANCE) { const s = pack[Math.floor(rnd() * PACK_SIZE)]; if (s.c.versions.includes('fullart')) s.finish = 'fullart'; }
    return pack;
  }
  // chance (0..1) that one pulled card is of each rarity
  function rarityOdds(pool) {
    const w = weights(pool), total = pool.reduce((s, c) => s + w[tier(c)], 0), out = {};
    for (const c of pool) out[tier(c)] = (out[tier(c)] || 0) + w[tier(c)] / total;
    return out;
  }

  const ago = (ts) => { const s = Math.max(1, Math.round((Date.now() - ts) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
  return { VERSION, ORDER, RARITIES, tier, img, vName, serial, load, tilt, versionButtons, wireVersions, modal, rollPack, rarityOdds, weights, isFullMoon, nextFullMoon, ago, calm, PACK_SIZE };
})();
if (typeof module !== 'undefined') module.exports = CK; // self-check in Node
