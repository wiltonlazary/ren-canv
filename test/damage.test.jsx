// Damage on a busy screen: a change repaints what it changed, and a plain
// fill it cuts (a column's background) does not pull the whole column in.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { $root, $signal, $write, $batch } from 'rrx-core';
import { View, Label } from 'ren-core';
import { Document, render, loadLayout } from 'ren-canv';

await loadLayout();

/** Every character is half its size wide. */
const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };

/** A Document that draws: it keeps the damage of each frame (null: whole). */
class Probe extends Document {
  /** @param {any} [options] */
  constructor(options) {
    super(mono, { width: 400, height: 300, ...options });
    /** @type {number[][] | null} */
    this.damaged = null;
  }
  get drawing() {
    return true;
  }
  /** @param {any} frame @param {any} damage */
  draw(frame, damage) {
    void frame;
    /** @type {number[][] | null} */
    const out = damage === null ? null : [];
    if (damage !== null) for (let i = 0; i < damage.n; i++) out?.push([...damage.box.subarray(i * 4, i * 4 + 4)]);
    this.damaged = out;
  }
}

describe('ren canv damage', () => {
  it("keeps two changes beside a column's edge small: the plain fills they cut stay out", () => {
    for (const scale of [1, 2]) {
      const doc = new Probe({ scale });
      const root = $root('busy');
      const left = $signal(root, 'tick 1');
      const right = $signal(root, 'hover a');
      render(() => (
        <View style={{ direction: 'row', height: 300 }}>
          <View style={{ width: 200, background: '#eeeeee', align: 'end', padding: 4 }}>
            <Label text={left} />
          </View>
          <View style={{ width: 200, background: '#dddddd', align: 'start', padding: 4 }}>
            <Label text={right} style={{ radius: 4, background: '#ffffff' }} />
          </View>
        </View>
      ), doc, { root });
      doc.present();
      // A tick and a hover in one frame.
      $batch(root, () => {
        $write(left, 'tick 2');
        $write(right, 'hover b');
      });
      doc.present();
      assert.equal(doc.repaint, 'damage', `scale ${scale}: not a whole repaint`);
      const area = /** @type {number[][]} */ (doc.damaged).reduce((sum, [l, t, r, b]) => sum + (r - l) * (b - t), 0);
      assert.ok(area < 400 * 300 * 0.05, `scale ${scale}: the damage is the two labels' (${area} px²)`);
      doc.close();
    }
  });
});
