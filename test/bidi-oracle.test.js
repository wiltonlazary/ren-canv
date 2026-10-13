// Rows of mixed direction placed as Chrome places them (test/fixtures/bidi.json,
// recorded by scripts/bidi-oracle.mjs): each character of a line in DejaVu
// Sans at 16 px, measured by the font file's advances (Sfnt), is where
// Chrome's box for it is on a row of its block's direction (left to right,
// or right to left), within a 32nd of a pixel (Chrome's boxes are in
// 64ths): the bidirectional algorithm's visual order (text.js `order`), as
// the canvases draw, select and hit rows.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Sfnt } from 'ren-canv';
import { Face, marks, xAt, Nearest } from '../src/text.js';

/** @typedef {{ name: string, text: string, dir?: string, boxes: number[][] }} Line */
const oracle = /** @type {{ recorded: string, lines: Line[] }} */ (JSON.parse(readFileSync(new URL('./fixtures/bidi.json', import.meta.url), 'utf8')));
const m = new Face(new Sfnt(readFileSync(new URL('./fixtures/dejavu.ttf', import.meta.url))), 16, 0);
const NEAR = 1 / 32;

describe(`ren canv rows of mixed direction, as ${oracle.recorded} places them`, () => {
  for (const { name, text, dir, boxes } of oracle.lines)
    it(name, () => {
      const base = dir === 'rtl' ? 1 : 0;
      /** @type {number[]} */
      const out = [];
      for (let i = 0; i < text.length; i++) {
        const [left, right] = marks(m, text, 0, i, i + 1, out, base);
        assert.equal(out.length, 2, `${JSON.stringify(text[i])} (${i}) is one box`);
        assert.ok(Math.abs(left - boxes[i][0]) <= NEAR && Math.abs(right - boxes[i][1]) <= NEAR, `${JSON.stringify(text[i])} (${i}) at [${left.toFixed(3)}, ${right.toFixed(3)}], Chrome [${boxes[i]}]`);
        // The caret before it stands at its start edge, and a point inside its first half finds that caret.
        const rtl = left !== xAt(m, text, 0, i, base);
        assert.equal(xAt(m, text, 0, i, base), rtl ? right : left);
        assert.equal(Nearest(m, text, 0, rtl ? right - 0.5 : left + 0.5, base), i);
      }
    });
});
