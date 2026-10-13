// Right to left as Chrome renders the markup ren-dom writes
// (test/fixtures/rtl.json, recorded by scripts/rtl-oracle.mjs from the views
// of test/fixtures/rtl-cases.jsx), each on a Document measured in the same
// font (Sfnt over DejaVu Sans):
// - a sticky item in a Scroll scrolled across (`scrollLeft` below 0 right to
//   left) or down is held where Chrome holds it: every item's
//   `getBoundingClientRect()` within a 64th of a pixel of Chrome's box;
// - a Label cut by `ellipsis` or `lines` shows the characters Chrome shows,
//   where it shows them, and its ellipsis where Chrome draws it (within a
//   pixel: Chrome's is read from its ink in a screenshot), as one text and
//   as a run a character;
// - an Edit sets its text on the side Chrome's field does under its
//   parent's `textAlign` (a field takes only its own, as a button does).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Document, Sfnt, render, loadLayout } from 'ren-canv';
import { RTL } from 'ren-canv/backend';
import { SCROLL, EDIT } from '../src/scene.js';
import { sticky, clipped, fields, cut } from './fixtures/rtl-cases.jsx';

/**
 * @typedef {{ name: string, at: { scroll: number, boxes: number[][] }[] }} Sticky
 * @typedef {{ name: string, width: number, chars: [string, number, number, number, number][], ellipsis: number[][] }} Clipped
 */
const oracle = /** @type {{ recorded: string, ellipsisInk: number, sticky: Sticky[], clipped: Clipped[], fields: { name: string, sides: number[] }[], native: { tag: string, side: number }[] }} */ (
  JSON.parse(readFileSync(new URL('./fixtures/rtl.json', import.meta.url), 'utf8'))
);

await loadLayout();
const font = new Sfnt(readFileSync(new URL('./fixtures/dejavu.ttf', import.meta.url)));
/** A Chrome box's edge: within a 64th of a pixel (a LayoutUnit). */
const NEAR = 1 / 64;
/** A character drawn where Chrome's is: Chrome's are a run a character, each snapped to its 64th. */
const PLACED = 1 / 2;
/** The ellipsis where Chrome's ink says it is: whole pixels. */
const INKED = 1;
/** The height of a cut Label's line: 32 px at a line height of 1.25. */
const LINE = 40;

/** Items in document order, text and markers aside (they have no element). @param {any} item @param {any[]} out */
const walk = (item, out = []) => {
  for (let c = item.first; c !== null; c = c.next) {
    if (c.kind === 8 || c.kind === 9) continue;
    out.push(c);
    walk(c, out);
  }
  return out;
};

describe(`ren canv right to left, as ${oracle.recorded} renders ren-dom's markup`, () => {
  it('records every case', () => {
    assert.deepEqual(oracle.sticky.map(c => c.name), sticky.map(c => c.name), 'record the oracle again (scripts/rtl-oracle.mjs)');
    assert.deepEqual(oracle.clipped.map(c => c.name), clipped.map(c => c.name));
    assert.deepEqual(oracle.fields.map(c => c.name), fields.map(c => c.name));
  });

  describe('a sticky item, held as Chrome holds it', () => {
    for (const [i, c] of sticky.entries())
      it(c.name, () => {
        const doc = new Document(font, { width: 400, height: 200 });
        render(c.view, doc);
        doc.present();
        const items = walk(doc.root);
        const scroll = items.find(n => n.kind === SCROLL);
        for (const [k, to] of c.scrolls.entries()) {
          const want = oracle.sticky[i].at[k];
          if (scroll.axis === 1) scroll.scrollLeft = to;
          else scroll.scrollTop = to;
          doc.present();
          assert.equal(scroll.axis === 1 ? scroll.scrollLeft : scroll.scrollTop, want.scroll, `scrolled to ${to}`);
          const got = items.map(n => {
            const b = n.getBoundingClientRect();
            return [b.x, b.y, b.width, b.height];
          });
          assert.equal(got.length, want.boxes.length);
          const off = got.flatMap((b, j) => (b.some((v, e) => !(Math.abs(v - want.boxes[j][e]) <= NEAR)) ? [`#${j} ${JSON.stringify(b)}, Chrome ${JSON.stringify(want.boxes[j])}`] : []));
          assert.deepEqual(off, [], `scrolled to ${to}`);
        }
        doc.close();
      });
  });

  describe('a cut Label: the characters Chrome shows, and its ellipsis', () => {
    for (const [i, c] of clipped.entries())
      for (const runs of [false, true])
        it(`${c.name}${runs ? ', a run a character' : ''}`, () => {
          const want = oracle.clipped[i];
          const doc = new Document(font, { width: 400, height: 120 });
          render(cut(c, runs ? [...c.text].map((_, k) => (0xff0000ff | ((4 + 5 * k) << 8)) >>> 0) : null), doc);
          doc.present();
          const label = walk(doc.root).find(n => n.kind !== SCROLL && n.rows !== null);
          const box = label.getBoundingClientRect();
          assert.equal(box.width, want.width);
          // Each character drawn, from the Label's left, by its row's baseline: an RTL piece is drawn from its right.
          /** @type {Map<number, [string, number][]>} */
          const rows = new Map();
          for (const k of doc.commands()) {
            if (k[0] !== 'text') continue;
            const [, text, x, y, size, , flags] = k;
            const rtl = (flags & RTL) !== 0;
            let at = x - box.x;
            const row = rows.get(y) ?? [];
            rows.set(y, row);
            for (const ch of text) {
              const w = font.width(ch, size, flags & ~RTL);
              row.push([ch, rtl ? at - w : at]);
              at += rtl ? -w : w;
            }
          }
          const drawn = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row.sort((a, b) => a[1] - b[1]));
          // Chrome's rows: its characters that show, left to right, and its ellipsis' origin.
          /** @type {[string, number][][]} */
          const shown = [];
          for (const [ch, left, , top, seen] of want.chars) if (seen) (shown[Math.round(top / LINE)] ??= []).push([ch, left]);
          for (const e of want.ellipsis) (shown[e[0]] ??= []).push(['…', e[1] - oracle.ellipsisInk]);
          const chrome = [...shown].map(row => (row ?? []).sort((a, b) => a[1] - b[1]));
          while (chrome.length > 0 && chrome[chrome.length - 1].length === 0) chrome.pop();
          assert.equal(drawn.length, chrome.length, 'rows drawn');
          for (let r = 0; r < chrome.length; r++) {
            const ink = drawn[r].filter(([ch]) => ch !== ' ');
            assert.equal(ink.map(([ch]) => ch).join(''), chrome[r].map(([ch]) => ch).join(''), `row ${r}, left to right`);
            for (let k = 0; k < ink.length; k++) {
              const near = ink[k][0] === '…' ? INKED : PLACED;
              assert.ok(Math.abs(ink[k][1] - chrome[r][k][1]) <= near, `row ${r}: ${ink[k][0]} at ${ink[k][1]}, Chrome ${chrome[r][k][1]}`);
            }
          }
          doc.close();
        });
  });

  it("starts a browser's field at its start under a parent's alignment, a button centered", () => {
    assert.deepEqual(oracle.native.map(n => [n.tag, n.side]), [['input', 0], ['textarea', 0], ['button', 1]]);
  });

  describe("an Edit's side, as Chrome's field takes it", () => {
    for (const [i, c] of fields.entries())
      it(c.name, () => {
        const doc = new Document(font, { width: 400, height: 200 });
        render(c.view, doc);
        doc.present();
        assert.deepEqual(walk(doc.root).filter(n => n.kind === EDIT).map(n => n.r.textAlign), oracle.fields[i].sides);
        doc.close();
      });
  });
});
