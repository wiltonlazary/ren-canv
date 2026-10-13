// Caret steps, Backspace and Delete in an Edit against Chrome's own, as
// recorded from a textarea in headless Chrome (fixtures/editing.json, made
// by scripts/editing-oracle.mjs): flags, ZWJ chains, variation selectors,
// keycaps, decomposed accents, Indic conjuncts (one longer than the window
// the caret reads), Hangul, Thai, and clusters across that window's edge.
// A change to stepping or erasing runs against the same recorded answers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { View, Edit } from 'ren-core';
import { Document, render, loadLayout } from 'ren-canv';

await loadLayout();

const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };

/**
 * @typedef {object} Case
 * @property {string} name
 * @property {string} text
 * @property {number[]} right the carets ArrowRight visits from the start
 * @property {number[]} left the carets ArrowLeft visits from the end
 * @property {[number, number, number][]} backspace at a caret: the caret after, the code units removed
 * @property {[number, number, number][]} delete at a caret: the caret after, the code units removed
 */
const oracle = /** @type {{ recorded: string, cases: Case[] }} */ (JSON.parse(readFileSync(new URL('./fixtures/editing.json', import.meta.url), 'utf8')));

/** A focused Edit holding `text`, and what it last changed to. @param {string} text */
function field(text) {
  const doc = new Document(mono, { width: 300, height: 300 });
  /** @type {any} */
  let edit = null;
  const changed = { value: text };
  render(() => <View><Edit ref={(/** @type {any} */ e) => (edit = e)} value={text} onChange={(/** @type {any} */ e) => (changed.value = e.value)} /></View>, doc);
  doc.present();
  edit.focus();
  return { doc, changed };
}

describe(`ren canv editing, as ${oracle.recorded} edits a textarea`, () => {
  it('steps the caret right and left as Chrome does', () => {
    for (const c of oracle.cases) {
      const { doc } = field(c.text);
      for (const [key, from, want] of /** @type {[string, number, number[]][]} */ ([['ArrowRight', 0, c.right], ['ArrowLeft', c.text.length, c.left]])) {
        doc.select(-1, from);
        const seen = [from];
        while (seen.length < want.length) {
          doc.key(key);
          seen.push(doc.caret);
        }
        assert.deepEqual(seen, want, `${c.name}: ${key}`);
      }
      doc.close();
    }
  });

  it('takes what Chrome takes with Backspace and Delete', () => {
    for (const c of oracle.cases)
      for (const [key, rows] of /** @type {[string, [number, number, number][]][]} */ ([['Backspace', c.backspace], ['Delete', c.delete]]))
        for (const [at, caret, removed] of rows) {
          const { doc, changed } = field(c.text);
          doc.select(-1, at);
          doc.key(key);
          assert.deepEqual([doc.caret, c.text.length - changed.value.length], [caret, removed], `${c.name}: ${key} at ${at}`);
          doc.close();
        }
  });
});
