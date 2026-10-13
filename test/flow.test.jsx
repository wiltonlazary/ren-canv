// A Flow lays the primitives out without drawing them, for a renderer that
// draws them itself (ren-dom): the boxes a Document computes, here or in a
// layout worker, and only the items that moved after a change. Text at
// fontSize 10 is 5 wide per character, 20 high per line.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { View, Label, Action } from 'ren-core';
import { Document, Flow, CanvasFonts, render, loadLayout, remoteLayout, serveLayout } from 'ren-canv';
import { closeAfter } from './fixtures/after.js';


await loadLayout();

const mono = {
  width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2,
  metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
  close() {},
};
const card = { padding: 10, gap: 5, fontSize: 10, lineHeight: 2 };
const words = 'words that wrap in a column of two hundred';

/** The view on a Document, and its boxes relative to its top item. */
function reference() {
  const doc = new Document(mono, { width: 400, height: 600 });
  render(() => (
    <View style={card}>
      <Label text="title" />
      <View style={{ direction: 'row', gap: 4 }}>
        <View style={{ width: 200 }}><Label wrap text={words} /></View>
        <Action text="go" style={{ grow: 1 }} />
      </View>
      <View style={{ display: 'grid', columns: '1fr 1fr', gap: 4 }}><Label text="a" /><Label text="b" /></View>
    </View>
  ), doc);
  const out = boxes(doc.root.first, item => doc.boxes.fix(item));
  doc.close();
  return out;
}

/** Every item's box below and including `top`, [x, y, w, h] in its parent. @param {any} top @param {(item: any) => void} [fix] */
function boxes(top, fix = () => {}) {
  /** @type {number[][]} */
  const out = [];
  /** @param {any} item */
  const walk = item => {
    fix(item);
    out.push([item.x, item.y, item.w, item.h]);
    for (let c = item.first; c !== null; c = c.next) if (c.kind !== 8 && c.kind !== 9) walk(c);
  };
  walk(top);
  out[0] = [0, 0, out[0][2], out[0][3]];
  return out;
}

/** The same primitives through a Flow's calls, as ren-dom makes them. @param {Flow} flow */
function build(flow) {
  /** @param {string} tag @param {Record<string, any>} props @param {any[]} [kids] */
  const make = (tag, props, kids = []) => {
    const item = flow.node(tag);
    for (const name in props) flow.set(item, name, props[name]);
    for (const kid of kids) flow.insert(item, kid, null);
    return item;
  };
  const wrap = make('Label', { wrap: true, text: words });
  const top = make('View', { style: card }, [
    make('Label', { text: 'title' }),
    make('View', { style: { direction: 'row', gap: 4 } }, [make('View', { style: { width: 200 } }, [wrap]), make('Action', { text: 'go', style: { grow: 1 } })]),
    make('View', { style: { display: 'grid', columns: '1fr 1fr', gap: 4 } }, [make('Label', { text: 'a' }), make('Label', { text: 'b' })]),
  ]);
  flow.island(top, 400);
  return { top, wrap };
}

describe('ren canv flow', () => {
  it('lays out as a Document does, and reports only what moved', () => {
    const flow = new Flow(mono);
    const { top, wrap } = build(flow);
    /** @type {any[]} */
    let moved = [];
    flow.arrange(list => (moved = list));
    assert.deepEqual(boxes(top), reference());
    assert.ok(moved.includes(top) && moved.includes(wrap), 'the first layout places every item');
    flow.set(wrap, 'text', 'shorter');
    flow.arrange(list => (moved = list));
    assert.ok(moved.includes(wrap));
    assert.ok(!moved.some(item => item.text === 'a' || item.caption === 'a'), 'the grid did not move');
    assert.deepEqual(flow.offset(top), [0, 0]);
    flow.close();
  });

  it("places a boxless row's cells in its parent's padding box, where the DOM positions them", () => {
    const flow = new Flow(mono);
    const top = flow.node('View');
    const row = flow.node('View');
    const a = flow.node('Label');
    const b = flow.node('Label');
    flow.set(top, 'style', { display: 'grid', columns: '100px 1fr', border: 3, padding: 2, fontSize: 10, lineHeight: 2 });
    flow.set(row, 'style', { display: 'contents' });
    flow.set(a, 'text', 'a');
    flow.set(b, 'text', 'b');
    flow.insert(row, a, null);
    flow.insert(row, b, null);
    flow.insert(top, row, null);
    flow.island(top, 400);
    /** @type {any[]} */
    let moved = [];
    flow.arrange(list => (moved = list));
    assert.ok(moved.includes(a) && moved.includes(b));
    // Its box is empty; its cells sit in the grid, inside the top's border (display: contents on the DOM).
    assert.deepEqual([row.w, row.h], [0, 0]);
    assert.deepEqual(flow.offset(a), [2, 2]);
    assert.deepEqual(flow.offset(b), [102, 2]);
    flow.close();
  });

  it('snaps borders at its scale, as the browser at that pixel ratio', () => {
    // At two device pixels a logical one, a half-pixel border is a device pixel: 0.5 wide, not 1.
    const flow = new Flow(mono, { scale: 2 });
    const top = flow.node('View');
    const framed = flow.node('View');
    const inner = flow.node('View');
    flow.set(top, 'style', { align: 'start' });
    flow.set(framed, 'style', { border: 0.5 });
    flow.set(inner, 'style', { width: 10, height: 10 });
    flow.insert(framed, inner, null);
    flow.insert(top, framed, null);
    flow.island(top, 100);
    flow.arrange(() => {});
    assert.equal(framed.w, 11);
    flow.rescale(1);
    flow.arrange(() => {});
    assert.equal(framed.w, 12, 'at scale 1 a whole pixel');
    flow.close();
  });

  it("takes a new theme's metrics: a field's height, an entry's width, the text size", () => {
    const flow = new Flow(mono, { theme: { field: 30, entry: 100, text: 10, leading: 2 } });
    const top = flow.node('View');
    const edit = flow.node('Edit');
    const label = flow.node('Label');
    flow.set(top, 'style', { align: 'start' });
    flow.set(label, 'text', 'abcd');
    flow.insert(top, edit, null);
    flow.insert(top, label, null);
    flow.island(top, 400);
    flow.arrange(() => {});
    assert.deepEqual([edit.w, edit.h, label.w, label.h], [100, 30, 20, 20]);
    /** @type {any[]} */
    let moved = [];
    flow.retheme({ field: 40, entry: 160, text: 20, leading: 1.5 });
    flow.arrange(list => (moved = list));
    assert.deepEqual([edit.w, edit.h, label.w, label.h], [160, 40, 40, 30], 'laid out on the new metrics');
    assert.ok(moved.includes(edit) && moved.includes(label), 'reported as moved');
    flow.close();
  });

  it('lays out in a layout worker', { timeout: 30000 }, async t => {
    const channel = new MessageChannel();
    const stop = serveLayout(channel.port2);
    const layout = remoteLayout(channel.port1);
    const flow = new Flow(mono, { layout });
    // Closed after the test however it ends, a timeout too (a finally would wait on the hung await).
    closeAfter(t, () => {
      flow.close();
      layout.close();
      stop();
      channel.port1.close();
    });
    const { top } = build(flow);
    const moved = await new Promise(resolve => flow.arrange(resolve));
    assert.ok(moved.length > 0);
    assert.deepEqual(boxes(top), reference());
  });
  it('CanvasFonts keeps widths for a bounded number of set sizes (an animated font size)', () => {
    // A 2D context stand-in: text is half its font's px size wide per character.
    const context = { font: '', measured: 0, measureText(/** @type {string} */ text) { this.measured++; return { width: (text.length * parseFloat(/** @type {string[]} */ (/([\d.]+)px/.exec(this.font))[1])) / 2 }; } };
    const fonts = new CanvasFonts(context, 'sans-serif');
    /** @type {[number, number][]} */
    const got = [];
    for (let k = 0; k < 500; k++) got.push([12 + k * 0.01, fonts.width('animated', 12 + k * 0.01)]);
    assert.ok(fonts.cache.size <= 64, `${fonts.cache.size} width caches`);
    for (const [size, width] of got) assert.equal(width, 4 * (Math.floor(size * 64 + 1e-6) / 64), `${size} measured at the size text is set at`);
    // Keyed by face and set size: sizes within one 64th share the entry, faces do not.
    const before = context.measured;
    fonts.width('a', 20);
    fonts.width('a', 20.01);
    assert.equal(context.measured, before + 1);
    fonts.width('a', 20, 1);
    assert.equal(context.measured, before + 2);
    assert.equal(fonts.width('a', 20, 1), 10);
    fonts.close();
  });
});
