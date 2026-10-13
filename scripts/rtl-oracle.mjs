// Records how Chrome renders right to left what test/rtl-oracle.test.jsx
// checks a Document against: the views of test/fixtures/rtl-cases.jsx,
// rendered by ren-dom (the markup and CSS the DOM renderer writes for them),
// each on its own page 400 wide, in DejaVu Sans (test/fixtures/dejavu.ttf,
// kerning off):
// - each sticky case's Scroll scrolled to each of its offsets, and the
//   border box of every primitive's element ([data-ren], in document order)
//   then, relative to its page: where a sticky item is held;
// - each cut Label set a character a run, each run in a color of its own,
//   and a screenshot of it: each character's box (a Range over it), whether
//   any pixel shows its color (the characters the ellipsis hides show none),
//   and the box of the ellipsis' ink on each line (the Label's black), with
//   where the ink of an ellipsis alone starts from its origin;
// - each Edit's text-align as computed, as the side it sets its text on
//   (0 left, 1 center, 2 right), and those of a bare input, textarea and
//   button under a centered block.
// ren-dom is bundled from its checkout beside this one (the workspace's
// layout), or from REN_DOM (its src/index.js). Run it under the
// machine-wide Chrome lock and commit what it writes:
//   flock "$HOME/.cache/chrome-bench.lock" node scripts/rtl-oracle.mjs test/fixtures/rtl.json
import { copyFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { withChrome } from './chrome.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dom = process.env.REN_DOM ?? join(root, '../../../ren-dom/wtree/_repo_/src/index.js');
/** A cut Label's page height. */
const TALL = 120;
const page = `
import { Root } from 'ren-core';
import { $dom } from 'ren-dom';
import { sticky, clipped, fields, cut, CLIP } from './test/fixtures/rtl-cases.jsx';
const pageOf = height => {
  const page = document.createElement('div');
  page.style.cssText = 'position:relative;width:400px;height:' + height + 'px;overflow:hidden';
  document.body.appendChild(page);
  return page;
};
const at = v => Math.round(v * 1000) / 1000;
const boxes = page => {
  const o = page.getBoundingClientRect();
  return [...page.querySelectorAll('[data-ren]')].map(e => {
    const r = e.getBoundingClientRect();
    return [at(r.x - o.x), at(r.y - o.y), at(r.width), at(r.height)];
  });
};
const stickyPages = sticky.map((c, i) => {
  const page = pageOf(200);
  Root({ id: 'sticky' + i, target: page, renderer: $dom(document), children: c.view() });
  return page;
});
const clippedPages = clipped.map((c, i) => {
  const page = pageOf(${TALL});
  // Character k in red 0, green 4 + 5k, blue 255: a blend with the white page has red, so a pixel of that color is the character's own.
  const colors = [...c.text].map((_, k) => (0xff0000ff | ((4 + 5 * k) << 8)) >>> 0);
  Root({ id: 'clipped' + i, target: page, renderer: $dom(document), children: cut(c, colors)() });
  return page;
});
const fieldPages = fields.map((c, i) => {
  const page = pageOf(200);
  Root({ id: 'field' + i, target: page, renderer: $dom(document), children: c.view() });
  return page;
});
const native = pageOf(100);
native.innerHTML = '<div style="text-align:center"><input><textarea></textarea><button>x</button></div>';
const alone = pageOf(80);
alone.innerHTML = '<span style="font-size:' + CLIP + 'px;color:#000;position:absolute;left:100px;top:10px">\\u2026</span>';
const side = e => {
  const s = getComputedStyle(e);
  const rtl = s.direction === 'rtl';
  return { center: 1, left: 0, right: 2, start: rtl ? 2 : 0, end: rtl ? 0 : 2, '-webkit-center': 1, '-webkit-left': 0, '-webkit-right': 2 }[s.textAlign];
};
window.record = () => {
  const out = { sticky: [], clipped: [], fields: [], native: [] };
  sticky.forEach((c, i) => {
    const scroll = stickyPages[i].querySelector('[data-ren="Scroll"]');
    const down = scroll.scrollWidth <= scroll.clientWidth;
    const at = c.scrolls.map(to => {
      if (down) scroll.scrollTop = to;
      else scroll.scrollLeft = to;
      return { scroll: down ? scroll.scrollTop : scroll.scrollLeft, boxes: boxes(stickyPages[i]) };
    });
    out.sticky.push({ name: c.name, at });
  });
  clipped.forEach((c, i) => {
    const label = clippedPages[i].querySelector('[data-ren="Label"]');
    const o = label.getBoundingClientRect();
    const p = clippedPages[i].getBoundingClientRect();
    const walk = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    const chars = [];
    for (let node = walk.nextNode(); node !== null; node = walk.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      chars.push([node.data, at(r.left - o.left), at(r.right - o.left), at(r.top - o.top)]);
    }
    out.clipped.push({ name: c.name, label: [at(o.left - p.left), at(o.top - p.top), at(o.width), at(o.height)], page: at(p.top), chars });
  });
  fields.forEach((c, i) => out.fields.push({ name: c.name, sides: [...fieldPages[i].querySelectorAll('[data-ren="Edit"]')].map(side) }));
  out.native = [...native.querySelectorAll('input, textarea, button')].map(e => ({ tag: e.localName, side: side(e) }));
  const r = document.createRange();
  r.selectNodeContents(alone.firstChild);
  const box = r.getBoundingClientRect();
  out.alone = { page: at(alone.getBoundingClientRect().top), left: at(box.left) };
  return out;
};
`;
const bundle = await build({ stdin: { contents: page, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', jsxImportSource: 'ren-core', alias: { 'ren-dom': dom }, logLevel: 'error' });
const js = bundle.outputFiles[0].text;

/** An 8-bit RGB or RGBA PNG's pixels, 4 bytes each. @param {Buffer} png */
function decode(png) {
  let o = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  /** @type {Buffer[]} */
  const data = [];
  while (o < png.length) {
    const length = png.readUInt32BE(o);
    const kind = png.toString('latin1', o + 4, o + 8);
    const body = png.subarray(o + 8, o + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || (body[9] !== 2 && body[9] !== 6) || body[12] !== 0) throw new Error('an 8-bit RGB or RGBA PNG, not interlaced');
      type = body[9];
    } else if (kind === 'IDAT') data.push(body);
    o += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const bpp = type === 6 ? 4 : 3;
  const stride = width * bpp;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[y * stride + x - bpp] : 0;
      const b = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? rows[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const add = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      rows[y * stride + x] = (line[x] + add) & 255;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = rows[i * bpp];
    out[i * 4 + 1] = rows[i * bpp + 1];
    out[i * 4 + 2] = rows[i * bpp + 2];
    out[i * 4 + 3] = 255;
  }
  return { width, height, pixels: out };
}

await withChrome(async ({ send, evaluate, profile }) => {
  copyFileSync(join(root, 'test/fixtures/dejavu.ttf'), join(profile, 'dejavu.ttf'));
  const file = join(profile, 'rtl.html');
  writeFileSync(file, `<!doctype html><html><head><style>@font-face{font-family:DejaVu;src:url(dejavu.ttf)}body{margin:0;font-family:DejaVu;font-kerning:none}</style></head><body><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`);
  await send('Page.navigate', { url: `file://${file}` });
  // Rendered once the script has run and the font has loaded (withChrome's deadline ends a page that never does).
  while ((await evaluate('typeof record === "function"')) !== true);
  await evaluate('document.fonts.load("16px DejaVu").then(() => document.fonts.ready).then(() => 1)');
  const height = await evaluate('document.body.scrollHeight');
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height, deviceScaleFactor: 1, mobile: false });
  const measured = await evaluate('record()');
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 400, height, scale: 1 }, captureBeyondViewport: true });
  const { width, pixels } = decode(Buffer.from(shot.result.data, 'base64'));
  /** The ink in a box of the page: the characters' colors seen (counts by index), and the black's extent on each line. @param {number} x0 @param {number} y0 @param {number} w @param {number} h @param {number} line */
  const ink = (x0, y0, w, h, line) => {
    /** @type {Record<number, number>} */
    const seen = {};
    /** @type {number[][]} */
    const black = [];
    for (let y = Math.max(0, Math.floor(y0)); y < Math.ceil(y0 + h); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x0 + w)); x++) {
        const o = (y * width + x) * 4;
        const [r, g, b] = [pixels[o], pixels[o + 1], pixels[o + 2]];
        if (r <= 2 && b >= 253) {
          const i = Math.round((g - 4) / 5);
          if (Math.abs(g - (4 + 5 * i)) <= 1) seen[i] = (seen[i] ?? 0) + 1;
        } else if (r < 140 && Math.abs(r - g) <= 6 && Math.abs(g - b) <= 6) {
          const k = Math.floor((y - y0) / line);
          const e = (black[k] ??= [Infinity, -Infinity, Infinity, -Infinity]);
          e[0] = Math.min(e[0], x - x0);
          e[1] = Math.max(e[1], x + 1 - x0);
          e[2] = Math.min(e[2], y - y0);
          e[3] = Math.max(e[3], y + 1 - y0);
        }
      }
    return { seen, black };
  };
  const LINE = 40;
  const clipped = measured.clipped.map((/** @type {any} */ c) => {
    const [lx, ly, lw, lh] = c.label;
    // The Label's box: Chrome clips its text and its ellipsis to it.
    const { seen, black } = ink(lx, c.page + ly, lw, lh, LINE);
    return { name: c.name, width: lw, chars: c.chars.map((/** @type {any[]} */ [ch, left, right, top], /** @type {number} */ i) => [ch, left, right, top, (seen[i] ?? 0) >= 4 ? 1 : 0]), ellipsis: black.map((e, k) => (e === undefined || e === null ? null : [k, ...e])).filter(e => e !== null) };
  });
  const a = measured.alone;
  const lone = ink(0, a.page, 400, 80, 80).black[0];
  // Where an ellipsis' ink starts right of its origin (its box's left).
  const offset = lone[0] - a.left;
  const recorded = (await send('Browser.getVersion')).result.product;
  const lines = [
    `{"recorded":${JSON.stringify(recorded)},"ellipsisInk":${offset},`,
    `"sticky":[\n${measured.sticky.map((/** @type {any} */ c) => JSON.stringify(c)).join(',\n')}\n],`,
    `"clipped":[\n${clipped.map((/** @type {any} */ c) => JSON.stringify(c)).join(',\n')}\n],`,
    `"fields":[\n${measured.fields.map((/** @type {any} */ c) => JSON.stringify(c)).join(',\n')}\n],`,
    `"native":${JSON.stringify(measured.native)}}`,
  ];
  writeFileSync(process.argv[2], lines.join('\n') + '\n');
  console.log('recorded', measured.sticky.length, 'sticky,', clipped.length, 'cut and', measured.fields.length, 'field cases with', recorded);
});
