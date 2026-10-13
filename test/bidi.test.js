// The Unicode Bidirectional Algorithm against Unicode 16.0.0's own cases (a
// subset of BidiCharacterTest.txt in fixtures/bidi-characters.txt: levels
// after L1 and the visual order of L2), and the pieces a renderer draws.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, R, AL, EN, ET, AN, ON, NSM, BN, WS, B, S, LRI, PDI, classOf, rtl, paragraph, levels, line, order, runs, mirror, visual } from '../src/bidi.js';

/**
 * Levels, after L1 over the whole text as one line, and the visual order.
 * @param {string} text @param {number} base
 */
function resolve(text, base) {
  const para = base < 0 ? paragraph(text) : base;
  const lv = line(levels(text, base), text, 0, text.length, para);
  return { para, lv, order: order(lv, text) };
}

/** The runs as [start, end, level] arrays. @param {Int32Array} flat */
const triples = flat => Array.from({ length: flat.length / 3 }, (_, i) => Array.from(flat.subarray(i * 3, i * 3 + 3)));

const CASES = readFileSync(new URL('fixtures/bidi-characters.txt', import.meta.url), 'utf8')
  .split('\n')
  .filter(row => row && !row.startsWith('#'));

describe('ren canv bidi', () => {
  it("passes every case of the BidiCharacterTest.txt subset: paragraph level, levels and visual order", () => {
    assert.ok(CASES.length > 3000, `${CASES.length} cases`);
    /** @type {string[]} */
    const failed = [];
    for (const row of CASES) {
      const [cps, dir, para, want, wantOrder] = row.split(';');
      const points = cps.trim().split(' ').map(h => parseInt(h, 16));
      const text = String.fromCodePoint(...points);
      const got = resolve(text, dir === '2' ? -1 : Number(dir));
      // The code point each UTF-16 unit starts, -1 for a low surrogate.
      /** @type {number[]} */
      const at = [];
      points.forEach((p, i) => { at.push(i); if (p > 0xffff) at.push(-1); });
      const levelsOf = want.trim().split(' ');
      const gotLevels = at.filter(i => i >= 0).map(i => (levelsOf[i] === 'x' ? 'x' : String(got.lv[at.indexOf(i)])));
      const gotOrder = Array.from(got.order, u => at[u]).filter(i => i >= 0 && levelsOf[i] !== 'x');
      if (got.para !== Number(para) || gotLevels.join(' ') !== levelsOf.join(' ') || gotOrder.join(' ') !== wantOrder.trim()) {
        failed.push(`${row}\n  got ${got.para}; ${gotLevels.join(' ')}; ${gotOrder.join(' ')}`);
      }
    }
    assert.deepEqual(failed, []);
  });

  it('reads the classes of Unicode 16.0.0, unassigned code points by their defaults', () => {
    assert.equal(classOf(0x41), L);
    assert.equal(classOf(0x5d0), R);
    assert.equal(classOf(0x627), AL);
    assert.equal(classOf(0x30), EN);
    assert.equal(classOf(0x660), AN);
    assert.equal(classOf(0x28), ON);
    assert.equal(classOf(0x300), NSM);
    assert.equal(classOf(0x200d), BN);
    assert.equal(classOf(0x20), WS);
    assert.equal(classOf(0x2029), B);
    assert.equal(classOf(0x9), S);
    assert.equal(classOf(0x2066), LRI);
    assert.equal(classOf(0x2069), PDI);
    assert.equal(classOf(0x10900), R, 'Phoenician, above the BMP');
    assert.equal(classOf(0x1f600), ON, 'an emoji');
    assert.equal(classOf(0x5ff), R, 'unassigned in Hebrew');
    assert.equal(classOf(0x7bf), AL, 'unassigned in Thaana');
    assert.equal(classOf(0x20cf), ET, 'unassigned in Currency Symbols: ET');
    assert.equal(classOf(0xe0fff), BN, 'unassigned default ignorable');
    assert.equal(classOf(0x10ffff), BN, 'a noncharacter');
    assert.equal(classOf(0x50000), L);
  });

  it('tells a right-to-left text from a left-to-right one', () => {
    assert.equal(rtl('hello'), false);
    assert.equal(rtl(''), false);
    assert.equal(rtl('naïve café 日本 😀'), false);
    assert.equal(rtl('shalom שלום'), true);
    assert.equal(rtl('مرحبا'), true);
    assert.equal(rtl('a⁧b'), true, 'an RLI');
    assert.equal(rtl('a⁨b'), true, 'an FSI');
    assert.equal(rtl('a‮b'), true, 'an RLO');
    assert.equal(rtl('𐤀'), true, 'Phoenician, a surrogate pair');
    assert.equal(rtl('\ud802'), false, 'a lone high surrogate');
  });

  it('decides the paragraph level by the first strong character outside isolates', () => {
    assert.equal(paragraph('abc אבג'), 0);
    assert.equal(paragraph('123 אבג abc'), 1);
    assert.equal(paragraph('⁦אבג⁩ abc'), 0);
    assert.equal(paragraph('123'), 0);
  });

  it('cuts a mixed line into three runs, the right-to-left one between at level 1', () => {
    const text = 'abc אבג def';
    const lv = line(levels(text, 0), text, 0, text.length, 0);
    assert.deepEqual(triples(runs(lv)), [[0, 4, 0], [4, 7, 1], [7, 11, 0]]);
    assert.deepEqual(Array.from(order(lv, text)), [0, 1, 2, 3, 6, 5, 4, 7, 8, 9, 10]);
    assert.equal(visual(text, lv), 'abc גבא def');
  });

  it('sets European numbers in a right-to-left run at level 2, read left to right', () => {
    const text = 'אב 123 גד';
    const lv = line(levels(text, 1), text, 0, text.length, 1);
    assert.deepEqual(Array.from(lv), [1, 1, 1, 2, 2, 2, 1, 1, 1]);
    assert.deepEqual(triples(runs(lv)), [[6, 9, 1], [3, 6, 2], [0, 3, 1]]);
    assert.equal(visual(text, lv), 'דג 123 בא');
  });

  it('keeps a surrogate pair together, high then low, in a reversed run', () => {
    // Two Phoenician letters (R) between Hebrew ones.
    const text = 'א𐤀𐤁ב';
    const lv = line(levels(text, 0), text, 0, text.length, 0);
    assert.deepEqual(Array.from(lv), [1, 1, 1, 1, 1, 1]);
    assert.deepEqual(Array.from(order(lv, text)), [5, 3, 4, 1, 2, 0]);
    assert.equal(visual(text, lv), 'ב𐤁𐤀א');
  });

  it('mirrors brackets in a right-to-left run', () => {
    assert.equal(mirror(0x28), 0x29);
    assert.equal(mirror(0x3c), 0x3e);
    assert.equal(mirror(0x61), 0x61);
    const text = 'א(ב)ג';
    const lv = line(levels(text, 1), text, 0, text.length, 1);
    assert.deepEqual(Array.from(lv), [1, 1, 1, 1, 1]);
    assert.equal(visual(text, lv), 'ג(ב)א');
  });

  it('resets separators and trailing whitespace to the paragraph level (L1), without changing the paragraph levels', () => {
    const text = 'אב\tגד  ';
    const all = levels(text, 0);
    const lv = line(all, text, 0, text.length, 0);
    assert.deepEqual(Array.from(lv), [1, 1, 0, 1, 1, 0, 0]);
    assert.deepEqual(Array.from(all), [1, 1, 1, 1, 1, 0, 0]);
    // A line from the middle of the paragraph: its own end resets.
    const part = 'אב גד הו';
    const mid = line(levels(part, 1), part, 3, 6, 1);
    assert.deepEqual(Array.from(mid), [1, 1, 1]);
  });

  it('gives what X9 removes the level of the character before it', () => {
    const text = 'א‍ב';
    assert.deepEqual(Array.from(levels(text, 0)), [1, 1, 1]);
    assert.deepEqual(Array.from(levels('‫a', 0)), [0, 2]);
  });

  it('resolves an empty text', () => {
    assert.deepEqual(Array.from(levels('', -1)), []);
    assert.deepEqual(Array.from(runs(new Uint8Array(0))), []);
    assert.equal(visual('', new Uint8Array(0)), '');
  });

  it('resolves Arabic letters as right-to-left after a left-to-right start', () => {
    const text = 'abc مرحبا';
    assert.equal(classOf(text.charCodeAt(4)), AL);
    const lv = line(levels(text, -1), text, 0, text.length, paragraph(text));
    assert.deepEqual(Array.from(lv), [0, 0, 0, 0, 1, 1, 1, 1, 1]);
  });
});
