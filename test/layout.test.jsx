// The portable box model on a canvas: the same boxes a browser computes from
// the CSS ren-dom writes (ren-core's style.js), with a fixed-width font so every
// number is exact: each character is half its size wide, the ascent 0.8 of
// the size and the descent 0.2. Text at fontSize 10 and lineHeight 2 is 5
// wide per character and 20 high per line.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { View, Label, Edit, Action } from 'ren-core';
import { $development, $signal, $read, $write } from 'rrx-core';
import { $active } from 'ren-core';
import { Document, render, loadLayout } from 'ren-canv';
import { Taffy } from '../src/taffy.js';
import { box } from '../src/engine.js';
import { Lines } from '../src/text.js';

/** The layout engine (Taffy's WebAssembly), once, before any Document. */
await loadLayout();

const mono = {
  width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2,
  metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
  close() {},
};
/** Renders a view on a 400 × 600 page; `boxes()` lists every item's page box as [x, y, w, h], in order. @param {() => any} view */
function page(view) {
  const doc = new Document(mono, { width: 400, height: 600 });
  render(view, doc);
  const boxes = () => {
    /** @type {number[][]} */
    const out = [];
    /** @param {any} item @param {number} x @param {number} y */
    const walk = (item, x, y) => {
      for (let c = item.first; c !== null; c = c.next) {
        if (c.kind === 8 || c.kind === 9) continue;
        // Boxes are read from the layout as items are drawn; read them all.
        doc.boxes.fix(c);
        out.push([x + c.x, y + c.y, c.w, c.h]);
        walk(c, x + c.x, y + c.y);
      }
    };
    walk(doc.root, 0, 0);
    return out;
  };
  return { doc, boxes, commands: () => doc.commands() };
}
const T = { fontSize: 10, lineHeight: 2 };

describe('ren canv box model', () => {
  it('wraps a long paragraph measuring each row\'s text only, never the rest after it', () => {
    // The work, not the time: how many characters the measure is handed.
    let measured = 0;
    const measure = { width: (/** @type {string} */ t) => ((measured += t.length), t.length * 5) };
    const text = 'word '.repeat(10000);
    const rows = Lines(measure, text, 100);
    assert.equal(rows.length, 2500);
    assert.equal(rows.map(r => r.text).join(''), text, 'every character in a row');
    // Measured again from each row's start, the rest of the paragraph was 63,022,138 characters.
    assert.ok(measured <= 400 * rows.length, `${measured} characters measured for ${rows.length} rows of ${text.length}`);
  });

  it('lays adjacent text in a container out as one anonymous box, as CSS does', () => {
    // Chrome sets <View>Count: {n}</View> on one line and gives a row's gap
    // once around "Badge xs"; the canvases stacked each text node (+23.8 px)
    // or put the gap between them (+4 px a badge).
    /** @type {any} */
    let n = null;
    const { doc, boxes } = page(() => {
      n = $signal($active(), 5);
      return (
        <View style={{ gap: 6, ...T }}>
          <View>Count: {() => $read(n)}</View>
          <View style={{ direction: 'row', gap: 4 }}>
            Badge {'xs'}
            <View style={{ width: 10, height: 10 }} />
          </View>
        </View>
      );
    });
    const text = () => doc.commands().filter(c => c[0] === 'text').map(c => [c[1], c[2]]);
    assert.deepEqual(boxes(), [
      [0, 0, 400, 46],
      [0, 0, 400, 20],
      [0, 26, 400, 20],
      [44, 26, 10, 10],
    ], 'one line each; the gap once, after "Badge xs" (40 wide)');
    assert.deepEqual(text(), [['Count: 5', 0], ['Badge xs', 0]]);
    $write(n, 12);
    assert.deepEqual(text(), [['Count: 12', 0], ['Badge xs', 0]], 'a later text node changing redraws the run');
  });

  it('stacks a column: stretched widths, content heights, padding, gaps and margins', () => {
    const { boxes } = page(() => (
      <View style={{ padding: 10, gap: 5, ...T }}>
        <Label text="abc" />
        <Label text="de" style={{ margin: [3, 4] }} />
        <View style={{ height: 30 }} />
      </View>
    ));
    assert.deepEqual(boxes(), [
      [0, 0, 400, 106],
      [10, 10, 380, 20],
      [14, 38, 372, 20],
      [10, 66, 380, 30],
    ]);
  });

  it('grows a row by shares of the free space', () => {
    const { boxes } = page(() => (
      <View style={{ direction: 'row', width: 200, ...T }}>
        <Label text="aaaa" style={{ grow: 1 }} />
        <Label text="bb" style={{ grow: 3 }} />
        <View style={{ width: 50 }} />
      </View>
    ));
    assert.deepEqual(boxes(), [
      [0, 0, 200, 20],
      [0, 0, 50, 20],
      [50, 0, 100, 20],
      [150, 0, 50, 20],
    ], 'the empty View stretches to the line');
  });

  it('shrinks by the base size, and freezes an item at its minimum', () => {
    const shrunk = page(() => (
      <View style={{ direction: 'row', width: 60, ...T }}>
        <View style={{ width: 40, shrink: 1 }} />
        <View style={{ width: 40, shrink: 1 }} />
        <View style={{ width: 20 }} />
      </View>
    ));
    assert.deepEqual(shrunk.boxes().slice(1).map(b => b[2]), [24, 24, 12], 'every item shrinks (CSS), by its base size');
    const clamped = page(() => (
      <View style={{ direction: 'row', width: 60 }}>
        <View style={{ width: 40, shrink: 1, minWidth: 35 }} />
        <View style={{ width: 40, shrink: 1 }} />
      </View>
    ));
    assert.deepEqual(clamped.boxes().slice(1).map(b => b[2]), [35, 25]);
    const none = page(() => (
      <View style={{ direction: 'row', width: 60 }}>
        <View style={{ width: 40 }} />
        <View style={{ width: 40 }} />
      </View>
    ));
    assert.deepEqual(none.boxes().slice(1).map(b => b[2]), [30, 30], 'CSS shrinks by default');
    const rigid = page(() => (
      <View style={{ direction: 'row', width: 60 }}>
        <View style={{ width: 40, shrink: 0 }} />
        <View style={{ width: 40, shrink: 0 }} />
      </View>
    ));
    assert.deepEqual(rigid.boxes().slice(1).map(b => b[0]), [0, 40], 'shrink: 0 overflows');
  });

  it('wraps a row into lines and spaces each with justify', () => {
    const { boxes } = page(() => (
      <View style={{ direction: 'row', wrap: true, width: 100, gap: 10, justify: 'between' }}>
        {[1, 2, 3, 4, 5].map(() => <View style={{ width: 30, height: 10 }} />)}
      </View>
    ));
    assert.deepEqual(boxes(), [
      [0, 0, 100, 50],
      [0, 0, 30, 10],
      [70, 0, 30, 10],
      [0, 20, 30, 10],
      [70, 20, 30, 10],
      [0, 40, 30, 10],
    ]);
    const spaced = (/** @type {any} */ justify) =>
      page(() => (
        <View style={{ direction: 'row', width: 100, justify }}>
          <View style={{ width: 20, height: 5 }} />
          <View style={{ width: 20, height: 5 }} />
        </View>
      )).boxes().slice(1).map(b => b[0]);
    assert.deepEqual(spaced('start'), [0, 20]);
    assert.deepEqual(spaced('center'), [30, 50]);
    assert.deepEqual(spaced('end'), [60, 80]);
    assert.deepEqual(spaced('around'), [15, 65]);
    assert.deepEqual(spaced('evenly'), [20, 60]);
  });

  it('aligns across a line, and one item by itself', () => {
    const { boxes } = page(() => (
      <View style={{ direction: 'row', height: 40, align: 'center' }}>
        <View style={{ width: 10, height: 10 }} />
        <View style={{ width: 10, height: 10, self: 'end' }} />
        <View style={{ width: 10, self: 'stretch' }} />
      </View>
    ));
    assert.deepEqual(boxes().slice(1), [
      [0, 15, 10, 10],
      [10, 30, 10, 10],
      [20, 0, 10, 40],
    ]);
    const column = page(() => (
      <View style={{ width: 100, align: 'center', ...T }}>
        <Label text="ab" />
      </View>
    ));
    assert.deepEqual(column.boxes()[1], [45, 0, 10, 20], 'a Label not stretched fits its text');
  });

  it("keeps a leaf's content as its minimum along its parent's main axis only, as its parent's alignment changes", () => {
    // Chrome: a 40-character Label (200 wide) stretched in a column 100 wide
    // is 100 wide, its text past it; aligned to the start it is its text's
    // width. In a row 10 high it is 10 high. The canvases kept its text as
    // its minimum across too (200 wide, 20 high).
    /** @type {any} */
    let align = null;
    const { boxes, commands } = page(() => {
      align = $signal($active(), /** @type {string | undefined} */ ('start'));
      return (
        <View style={() => ({ width: 100, align: $read(align), ...T })}>
          <Label>{'x'.repeat(40)}</Label>
          <Action>{'y'.repeat(40)}</Action>
          <View style={{ width: 300, height: 10, direction: 'row' }}>
            <Label>abc</Label>
          </View>
        </View>
      );
    });
    const widths = () => {
      commands();
      return boxes().slice(1, 3).map(b => b[2]);
    };
    assert.deepEqual(widths(), [200, 220], "at the start: its content's width");
    assert.deepEqual(boxes()[4], [0, 58, 15, 10], 'stretched in a row 10 high: 10 high');
    $write(align, undefined);
    assert.deepEqual(widths(), [100, 100], "stretched (CSS's default): the column's width");
    $write(align, 'start');
    assert.deepEqual(widths(), [200, 220], 'at the start again');
    $write(align, 'stretch');
    assert.deepEqual(widths(), [100, 100], 'stretched again');
  });

  it('lays out a grid: tracks in px, fr and repeat(), gaps, and items placed on lines', () => {
    const { boxes } = page(() => (
      <View style={{ display: 'grid', width: 300, columns: [100, '1fr', '2fr'], rows: 'repeat(2, 40px)', columnGap: 10, rowGap: 5 }}>
        <View />
        <View />
        <View style={{ column: '1 / 3', row: 2 }} />
        <View style={{ column: 3, row: 2 }} />
      </View>
    ));
    // Columns 100, then the 180 left after two gaps split 1:2 (60, 120).
    assert.deepEqual(boxes(), [
      [0, 0, 300, 85],
      [0, 0, 100, 40],
      [110, 0, 60, 40],
      [0, 45, 170, 40],
      [180, 45, 120, 40],
    ]);
  });

  it("stretches a grid's auto tracks over its free space, as CSS's normal content alignment", () => {
    // 'a' is 5 wide, 'bb' 10: the 285 left go half to each auto column; the one auto row fills the height.
    const { boxes } = page(() => (
      <View style={{ ...T }}>
        <View style={{ display: 'grid', width: 300, height: 100, columns: 'auto auto' }}>
          <Label text="a" />
          <Label text="bb" />
        </View>
        <View style={{ display: 'grid', width: 300, columns: 'auto auto', justify: 'start' }}>
          <Label text="a" />
          <Label text="bb" />
        </View>
      </View>
    ));
    const [, , a, b, , c, d] = boxes();
    assert.deepEqual([a, b], [[0, 0, 147.5, 100], [147.5, 0, 152.5, 100]]);
    assert.deepEqual([c, d], [[0, 100, 5, 20], [5, 100, 10, 20]], 'a set justify packs them');
  });

  it('keeps a grid in a column of fixed height at its content, items that clip included, as Chrome does', () => {
    // A grid's automatic minimum height is its laid-out height in Chrome; Taffy sized it
    // for a min-content height, where a clipping item counts as nothing, and shrank the
    // grid to its column (rui-show's Card demo: 4.8 px short, the border over the text).
    const { boxes } = page(() => (
      <View style={{ width: 200 }}>
        <View style={{ height: 90 }}>
          <View style={{ display: 'grid', columns: 'repeat(2, minmax(0, 1fr))' }}>
            <View style={{ height: 50 }} />
            <View style={{ overflow: 'hidden' }}>
              <View style={{ height: 150 }} />
            </View>
          </View>
        </View>
        <View style={{ height: 90 }}>
          <View style={{ display: 'grid', columns: 'repeat(2, minmax(0, 1fr))', minHeight: 0 }}>
            <View style={{ overflow: 'hidden' }}>
              <View style={{ height: 150 }} />
            </View>
          </View>
        </View>
      </View>
    ));
    const all = boxes();
    assert.equal(all[2][3], 150, 'held at its content');
    assert.equal(all[8][3], 90, 'a set minimum still lets it shrink');
  });

  it('keeps percentages that sum to 100% on one line of a wrapping row, as Chrome does', () => {
    // Taffy sums a line in 32-bit floats with no tolerance: 66.6667% + 33.3333% of 664 is
    // 442.66693 + 221.33331 = 664.00024 > 664, and the second wrapped (rui-show's Grid demo:
    // span 8 then span 4 on a new row); Chrome floors percentages to 64ths and keeps one line.
    const { boxes } = page(() => (
      <View>
        {[664, 1000, 600].map(width => (
          <View style={{ width, direction: 'row', wrap: true }}>
            <View style={{ width: '66.6667%', shrink: 0, height: 10 }} />
            <View style={{ width: '33.3333%', shrink: 0, height: 10 }} />
          </View>
        ))}
        <View style={{ height: 100, direction: 'column', wrap: true }}>
          <View style={{ height: '66.6667%', shrink: 0, width: 10 }} />
          <View style={{ height: '33.3333%', shrink: 0, width: 10 }} />
        </View>
        <View style={{ width: 664, direction: 'row', wrap: true }}>
          <View style={{ width: '60%', shrink: 0, height: 10 }} />
          <View style={{ width: '41%', shrink: 0, height: 10 }} />
        </View>
      </View>
    ));
    const all = boxes();
    for (const at of [3, 6, 9]) {
      assert.equal(all[at][1], all[at - 1][1], `one line (${all[at - 1][2] + all[at][2]} of ${all[at - 2][2]})`);
      assert.ok(Math.abs(all[at - 1][2] + all[at][2] - all[at - 2][2]) < 0.02, 'as wide as the row, to a 64th');
    }
    assert.equal(all[12][0], all[11][0], 'a wrapping column too');
    assert.ok(all[15][1] > all[14][1], 'more than 100% still wraps');
  });

  it('sizes a column by an unshrinkable item clamped to its maximum, as CSS does', () => {
    // A ScrollBox.Fit (shrink 0, mah 100) in a bordered Surface: the Scroll's region height, 240,
    // capped at 100; Taffy made the column as high as 240 (rui-show's ScrollBox demo, 140 px too tall).
    const { boxes } = page(() => (
      <View style={{ height: 400 }}>
        <View style={{ border: 1 }}>
          <View style={{ height: 240, maxHeight: 100, shrink: 0 }} />
        </View>
        <View style={{ border: 1 }}>
          <View style={{ height: 50, minHeight: 60, maxHeight: 40, shrink: 0 }} />
        </View>
      </View>
    ));
    const all = boxes();
    assert.deepEqual([all[1][3], all[2][3]], [102, 100]);
    assert.deepEqual([all[3][3], all[4][3]], [62, 60], 'the minimum wins over the maximum');
  });

  it('caps a line of text at its maximum width, the text running past it, as CSS does', () => {
    // rui-core's EmptyState.Note (max-width 420): 502.5 wide on the canvases, 420 on the DOM.
    const { boxes } = page(() => (
      <View style={{ width: 300, align: 'start', ...T }}>
        <Label text="aaaaaaaaaaaaaaaaaaaa" style={{ maxWidth: 60 }} />
        <Label text="aaaa" style={{ maxWidth: 60 }} />
      </View>
    ));
    const all = boxes();
    assert.deepEqual([all[1][2], all[2][2]], [60, 20]);
  });

  it("keeps a grid's hold right after its styles are forgotten and nodes removed", () => {
    // Past 1024 styles the layout forgets them all (FORGET) while nodes keep theirs:
    // the hold must still follow a parent turning into a row, and a removed parent lets go of its children.
    const t = new Taffy();
    const column = t.define(box({ direction: 'column', height: 90 }));
    const row = t.define(box({ direction: 'row', height: 90 }));
    const grid = t.define(box({ display: 'grid', columns: 'repeat(2, minmax(0, 1fr))' }));
    const [outer, inner, kid] = [t.leaf(), t.leaf(), t.leaf()];
    t.set(outer, column);
    t.set(inner, grid);
    t.children(outer, [inner]);
    t.children(inner, [kid]);
    assert.equal(t.holding.has(inner), true, 'held in a column');
    for (const style of [column, grid]) t.undefine(style);
    t.set(outer, row);
    assert.equal(t.holding.has(inner), false, 'let go in a row, its style forgotten');
    t.remove(outer);
    assert.equal(t.parentOf.has(inner), false, 'no parent once it is removed');
    t.remove(inner);
    assert.equal(t.parentOf.has(kid), false);
    t.close();
  });

  it("wraps a Label's words at its width", () => {
    const { boxes } = page(() => (
      <View style={{ width: 30 }}>
        <Label text="aa bb cc" style={{ wrap: true, ...T }} />
      </View>
    ));
    assert.deepEqual(boxes()[1], [0, 0, 30, 40]);
  });

  it('sizes wrapping text in a row as CSS text: its max-content with room, shrinking to its longest word', () => {
    // 'sends at once' is 65 wide at size 10, its longest word 25; 'ab' 10.
    const { boxes } = page(() => (
      <View style={T}>
        <View style={{ direction: 'row', gap: 5 }}>
          <Label text="ab" />
          <Label text="sends at once" style={{ wrap: true }} />
        </View>
        <View style={{ direction: 'row', width: 50, gap: 5 }}>
          <Label text="ab" />
          <Label text="sends at once" style={{ wrap: true }} />
        </View>
        <View style={{ direction: 'row', width: 50 }}>
          <View>
            <Label text="sends at once" style={{ wrap: true }} />
          </View>
          <Label text="ab" />
        </View>
      </View>
    ));
    const b = boxes();
    assert.deepEqual(b[3], [15, 0, 65, 20], 'with room: one line, as wide as its text');
    assert.deepEqual(b[6], [15, 20, 35, 40], 'narrow: shrunk to the room left, two lines');
    assert.deepEqual(b[9], [0, 60, 40, 40], 'inside a box in a row: that box shrinks too, to the room left');
  });

  it('fits a box sized by its content to the room it has, as CSS fit-content, and follows its content and room', () => {
    /** @type {any} */
    let count;
    /** @type {any} */
    let width;
    /** @type {any} */
    let left;
    const { boxes, commands } = page(() => {
      count = $signal($active(), 3);
      width = $signal($active(), 200);
      left = $signal($active(), 50);
      const squares = () => Array.from({ length: $read(count) }, () => <View style={{ width: 100, height: 10 }} />);
      return (
        <View style={T}>
          <View style={() => ({ width: $read(width) })}>
            <View style={{ self: 'start', direction: 'row' }}>
              <View style={{ direction: 'row', wrap: true }}>{squares}</View>
            </View>
          </View>
          <View style={{ width: 200, height: 100 }}>
            <View style={() => ({ position: 'absolute', top: 0, left: $read(left) })}>
              <Label text="sends at once" style={{ wrap: true }} />
            </View>
          </View>
        </View>
      );
    });
    commands();
    let b = boxes();
    assert.deepEqual([b[2], b[3]], [[0, 0, 200, 20], [0, 0, 200, 20]], 'a row past its room: as wide as the room, its wrapping row on two lines');
    assert.deepEqual(b[8], [50, 20, 65, 20], 'an absolute box with room: its max-content, its text on one line');
    $write(count, 1);
    commands();
    b = boxes();
    assert.deepEqual([b[2], b[3]], [[0, 0, 100, 10], [0, 0, 100, 10]], 'its content less than the room: its max-content');
    $write(count, 3);
    $write(width, 150);
    commands();
    b = boxes();
    assert.deepEqual([b[2], b[3]], [[0, 0, 150, 30], [0, 0, 150, 30]], 'less room: one square a line');
    $write(width, 400);
    commands();
    b = boxes();
    assert.deepEqual([b[2], b[3]], [[0, 0, 300, 10], [0, 0, 300, 10]], 'more room than its content: its max-content again');
    $write(left, 170);
    commands();
    b = boxes();
    assert.deepEqual(b[8], [170, 10, 30, 60], 'an absolute box with less room than its text: as wide as the room its inset leaves it (30), a line a word');
    $write(left, 190);
    commands();
    assert.deepEqual(boxes()[8], [190, 10, 25, 60], 'less room than its longest word: as wide as that word (sends)');
  });

  it('keeps a word whole in text shrunk to its longest word, whatever its width rounds to', () => {
    // Widths a 32-bit float cannot hold: the layout's box is a hair narrower than the word.
    const odd = { ...mono, width: (/** @type {string} */ text) => text.length * 2.7 };
    const doc = new Document(odd, { width: 400, height: 200 });
    render(() => (
      <View style={{ direction: 'row', width: 10, ...T }}>
        <Label text="abcdefg hi" style={{ wrap: true }} />
      </View>
    ), doc);
    doc.present();
    assert.deepEqual(doc.commands().filter(c => c[0] === 'text').map(c => c[1]), ['abcdefg', 'hi']);
  });

  it('flexes a column of set height', () => {
    const { boxes } = page(() => (
      <View style={{ height: 100 }}>
        <View style={{ height: 20 }} />
        <View style={{ grow: 1 }} />
      </View>
    ));
    assert.deepEqual(boxes().slice(1), [
      [0, 0, 400, 20],
      [0, 20, 400, 80],
    ]);
  });

  it("sizes Actions and Edits from the theme: a field high, an Edit the entry width at least", () => {
    const { boxes } = page(() => (
      <View>
        <View style={{ direction: 'row', align: 'start' }}>
          <Action text="Go" />
          <Edit label="Name" value="" />
          <Edit value="" style={{ width: 120 }} />
        </View>
        <Edit value="" />
      </View>
    ));
    const [, row, go, name, narrow, wide] = boxes();
    assert.deepEqual(go, [0, 0, 37, 38], 'text 17 wide and the inset on both sides; the field height');
    assert.deepEqual(name, [37, 0, 200, 38], 'the entry width');
    assert.deepEqual(narrow, [237, 0, 120, 38], 'a set width replaces the entry minimum');
    assert.deepEqual(wide, [0, 38, 400, 38], 'stretched in a column');
    assert.equal(row[3], 38);
  });

  it('passes text down as CSS inherits it, and draws it aligned, bold and underlined', () => {
    const { commands } = page(() => (
      <View style={{ color: '#ff0000', fontSize: 20, fontWeight: 'bold', textAlign: 'center', width: 100 }}>
        <Label text="ab" style={{ underline: true }} />
        <Action text="x" />
      </View>
    ));
    const texts = commands().filter(c => c[0] === 'text');
    // Line height 28 (20 × 1.4): the baseline is half the leading (4) and the ascent (16) down.
    assert.deepEqual(texts[0], ['text', 'ab', 40, 20, 20, '#ffff0000', 1]);
    assert.ok(commands().some(c => c[0] === 'line' && c[1] === 40 && c[3] === 60), 'the underline under the text');
    assert.equal(texts[1][4], 20, 'an Action takes the size (font: inherit)');
    assert.equal(texts[1][5], '#ffffffff', 'but keeps its own color');
  });

  it('paints the box: shadow, background, border and opacity', () => {
    const { commands } = page(() => (
      <View style={{ width: 50, height: 20, background: '#00ff00', border: 2, borderColor: '#0000ff', radius: 4, shadow: { x: 1, y: 2, blur: 6, color: '#00000080' }, opacity: 0.5 }} />
    ));
    assert.deepEqual(commands().slice(2, 7), [
      ['layer', 0.5],
      ['shadow', 1, 2, 51, 22, '#80000000', 4, 6],
      ['round', 0, 0, 50, 20, '#ff00ff00', 4],
      ['border', 0, 0, 50, 20, '#ff0000ff', 4, 2],
      ['restore'],
    ]);
  });

  it('clips children to a box that hides its overflow', () => {
    const { commands } = page(() => (
      <View style={{ height: 10, overflow: 'hidden' }}>
        <View style={{ height: 30, background: '#000' }} />
      </View>
    ));
    const at = commands().findIndex(c => c[0] === 'rect' && c[5] === '#ff000000');
    assert.deepEqual(commands()[at - 1], ['clip', 0, 0, 400, 10]);
  });

  it('styles hover and press states as the pointer moves, presses and leaves', () => {
    const { doc, commands } = page(() => <Action text="h" style={{ background: '#111111', hover: { background: '#222222' }, press: { background: '#333333' } }} />);
    const fill = () => commands().find(c => c[0] === 'round')?.[5];
    assert.equal(fill(), '#ff111111');
    doc.move(5, 5);
    assert.equal(fill(), '#ff222222');
    doc.press(5, 5);
    assert.equal(fill(), '#ff333333');
    doc.release(5, 5);
    assert.equal(fill(), '#ff222222');
    doc.leave();
    assert.equal(fill(), '#ff111111');
  });

  it('reports, in development, what a style holds that a canvas cannot draw', () => {
    /** @type {string[]} */
    const reports = [];
    $development(true, message => reports.push(message));
    try {
      page(() => <View style={{ letterSpacing: 1, background: 'red', color: '#000' }} />);
    } finally {
      $development(false, null);
    }
    assert.equal(reports.length, 2);
    assert.match(reports[0], /the style names letterSpacing are not portable/);
    assert.match(reports[1], /the background "red" is not a portable color/);
  });

  it("places an Action's caption as the DOM lays it out: one flex item, by justify along and align across", () => {
    // A 100 × 40 box, text 10 wide on a 20 high line, its baseline 13 below the line's top.
    /** @type {[Record<string, any>, number, number][]} */
    const cases = [
      [{}, 45, 23],
      [{ justify: 'start', align: 'center' }, 45, 13],
      [{ justify: 'start', align: 'start', textAlign: 'end' }, 0, 13],
      [{ justify: 'end', align: 'end' }, 90, 33],
      [{ direction: 'row', justify: 'start', align: 'center' }, 0, 23],
      [{ direction: 'row', justify: 'end' }, 90, 13],
      [{ justify: 'between', textAlign: 'start' }, 0, 13],
    ];
    for (const [style, x, y] of cases) {
      const doc = new Document(mono, { width: 200, height: 100 });
      render(() => <Action text="ab" style={{ width: 100, height: 40, padding: 0, border: 0, fontSize: 10, lineHeight: 2, ...style }} />, doc);
      doc.present();
      const text = doc.commands().find(c => c[0] === 'text');
      assert.deepEqual([text?.[2], text?.[3]], [x, y], JSON.stringify(style));
      doc.close();
    }
  });

  it('takes a text width up to the next 64th of a pixel, as Blink lays text out', () => {
    // Characters 3.01 wide: 'abc' is 9.03, 'ab cd' wraps at its longest word 'ab' (6.02).
    const odd = { width: (/** @type {string} */ text) => text.length * 3.01, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };
    const doc = new Document(odd, { width: 200, height: 100 });
    /** @type {any} */
    let one = null;
    /** @type {any} */
    let wrap = null;
    render(() => (
      <View style={{ align: 'start' }}>
        <Label ref={(/** @type {any} */ n) => (one = n)} text="abc" />
        <View style={{ direction: 'row', width: 0 }}>
          <Label ref={(/** @type {any} */ n) => (wrap = n)} text="ab cd" style={{ wrap: true }} />
        </View>
      </View>
    ), doc);
    doc.present();
    assert.equal(one.getBoundingClientRect().width, 578 / 64, '9.03 up to 9.03125');
    assert.equal(wrap.getBoundingClientRect().width, 386 / 64, 'its min-content 6.02 up to 6.03125');
    doc.close();
  });

  it('takes each styled run of a Label up to its own 64th, as Blink sizes each span', () => {
    // Headless Chrome: six spans of 13px text are 157.84375 wide, their text as one 157.796875.
    const odd = { width: (/** @type {string} */ text) => text.length * 3.01, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };
    const doc = new Document(odd, { width: 200, height: 100 });
    /** @type {any} */
    let label = null;
    render(() => (
      <View style={{ align: 'start' }}>
        <Label ref={(/** @type {any} */ n) => (label = n)} runs={[{ text: 'a' }, { text: 'b', style: { color: '#f00' } }, { text: 'c' }]} />
      </View>
    ), doc);
    doc.present();
    assert.equal(label.getBoundingClientRect().width, (3 * 193) / 64, 'three runs of 3.01, each up to 3.015625');
    const xs = doc.commands().filter(c => c[0] === 'text').map(c => c[2]);
    assert.deepEqual(xs, [0, 193 / 64, 386 / 64], 'each run starts where the ones before end, snapped');
    doc.close();
  });

  it('lays lengths out in whole 64ths of a pixel toward zero, as Blink does', () => {
    // Headless Chrome: padding 0 13.2px around 10 is 36.375 wide, a gap of 6.3 between two 10s 26.296875,
    // width 10.3 is 10.296875, and a margin of -3.3 after a 10 puts the next at 6.703125.
    const { boxes } = page(() => (
      <View style={{ align: 'start' }}>
        <View style={{ padding: [0, 13.2] }}>
          <View style={{ width: 10, height: 10 }} />
        </View>
        <View style={{ direction: 'row', gap: 6.3 }}>
          <View style={{ width: 10, height: 10 }} />
          <View style={{ width: 10, height: 10 }} />
        </View>
        <View style={{ width: 10.3, height: 10 }} />
        <View style={{ direction: 'row' }}>
          <View style={{ width: 10, height: 10, shrink: 0 }} />
          <View style={{ width: 10, height: 10, shrink: 0, margin: [0, 0, 0, -3.3] }} />
        </View>
      </View>
    ));
    const all = boxes();
    assert.deepEqual([all[1][2], all[3][2], all[6][2], all[9][0]], [36.375, 26.296875, 10.296875, 6.703125]);
  });

  it('snaps a border to whole device pixels, and one thinner than a pixel to one, as Blink does', () => {
    // Headless Chrome: a 10px box with 0.25, 0.5, 0.75 or 1.6px borders is 12 wide, with 2.5px ones 14
    // (ren-core's boxes are border boxes: here the content sets the size).
    /** @type {any[]} */
    const boxes = [];
    const doc = new Document(mono, { width: 200, height: 100 });
    render(() => (
      <View style={{ align: 'start' }}>
        {[0.25, 0.5, 1.6, 2.5].map(w => (
          <View ref={(/** @type {any} */ n) => boxes.push(n)} style={{ border: w }}>
            <View style={{ width: 10, height: 10 }} />
          </View>
        ))}
      </View>
    ), doc);
    doc.present();
    assert.deepEqual(boxes.map(b => b.getBoundingClientRect().width), [12, 12, 12, 14]);
    // At two device pixels a logical one, half a pixel is a device pixel.
    doc.resize(200, 100, 2);
    assert.deepEqual(boxes.map(b => b.getBoundingClientRect().width), [11, 11, 13, 15]);
    doc.close();
  });

  it('makes a line box its size times its leading down to a 64th of a pixel, as Blink does', () => {
    // Headless Chrome: 14px at 1.55 is 21.6875 high, the tenth of ten such lines starts at 195.1875; 12px at 1.2 is 14.390625.
    const doc = new Document(mono, { width: 200, height: 400 });
    /** @type {any[]} */
    const rows = [];
    /** @type {any} */
    let small = null;
    render(() => (
      <View>
        {Array.from({ length: 10 }, () => <Label ref={(/** @type {any} */ n) => rows.push(n)} text="x" style={{ fontSize: 14, lineHeight: 1.55 }} />)}
        <Label ref={(/** @type {any} */ n) => (small = n)} text="x" style={{ fontSize: 12, lineHeight: 1.2 }} />
      </View>
    ), doc);
    doc.present();
    assert.equal(rows[0].getBoundingClientRect().height, 21.6875);
    assert.equal(rows[9].getBoundingClientRect().top, 195.1875);
    assert.equal(small.getBoundingClientRect().height, 14.390625);
    doc.close();
    // A fractional size is first taken to its nearest 64th: 10.4 at 1 is 10.40625, at 1.55 16.125; 13.3 at 1.2 is 15.953125.
    const odd = new Document(mono, { width: 200, height: 400 });
    /** @type {any[]} */
    const fractional = [];
    render(() => (
      <View>
        {[[10.4, 1], [10.4, 1.55], [13.3, 1.2]].map(([fontSize, lineHeight]) => <Label ref={(/** @type {any} */ n) => fractional.push(n)} text="x" style={{ fontSize, lineHeight }} />)}
      </View>
    ), odd);
    odd.present();
    assert.deepEqual(fractional.map(n => n.getBoundingClientRect().height), [10.40625, 16.125, 15.953125]);
    odd.close();
  });
});
