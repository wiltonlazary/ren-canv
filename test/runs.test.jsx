// A Label's styled runs on the canvases: measured, wrapped and painted
// piece by piece in each run's face, size and color, a line box as high as
// its tallest run, and the plain text's offsets for selection, copy and
// offsetAt; a run's press before the Label's.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { $root, $signal, $write } from 'rrx-core';
import { View, Label, Recover } from 'ren-core';
import { Document, render, loadLayout } from 'ren-canv';
import { rowWidth, measureOf } from '../src/layout.js';

await loadLayout();

/** Every character is half its size wide; the ascent 0.8 of the size, the descent 0.2. */
const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };
const page = () => new Document(mono, { width: 300, height: 200 });
/** The commands of a frame named `name`. @param {Document} doc @param {string} name */
const named = (doc, name) => doc.commands().filter(c => c[0] === name);
/** Rounds the numbers of a command. @param {(string | number)[]} c */
const rounded = c => c.map(v => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));

describe('ren canv styled runs', () => {
  it("lets a Recover catch a throw from a run's onPress: the press does not throw, and a press after it works", () => {
    const doc = new Document(mono, { width: 300, height: 100 });
    render(() => (
      <View style={{ padding: 10 }}>
        <Recover fallback={() => <Label text="failed" />}>
          <Label runs={[{ text: 'see ' }, { text: 'docs', onPress: () => { throw new Error('x'); } }]} />
        </Recover>
      </View>
    ), doc);
    doc.present();
    assert.doesNotThrow(() => {
      doc.press(60, 15);
      doc.release(60, 15);
    });
    doc.present();
    assert.deepEqual(named(doc, 'text').map(c => c[1]), ['failed']);
    assert.doesNotThrow(() => {
      doc.press(20, 15);
      doc.release(20, 15);
    }, 'a press after it');
    doc.present();
    assert.deepEqual(named(doc, 'text').map(c => c[1]), ['failed']);
    doc.close();
  });

  it('paints each piece in its run: face, size, color, background and decorations, on one baseline', () => {
    const doc = page();
    /** @type {any} */
    let label = null;
    render(() => (
      <View style={{ padding: 10, align: 'start' }}>
        <Label
          ref={(/** @type {any} */ n) => (label = n)}
          style={{ color: '#000' }}
          runs={[
            { text: 'ab ' },
            { text: 'cd', style: { fontSize: 34, color: '#f00', background: '#ff0', fontWeight: 700 } },
            { text: ' ef', style: { italic: true, underline: true, fontFamily: 'monospace' } },
          ]}
        />
      </View>
    ), doc);
    doc.present();
    // 'ab ' 25.5 at 17, 'cd' 34 at 34, ' ef' 25.5: 85 wide. The line box: the
    // 34 run's ascent 27 and descent 7 (rounded, as Blink's) and its half
    // leading 6.8 floored above: 33 above its baseline and 14.6 below.
    const r = label.getBoundingClientRect();
    assert.deepEqual(rounded([r.width, r.height]), [85, 47.59], 'as wide as its pieces, as high as its tallest run');
    const texts = named(doc, 'text').map(rounded);
    assert.deepEqual(texts, [
      ['text', 'ab ', 10, 43, 17, '#ff000000', 0],
      ['text', 'cd', 35.5, 43, 34, '#ffff0000', 1],
      ['text', ' ef', 69.5, 43, 17, '#ff000000', 2 | 4],
    ], 'one baseline; bold, italic and monospace faces');
    const back = named(doc, 'rect').map(rounded).find(c => c[5] === '#ffffff00');
    assert.deepEqual(back, ['rect', 35.5, 16, 69.5, 50, '#ffffff00'], "behind its text: the run's ascent and descent");
    assert.equal(named(doc, 'line').length, 1, 'the underlined run alone');
    doc.close();
  });

  it("sets a Label's baseline where Chrome does: ascent and descent rounded, the half leading above floored", () => {
    // DejaVu Sans's ascent and descent (1901 and 483 of 2048), and the
    // baselines headless Chrome lays that font out on: [size, lineHeight, baseline].
    const dejavu = { width: (/** @type {string} */ text, /** @type {number} */ size) => text.length * size * 0.6, metrics: (/** @type {number} */ size) => ({ ascent: (size * 1901) / 2048, descent: (size * 483) / 2048 }), close() {} };
    const measured = [[12, 1.55, 13], [12, 1.2, 11], [13, 1.55, 14], [13, 1.2, 12], [14, 1.55, 15], [14, 1.2, 13], [16, 1.55, 17], [16, 1.2, 15], [18, 1.55, 20], [18, 1.2, 17], [20, 1.55, 22], [20, 1.2, 19], [24, 1.55, 26], [24, 1.2, 22], [34, 1.55, 38], [34, 1.2, 32]];
    for (const [size, lineHeight, base] of measured) {
      const doc = new Document(dejavu, { width: 300, height: 200 });
      render(() => <Label text="Wg" style={{ fontSize: size, lineHeight }} />, doc);
      doc.present();
      assert.equal(named(doc, 'text')[0][3], base, `${size}px at ${lineHeight}`);
      doc.close();
    }
  });

  it('wraps across runs, each row as high as its runs, and clamps with an ellipsis in the last run', () => {
    const doc = page();
    const root = $root('runs');
    const lines = $signal(root, 0);
    /** @type {any} */
    let label = null;
    render(() => (
      <View style={{ padding: 10, align: 'start' }}>
        <Label
          ref={(/** @type {any} */ n) => (label = n)}
          style={{ width: 80, wrap: true }}
          lines={lines}
          runs={[{ text: 'aaaa ' }, { text: 'bbbb', style: { fontSize: 34 } }, { text: ' cc dd' }]}
        />
      </View>
    ), doc, { root });
    doc.present();
    // 'aaaa bbbb' is 110.5 wide: 'bbbb' (68) goes to a row of its own, 47.59375 high (47.6 down to a 64th).
    assert.deepEqual(label.rows, ['aaaa', 'bbbb', 'cc dd']);
    assert.deepEqual(label.starts, [0, 5, 10]);
    assert.deepEqual(rounded(label.tops), [0, 23.8, 71.39, 95.19]);
    assert.equal(Math.round(label.getBoundingClientRect().height * 100) / 100, 95.19);
    $write(lines, 2);
    doc.present();
    assert.deepEqual(label.rows, ['aaaa', 'bbb…'], 'the last row kept ends with an ellipsis, within the width');
    const texts = named(doc, 'text').map(rounded);
    assert.deepEqual(texts.slice(-1), [['text', 'bbb…', 10, 66.8, 34, texts[0][5], 0]], 'the ellipsis takes the run of the character before it');
    assert.equal(Math.round(label.getBoundingClientRect().height * 100) / 100, 71.39);
    doc.close();
  });

  it('selects, copies and maps points to the plain text across runs', () => {
    const doc = page();
    /** @type {any} */
    let label = null;
    render(() => (
      <View style={{ padding: 10, align: 'start' }}>
        <Label ref={(/** @type {any} */ n) => (label = n)} runs={[{ text: 'ab ' }, { text: 'cd', style: { fontSize: 34 } }, { text: ' ef' }]} />
      </View>
    ), doc);
    doc.present();
    // After 'ab c' is 42.5 from the start: nearest to 44.
    assert.equal(label.offsetAt(10 + 44, 30), 4);
    assert.equal(label.offsetAt(10 + 80, 30), 7);
    doc.press(10 + 44, 30, 2);
    assert.equal(doc.copied(), 'cd', 'a double press selects the word in its run');
    const box = named(doc, 'rect').map(rounded).find(c => c[5] === '#ffaae4f5');
    assert.deepEqual(box, ['rect', 35.5, 10, 69.5, 57.59, '#ffaae4f5'], "the selection fills the row's line box");
    doc.selectAll();
    assert.equal(doc.copied(), 'ab cd ef', 'copy is the plain text');
    doc.close();
  });

  it("presses a run before its Label, and a run's stopPropagation keeps the Label's", () => {
    const doc = page();
    /** @type {string[]} */
    const heard = [];
    let stop = false;
    render(() => (
      <View style={{ padding: 10, align: 'start' }}>
        <Label
          onPress={() => heard.push('label')}
          runs={[
            { text: 'see ' },
            { text: 'docs', style: { underline: true, color: '#00f' }, onPress: (/** @type {any} */ e) => {
              heard.push(`run ${e.target.kind}`);
              if (stop) e.stopPropagation();
            } },
          ]}
        />
      </View>
    ), doc);
    doc.present();
    // 'see ' is 34 wide; 'docs' 34 to 68.
    doc.press(10 + 50, 15);
    doc.release(10 + 50, 15);
    doc.press(10 + 10, 15);
    doc.release(10 + 10, 15);
    assert.deepEqual(heard, ['run 3', 'label', 'label'], 'the run, then its Label; elsewhere the Label alone');
    stop = true;
    doc.press(10 + 50, 15);
    assert.deepEqual(heard.slice(3), ['run 3']);
    doc.close();
  });
  it('measures a row ending inside a run as wide as it paints it, to its 64th', () => {
    // Characters 3.01 wide: the row "ab cd" paints 'ab' (6.03125) and ' cd' up to its 64th (9.03125), though 'cd' runs on.
    const odd = { width: (/** @type {string} */ text) => text.length * 3.01, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };
    const doc = new Document(odd, { width: 200, height: 100 });
    /** @type {any} */
    let label = null;
    render(() => (
      <View style={{ width: 17 }}>
        <Label ref={(/** @type {any} */ n) => (label = n)} wrap runs={[{ text: 'ab' }, { text: ' cd ef' }]} />
      </View>
    ), doc);
    doc.present();
    assert.equal(label.rows[0], 'ab cd');
    assert.equal(rowWidth(label, measureOf(label, odd), 0), 964 / 64);
    doc.close();
  });
});
