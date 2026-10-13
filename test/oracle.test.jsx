// The portable box model laid out as Chrome lays out the markup ren-dom
// writes (test/fixtures/layout.json, recorded by scripts/layout-oracle.mjs):
// each case of test/fixtures/layout-cases.jsx on a Document of its own,
// measured in the same font (Sfnt over DejaVu Sans), gives every item the
// border box Chrome gave its element, within a 64th of a pixel. A
// case Chrome lays out otherwise on purpose is in KNOWN, with the reason;
// it must still differ, so a change that closes the gap removes it there.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Document, Sfnt, render, loadLayout } from 'ren-canv';
import { cases } from './fixtures/layout-cases.jsx';

/** @typedef {{ name: string, boxes: number[][] }} Case */
const oracle = /** @type {{ recorded: string, cases: Case[] }} */ (JSON.parse(readFileSync(new URL('./fixtures/layout.json', import.meta.url), 'utf8')));

/** The cases laid out otherwise than in Chrome, by name: why. */
const KNOWN = /** @type {Record<string, string>} */ ({});

/** How far a box may be from Chrome's: under a 64th of a pixel (a LayoutUnit, where Chrome floors a fraction of a track). */
const NEAR = 1 / 64;

await loadLayout();
const font = new Sfnt(readFileSync(new URL('./fixtures/dejavu.ttf', import.meta.url)));

/** The border boxes of a view's items (text and markers have none) on a page 400 by 600, relative to it, in order. @param {() => any} view */
function boxesOf(view) {
  const doc = new Document(font, { width: 400, height: 600 });
  render(view, doc);
  doc.commands();
  /** @type {number[][]} */
  const out = [];
  /** @param {any} item @param {number} x @param {number} y */
  const walk = (item, x, y) => {
    for (let c = item.first; c !== null; c = c.next) {
      if (c.kind === 8 || c.kind === 9) continue;
      doc.boxes.fix(c);
      out.push([x + c.x, y + c.y, c.w, c.h]);
      walk(c, x + c.x, y + c.y);
    }
  };
  walk(doc.root, 0, 0);
  doc.close();
  return out;
}

/** What differs between the boxes laid out and Chrome's ('' for nothing). @param {number[][]} got @param {number[][]} want */
function differ(got, want) {
  if (got.length !== want.length) return `${got.length} boxes, Chrome ${want.length}`;
  const out = [];
  for (let i = 0; i < got.length; i++) if (got[i].some((v, j) => !(Math.abs(v - want[i][j]) <= NEAR))) out.push(`#${i} ${JSON.stringify(got[i].map(v => Math.round(v * 1000) / 1000))}, Chrome ${JSON.stringify(want[i])}`);
  return out.join('; ');
}

describe(`ren canv layout, as ${oracle.recorded} lays out ren-dom's markup`, () => {
  it('records every case', () => {
    assert.deepEqual(oracle.cases.map(c => c.name), cases.map(c => c.name), 'record the oracle again (scripts/layout-oracle.mjs)');
    for (const name of Object.keys(KNOWN)) assert.ok(cases.some(c => c.name === name), `KNOWN names no case: ${name}`);
  });

  for (const [i, c] of cases.entries())
    it(c.name, () => {
      const diff = differ(boxesOf(c.view), oracle.cases[i].boxes);
      if (c.name in KNOWN) assert.notEqual(diff, '', `laid out as Chrome now: take it out of KNOWN (${KNOWN[c.name]})`);
      else assert.equal(diff, '');
    });
});
