// An Edit's value in styled runs on the canvases: drawn piece by piece in
// each run's face and color on the Edit's one line height, the caret, the
// selection and a press measured through the runs, soft wraps too; runs that
// no longer match the value (a draft the view has not answered) show plain,
// and the value stays plain text.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { $signal, $read, $write } from 'rrx-core';
import { View, Edit, $active } from 'ren-core';
import { Document, render, loadLayout } from 'ren-canv';

await loadLayout();

/** Every character half its size wide, a bold one 1.5 times that; the ascent 0.8 of the size, the descent 0.2. */
const fonts = {
  width: (/** @type {string} */ text, /** @type {number} */ size, face = 0) => (text.length * size * ((face & 1) !== 0 ? 1.5 : 1)) / 2,
  metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
  close() {},
};
/** The commands of a frame named `name`, their numbers rounded. @param {Document} doc @param {string} name */
const named = (doc, name) => doc.commands().filter(c => c[0] === name).map(c => c.map(v => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)));

/** Words as runs: `let` bold and purple, the rest plain. @param {string} value */
const tokens = value => value.split(/( )/).filter(t => t !== '').map(t => (t === 'let' ? { text: t, style: { fontWeight: 700, color: '#800080' } } : { text: t }));

/**
 * An Edit at the page's top left, text from x 0 and a row 20 high (size 10):
 * its value a signal the view writes on change, its runs its tokens.
 * @param {Record<string, any>} props
 */
function page(props = {}) {
  const doc = new Document(fonts, { width: 300, height: 200 });
  /** @type {any} */
  const refs = {};
  render(() => {
    refs.value = $signal($active(), props.value ?? 'let x');
    return (
      <View style={{ fontSize: 10, lineHeight: 2, align: 'start' }}>
        <Edit
          ref={(/** @type {any} */ e) => (refs.edit = e)}
          style={{ width: 200, padding: 0, border: 0, color: '#000' }}
          lines={props.lines}
          secret={props.secret}
          value={refs.value}
          runs={() => (props.stale ? tokens('stale') : tokens($read(refs.value)))}
          onChange={(/** @type {any} */ e) => $write(refs.value, e.value)}
        />
      </View>
    );
  }, doc);
  doc.present();
  return { doc, refs };
}

describe('ren canv Edit runs', () => {
  it("draws the value in its runs' faces and colors on the Edit's line", () => {
    const { doc } = page();
    // 'let' bold: 22.5 wide; ' ' and 'x' after it, all on the plain text's baseline.
    assert.deepEqual(named(doc, 'text'), [
      ['text', 'let', 0, 22, 10, '#ff800080', 1],
      ['text', ' ', 22.5, 22, 10, '#ff000000', 0],
      ['text', 'x', 27.5, 22, 10, '#ff000000', 0],
    ]);
    doc.close();
    const plain = new Document(fonts, { width: 300, height: 200 });
    render(() => (
      <View style={{ fontSize: 10, lineHeight: 2, align: 'start' }}>
        <Edit style={{ width: 200, padding: 0, border: 0 }} value="let x" />
      </View>
    ), plain);
    plain.present();
    assert.equal(named(plain, 'text')[0][3], 22, 'the same baseline without runs');
    plain.close();
  });

  it('puts the caret, the selection and a press where the runs put the text', () => {
    const { doc, refs } = page();
    const edit = refs.edit;
    edit.focus();
    edit.setSelectionRange(3, 3);
    doc.present();
    const caret = named(doc, 'rect').find(c => c[3] - c[1] === 2);
    assert.equal(caret?.[1], 22.5, 'after the bold let: 22.5, not 15');
    edit.setSelectionRange(0, 5);
    doc.present();
    const selection = named(doc, 'rect').find(c => c[1] === 0 && c[4] - c[2] === 20);
    assert.equal(selection?.[3], 32.5, 'the selection spans the pieces as drawn');
    // 21 from the start is nearest the end of 'let' (22.5), not 'le|t' (plain: 20).
    doc.press(21, 19);
    assert.equal(doc.caret, 3);
    doc.release(21, 19);
    doc.close();
  });

  it('shows a draft the view has not answered plain, and the answer in its runs; the value stays plain', () => {
    const { doc } = page({ stale: true });
    assert.deepEqual(named(doc, 'text').map(c => c[1]), ['let x'], 'runs of another text are not shown');
    doc.close();
    const live = page();
    live.refs.edit.focus();
    live.doc.type(' let');
    live.doc.present();
    assert.equal($read(live.refs.value), 'let x let', 'onChange gives the plain value');
    assert.deepEqual(named(live.doc, 'text').map(c => [c[1], c[6]]), [['let', 1], [' ', 0], ['x', 0], [' ', 0], ['let', 1]], "the view's answer, in runs");
    live.doc.close();
  });

  it('wraps a multi-line value through its runs, and places the caret on its rows', () => {
    // 'let let let let' plain is 75 wide; its bold words make it 105: past 100, the last word wraps.
    const doc = new Document(fonts, { width: 300, height: 200 });
    /** @type {any} */
    let edit = null;
    render(() => (
      <View style={{ fontSize: 10, lineHeight: 2, align: 'start' }}>
        <Edit ref={(/** @type {any} */ e) => (edit = e)} style={{ width: 100, padding: 0, border: 0 }} lines={3} value="let let let let" runs={tokens('let let let let')} />
      </View>
    ), doc);
    doc.present();
    const drawn = named(doc, 'text');
    const first = drawn[0][3];
    assert.deepEqual(drawn.filter(c => c[3] !== first).map(c => [c[1], c[2], c[3] - first]), [['let', 0, 20]], 'the last let on a row of its own, a line below');
    edit.focus();
    edit.setSelectionRange(14, 14);
    doc.present();
    const caret = named(doc, 'rect').find(c => c[3] - c[1] === 2);
    assert.deepEqual([caret?.[1], caret?.[4] - caret?.[2]], [15, 20], "after 'le' on the second row: 15 (bold), a row high");
    // A press on the second row, 16 in: nearest the end of 'le' (15), not 'let' (plain 15 is 'let').
    const top = /** @type {number} */ (caret?.[2]);
    doc.press(16, top + 10);
    assert.equal(doc.caret, 14);
    doc.release(16, top + 10);
    doc.close();
  });

  it("keeps a secret Edit's bullets plain", () => {
    const { doc } = page({ value: 'let', secret: true });
    assert.deepEqual(named(doc, 'text').map(c => [c[1], c[6]]), [['•••', 0]]);
    doc.close();
  });
});
