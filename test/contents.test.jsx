// Two parts of the portable style that change what an item is rather than
// how it looks: `display: 'contents'` (a container with no box, its children
// laid out as its parent's: a table row carrying role="row" whose cells sit
// in the table's grid) and `textTransform` (the text shown in a case, the
// text given kept as the data). The font is fixed-width: at fontSize 10 and
// lineHeight 2 a character is 5 wide and a line 20 high.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { View, Label, Edit, Action } from 'ren-core';
import { $signal, $read, $write } from 'rrx-core';
import { $active } from 'ren-core';
import { Document, render, loadLayout } from 'ren-canv';

await loadLayout();

const mono = {
  width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2,
  metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
  close() {},
};
const T = { fontSize: 10, lineHeight: 2 };

/** Renders a view on a 400 × 600 page; `labels()` lists each Label's text and page box, in order. @param {() => any} view @param {import('ren-canv').Options} [options] */
function page(view, options) {
  const doc = new Document(mono, { width: 400, height: 600, ...options });
  render(view, doc);
  doc.present();
  const labels = () => {
    /** @type {any[]} */
    const out = [];
    /** @param {any} item @param {number} x @param {number} y */
    const walk = (item, x, y) => {
      for (let c = item.first; c !== null; c = c.next) {
        if (c.kind === 8 || c.kind === 9) continue;
        doc.boxes.fix(c);
        if (c.caption != null) out.push([c.caption, x + c.x, y + c.y, c.w, c.h]);
        walk(c, x + c.x, y + c.y);
      }
    };
    walk(doc.root, 0, 0);
    return out;
  };
  return { doc, labels, texts: () => doc.commands().filter(c => c[0] === 'text').map(c => c[1]) };
}

const grid = { display: /** @type {const} */ ('grid'), columns: '100px 1fr', gap: 4, ...T };

describe('ren canv display contents', () => {
  it("lays a boxless row's cells out in its parent's grid, as the same cells placed there directly", () => {
    const rows = page(() => (
      <View style={grid}>
        <View role="row" style={{ display: 'contents', padding: 30, margin: 7, width: 50, border: 3 }}>
          <Label text="a" />
          <Label text="b" />
        </View>
        <View role="row" style={{ display: 'contents' }}>
          <Label text="c" />
          <View style={{ display: 'contents' }}>
            <Label text="d" />
          </View>
        </View>
      </View>
    ));
    const cells = page(() => (
      <View style={grid}>
        <Label text="a" />
        <Label text="b" />
        <Label text="c" />
        <Label text="d" />
      </View>
    ));
    assert.deepEqual(rows.labels(), cells.labels());
    assert.deepEqual(cells.labels(), [
      ['a', 0, 0, 100, 20],
      ['b', 104, 0, 296, 20],
      ['c', 0, 24, 100, 20],
      ['d', 104, 24, 296, 20],
    ]);
    // The row has no box: empty, at its parent's corner.
    const row = /** @type {any} */ (rows.doc.root.first.first);
    const rect = row.getBoundingClientRect();
    assert.deepEqual([rect.x, rect.y, rect.width, rect.height], [0, 0, 0, 0]);
    rows.doc.close();
    cells.doc.close();
  });

  it('follows a row going boxless and back, hidden, and its cells coming and going', () => {
    /** @type {any} */
    let display = null;
    /** @type {any} */
    let more = null;
    /** @type {any} */
    let hidden = null;
    const { doc, labels } = page(() => {
      display = $signal($active(), /** @type {'contents' | 'flex'} */ ('contents'));
      more = $signal($active(), false);
      hidden = $signal($active(), false);
      return (
        <View style={grid}>
          <View hidden={() => $read(hidden)} style={() => ({ display: $read(display) })}>
            <Label text="a" />
            <Label text="b" />
            {() => ($read(more) ? <Label text="e" /> : null)}
          </View>
          <Label text="c" />
        </View>
      );
    });
    assert.deepEqual(labels(), [['a', 0, 0, 100, 20], ['b', 104, 0, 296, 20], ['c', 0, 24, 100, 20]]);
    $write(more, true);
    doc.present();
    assert.deepEqual(labels(), [['a', 0, 0, 100, 20], ['b', 104, 0, 296, 20], ['e', 0, 24, 100, 20], ['c', 104, 24, 296, 20]]);
    // A box again: one grid cell holding a column of three.
    $write(display, 'flex');
    doc.present();
    assert.deepEqual(labels(), [['a', 0, 0, 100, 20], ['b', 0, 20, 100, 20], ['e', 0, 40, 100, 20], ['c', 104, 0, 296, 60]]);
    $write(display, 'contents');
    doc.present();
    assert.deepEqual(labels(), [['a', 0, 0, 100, 20], ['b', 104, 0, 296, 20], ['e', 0, 24, 100, 20], ['c', 104, 24, 296, 20]]);
    $write(hidden, true);
    doc.present();
    assert.deepEqual(labels().filter(l => l[0] === 'c'), [['c', 0, 0, 100, 20]], 'hidden, its cells go with it');
    $write(hidden, false);
    $write(more, false);
    doc.present();
    assert.deepEqual(labels(), [['a', 0, 0, 100, 20], ['b', 104, 0, 296, 20], ['c', 0, 24, 100, 20]]);
    doc.close();
  });

  it("paints nothing of its own box, passes its text style down, and takes presses and pointer events through its children", () => {
    /** @type {string[]} */
    const heard = [];
    const { doc, texts } = page(() => (
      <View style={grid}>
        <View
          style={{ display: 'contents', background: '#ff0000', border: 2, borderColor: '#00ff00', color: '#0000ff', textTransform: 'uppercase' }}
          onPress={() => heard.push('row press')}
          onPointerDown={e => heard.push(`row down ${/** @type {any} */ (e.target).caption}`)}
        >
          <Label text="a" />
          <Action text="go" onPress={() => heard.push('go')} />
        </View>
      </View>
    ));
    const commands = doc.commands();
    assert.equal(commands.some(c => c.includes('#ffff0000') || c.includes('#ff00ff00')), false, 'no background, no border');
    assert.ok(commands.some(c => c[0] === 'text' && c[1] === 'A' && c.includes('#ff0000ff')), 'its color and case reach its children');
    assert.deepEqual(texts(), ['A', 'go'], "an Action takes no inherited case, as a browser's button");
    doc.press(10, 10);
    doc.release(10, 10);
    doc.press(110, 10);
    doc.release(110, 10);
    assert.deepEqual(heard, ['row down a', 'row press', 'row down go', 'go', 'row press']);
    const covers = doc.painter.covers;
    assert.equal(covers.items.slice(0, covers.n).includes(/** @type {any} */ (doc.root.first.first)), false, 'no box of its own to hit');
    doc.close();
  });
});

describe('ren canv textTransform', () => {
  it('shows text in its case, inherited, and copies what shows as Chrome does, the text given kept', () => {
    const { doc, texts } = page(() => (
      <View style={{ ...T, textTransform: 'uppercase' }}>
        <Label text="hello world" />
        <Label text="Mixed Case" style={{ textTransform: 'lowercase' }} />
        <Label text="the quick-brown fox's tail" style={{ textTransform: 'capitalize' }} />
        <Label runs={[{ text: 'straße ' }, { text: 'run', style: { fontWeight: 'bold' } }]} />
        <Label text="as given" style={{ textTransform: 'none' }} />
        <View>in a view</View>
        <Edit value="typed" />
      </View>
    ), { behavior: 'page' });
    assert.deepEqual(texts().slice(0, 7), ['HELLO WORLD', 'mixed case', "The Quick-Brown Fox's Tail", 'STRAßE ', 'RUN', 'as given', 'IN A VIEW']);
    assert.ok(texts().includes('typed'), 'an Edit shows its value as typed');
    const label = /** @type {any} */ (doc.root.first.first);
    assert.equal(label.caption, 'hello world', 'the text given stays the data');
    doc.press(2, 10, 3);
    assert.equal(doc.copied(), 'HELLO WORLD', 'a selection copies what shows');
    // A character whose uppercase is longer keeps its own: offsets stay the text's.
    doc.press(2, 70, 3);
    assert.equal(doc.copied(), 'STRAßE RUN');
    doc.close();
  });

  it('shows text again in its new case when the transform changes', () => {
    /** @type {any} */
    let mode = null;
    const { doc, texts } = page(() => {
      mode = $signal($active(), /** @type {'none' | 'uppercase'} */ ('none'));
      return (
        <View style={() => ({ ...T, textTransform: $read(mode) })}>
          <Label text="abc" />
        </View>
      );
    });
    assert.deepEqual(texts(), ['abc']);
    $write(mode, 'uppercase');
    doc.present();
    assert.deepEqual(texts(), ['ABC']);
    doc.close();
  });
});
