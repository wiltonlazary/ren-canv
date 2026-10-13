// Shaped text set as Chrome sets it (test/fixtures/shaping.json, recorded by
// scripts/shaping-oracle.mjs): lines of joined Arabic, Hebrew with points,
// Devanagari (in a fallback typeface), Latin with marks, Latin alone and
// marks one typeface lacks (each cluster in the typeface that has it all),
// at 16 px in DejaVu Sans with Noto Sans Devanagari for what it lacks,
// measured by Faces (shaped where shape.js says a shaper sets them), are
// as wide as Chrome's rows, each grapheme cluster's box is where Chrome's
// is, and the caret before each stands where Chrome's does, within a 32nd
// of a pixel (Chrome's boxes are in 64ths).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Faces } from 'ren-canv';
import { Face, marks, xAt, Nearest } from '../src/text.js';

/** @typedef {{ name: string, text: string, width: number, clusters: number[][] }} Line */
const oracle = /** @type {{ recorded: string, lines: Line[] }} */ (JSON.parse(readFileSync(new URL('./fixtures/shaping.json', import.meta.url), 'utf8')));
const fonts = new Faces({ font: readFileSync(new URL('./fixtures/dejavu.ttf', import.meta.url)), fallback: [readFileSync(new URL('./fixtures/noto-devanagari.ttf', import.meta.url))] });
const m = new Face(fonts, 16, 0);
const NEAR = 1 / 32;

describe(`ren canv shaped text, as ${oracle.recorded} sets it`, () => {
  for (const { name, text, width, clusters } of oracle.lines)
    it(name, () => {
      const w = fonts.width(text, 16);
      assert.ok(Math.abs(w - width) <= NEAR, `${w.toFixed(4)} wide, Chrome ${width}`);
      /** @type {number[]} */
      const out = [];
      for (const [a, b, left, right, caret] of clusters) {
        const what = `${JSON.stringify(text.slice(a, b))} (${a})`;
        marks(m, text, 0, a, b, out);
        assert.equal(out.length, 2, `${what} is one box`);
        assert.ok(Math.abs(out[0] - left) <= NEAR && Math.abs(out[1] - right) <= NEAR, `${what} at [${out[0].toFixed(4)}, ${out[1].toFixed(4)}], Chrome [${left}, ${right}]`);
        if (caret !== undefined) {
          const x = xAt(m, text, 0, a);
          assert.ok(Math.abs(x - caret) <= NEAR, `the caret before ${what} at ${x.toFixed(4)}, Chrome ${caret}`);
          // A point just inside the cluster's start finds that caret.
          if (right > left) assert.equal(Nearest(m, text, 0, x === out[0] ? x + 0.25 : x - 0.25), a, `a point by the caret before ${what}`);
        }
      }
    });
});
