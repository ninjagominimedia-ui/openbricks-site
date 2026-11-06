// Builds the site's data from the bot folder. Run after changing commands or importing new pack cards:
//   node tools/build-data.js ["path to OpenBricks Bot"]
// Writes data/commands.json (from the bot's !help registry), data/cards.json (from data/pack-cards.json)
// and cards/<id>[-version].webp (small copies of the pack card images, made with Card Maker's canvas).
// Images newer than their source are skipped, so re-runs only read the A: drive.
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..');
const BOT = process.argv[2] || 'A:/Python/NFC BOTTTT/OpenBricks Bot';
const { createCanvas, loadImage } = require(path.join(BOT, '..', 'Card Maker', 'node_modules', '@napi-rs', 'canvas'));
const THUMB_W = 310; // half size: sharp enough for the collection grid, ~30 KB each

(async () => {
  // admin-only commands stay off the public page
  const { CATEGORIES } = require(path.join(BOT, 'commands', 'registry-data.js'));
  const commands = CATEGORIES.filter((c) => c.name !== 'Administration').map((c) => ({
    name: c.name, icon: c.icon, commands: c.commands.map(([usage, desc, aliases]) => ({ usage, desc, aliases: aliases || [] })),
  }));
  fs.mkdirSync(path.join(SITE, 'data'), { recursive: true });
  fs.writeFileSync(path.join(SITE, 'data', 'commands.json'), JSON.stringify(commands));

  const packCards = JSON.parse(fs.readFileSync(path.join(BOT, 'data', 'pack-cards.json'), 'utf8'));
  const cards = [];
  let made = 0;
  fs.mkdirSync(path.join(SITE, 'cards'), { recursive: true });
  for (const c of packCards) {
    const sources = { '': c.image, ...Object.fromEntries(Object.entries(c.finishes || {}).map(([k, v]) => ['-' + k, v])) };
    const versions = [];
    for (const [suffix, rel] of Object.entries(sources)) {
      const src = path.join(BOT, rel), out = path.join(SITE, 'cards', `${c.id}${suffix}.webp`);
      if (!fs.existsSync(src)) continue;
      if (suffix) versions.push(suffix.slice(1));
      if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(src).mtimeMs) continue;
      const img = await loadImage(src), h = Math.round(img.height * THUMB_W / img.width);
      const cv = createCanvas(THUMB_W, h);
      cv.getContext('2d').drawImage(img, 0, 0, THUMB_W, h);
      fs.writeFileSync(out, cv.toBuffer('image/webp', 82));
      made++;
    }
    cards.push({ id: c.id, name: c.name, title: c.title, rarity: c.rarity, set: c.set, number: c.number, total: c.total, versions });
  }
  fs.writeFileSync(path.join(SITE, 'data', 'cards.json'), JSON.stringify(cards));
  console.log(`commands: ${commands.reduce((s, c) => s + c.commands.length, 0)} in ${commands.length} modules · cards: ${cards.length} · images made: ${made}`);
})().catch((e) => { console.error(e); process.exit(1); });
