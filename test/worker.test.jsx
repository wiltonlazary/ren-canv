// Layout in a worker: a Document whose `layout` is a port to `serveLayout`
// lays out exactly as one laid out in its own thread, through every kind of
// change, and paints once the answer comes. Text at fontSize 10 is 5 wide
// per character, 20 high per line.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { $signal, $read, $write } from 'rrx-core';
import { $active, View, Label, Action, Scroll, Show, For, Edit } from 'ren-core';
import { Document, render, attach, loadLayout, remoteLayout, serveLayout, useLayout } from 'ren-canv';
import { Window } from 'happy-dom';
import { closeAfter } from './fixtures/after.js';


/** The layout engine (Taffy's WebAssembly), once, for the Documents laid out here. */
await loadLayout();

const mono = {
  width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2,
  metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
  close() {},
};

/** Every item's page box, [x, y, w, h], in order. @param {Document} doc */
function boxes(doc) {
  /** @type {number[][]} */
  const out = [];
  /** @param {any} item @param {number} x @param {number} y */
  const walk = (item, x, y) => {
    for (let c = item.first; c !== null; c = c.next) {
      if (c.kind === 8 || c.kind === 9 || c.hidden) continue;
      doc.boxes.fix(c);
      out.push([x + c.x, y + c.y, c.w, c.h]);
      walk(c, x + c.x, y + c.y);
    }
  };
  walk(doc.root, 0, 0);
  walk(doc.overlay, 0, 0);
  return out;
}

/**
 * Waits until a Document's layout worker has answered and it painted what
 * changed: each frame it paints (`framed`) ends a wait, and a layout in flight
 * is what paints next. @param {Document} doc
 */
async function settled(doc) {
  while (doc.boxes.engine.busy || doc.damage) {
    assert.ok(doc.boxes.engine.busy, 'damage with no layout in flight: nothing paints it');
    await new Promise(resolve => (doc.framed = resolve));
  }
  doc.framed = null;
}

/** A view with every kind of layout change: text that wraps, a grid (of boxless rows), a scroll, rows that come and go, a hover style that moves boxes. */
function App() {
  /** @type {any} */
  const app = {};
  app.view = () => {
    const R = $active();
    const rows = (app.rows = $signal(R, [1, 2, 3]));
    const text = (app.text = $signal(R, 'a few words that wrap in a narrow column'));
    const shown = (app.shown = $signal(R, true));
    const gap = (app.gap = $signal(R, 4));
    return (
      <View style={() => ({ padding: 8, gap: $read(gap), fontSize: 10, lineHeight: 2 })}>
        <View style={{ direction: 'row', gap: 6 }}>
          <View style={{ width: 90 }}>
            <Label wrap text={() => $read(text)} />
          </View>
          <Label text="beside" style={{ grow: 1, hover: { padding: 6 } }} />
        </View>
        <View style={{ display: 'grid', columns: 'repeat(3, 1fr)', gap: 4 }}>
          {/* Rows with no box of their own: their cells sit in the grid. */}
          <For each={() => $read(rows)}>{(/** @type {number} */ n) => <View role="row" style={{ display: 'contents' }}><Label text={`cell ${n}`} /><Label text={`next ${n}`} /></View>}</For>
        </View>
        <Show when={() => $read(shown)}>
          <Scroll style={{ height: 50 }}>
            <For each={() => $read(rows)}>{(/** @type {number} */ n) => <Action text={`row ${n}`} />}</For>
          </Scroll>
        </Show>
      </View>
    );
  };
  return app;
}

describe('ren canv layout in a worker', () => {
  it('lays out as this thread does, through every change, and paints when the answer comes', { timeout: 30000 }, async t => {
    const channel = new MessageChannel();
    const stop = serveLayout(channel.port2);
    const layout = remoteLayout(channel.port1);
    const here = App();
    const there = App();
    const local = new Document(mono, { width: 300, height: 400 });
    const remote = new Document(mono, { width: 300, height: 400, layout });
    // Closed after the test however it ends, a timeout too (a finally would wait on the hung await).
    closeAfter(t, () => {
      local.close();
      remote.close();
      layout.close();
      stop();
      channel.port1.close();
    });
    render(here.view, local);
    render(there.view, remote);
    assert.equal(remote.frames, 0, 'it paints once the worker answers');
    await settled(remote);
    assert.equal(remote.frames, 1);
    assert.deepEqual(boxes(remote), boxes(local));
    assert.deepEqual(remote.commands(), local.commands(), 'the same frame');
    /** @param {(app: any) => void} change */
    const both = async change => {
      change(here);
      change(there);
      local.present();
      remote.present();
      await settled(remote);
      assert.deepEqual(boxes(remote), boxes(local));
      assert.deepEqual(remote.commands(), local.commands());
    };
    await both(app => $write(app.text, 'now a much longer text that wraps onto more rows than before'));
    await both(app => $write(app.rows, [3, 1, 4, 5, 9, 2, 6]));
    await both(app => $write(app.gap, 12));
    await both(app => $write(app.shown, false));
    await both(app => $write(app.rows, [2]));
    await both(app => $write(app.shown, true));
    // A hover style that pads the Label moves it: hover it on both.
    for (const doc of [local, remote]) doc.move(250, 20);
    local.present();
    await settled(remote);
    assert.deepEqual(boxes(remote), boxes(local));
    // A resize lays out again at the new width.
    local.resize(220, 300);
    remote.resize(220, 300);
    await settled(remote);
    assert.deepEqual(boxes(remote), boxes(local));
    assert.deepEqual(remote.commands(), local.commands());
  });

  it('paints a change that moves nothing at once, with no round trip', { timeout: 30000 }, async t => {
    const channel = new MessageChannel();
    const stop = serveLayout(channel.port2);
    const layout = remoteLayout(channel.port1);
    /** @type {any} */
    let color = null;
    const doc = new Document(mono, { width: 200, height: 200, layout });
    // Closed after the test however it ends, a timeout too (a finally would wait on the hung await).
    closeAfter(t, () => {
      doc.close();
      layout.close();
      stop();
      channel.port1.close();
    });
    render(() => {
      color = $signal($active(), '#ff0000');
      return <View><Label text="still" style={() => ({ color: $read(color) })} /></View>;
    }, doc);
    await settled(doc);
    const frames = doc.frames;
    $write(color, '#0000ff');
    doc.present();
    assert.equal(doc.frames, frames + 1, 'painted in the same call');
    assert.equal(doc.boxes.engine.busy, false);
  });

  it('keeps apart the trees of two remoteLayout ports on one worker', { timeout: 30000 }, async t => {
    const channel = new MessageChannel();
    const stop = serveLayout(channel.port2);
    const first = remoteLayout(channel.port1);
    const second = remoteLayout(channel.port1);
    const a = new Document(mono, { width: 200, height: 200, layout: first });
    const b = new Document(mono, { width: 300, height: 300, layout: second });
    const local = new Document(mono, { width: 300, height: 300 });
    render(() => <View><View style={{ width: 40, height: 40 }} /></View>, a);
    const view = () => <View style={{ padding: 30, fontSize: 10, lineHeight: 2 }}><Label text="hello world" /><View style={{ width: 90, height: 70 }} /></View>;
    render(view, b);
    render(view, local);
    local.present();
    // Closed after the test however it ends, a timeout too (a finally would wait on the hung await).
    closeAfter(t, () => {
      a.close();
      b.close();
      local.close();
      first.close();
      second.close();
      stop();
      channel.port1.close();
    });
    await Promise.all([settled(a), settled(b)]);
    assert.deepEqual(boxes(b), boxes(local), 'the second port\'s Document lays out as its own tree');
    assert.deepEqual(boxes(a), [[0, 0, 200, 40], [0, 0, 40, 40]]);
  });

  it('lays out nothing that waited for an engine once stopped', { timeout: 30000 }, async t => {
    const worker = new Worker(new URL('./fixtures/stop-worker.js', import.meta.url));
    // Closed after the test however it ends, a timeout too (a finally would wait on the hung await).
    closeAfter(t, async () => {
      await worker.terminate();
    });
    const report = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    assert.deepEqual(report, { made: 0, posted: 0, error: null }, 'an engine set after the stop builds no tree and answers nothing');
  });

  it('gives the native entry the draft before it edits, while a frame waits on the layout: a chord, a paste', { timeout: 30000 }, async t => {
    const window = new Window();
    const channel = new MessageChannel();
    const stop = serveLayout(channel.port2);
    const layout = remoteLayout(channel.port1);
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300, layout });
    /** @type {any} */
    let edit = null;
    render(() => {
      const value = $signal($active(), 'one two');
      // A Label that follows the value: each change lays out again, in the worker.
      return <View><Edit ref={(/** @type {any} */ e) => (edit = e)} value={value} onChange={(/** @type {any} */ e) => $write(value, e.value)} /><Label text={() => $read(value)} /></View>;
    }, doc);
    const detach = attach(doc, canvas);
    closeAfter(t, async () => {
      detach();
      doc.close();
      layout.close();
      stop();
      channel.port1.close();
      await window.happyDOM.close();
    });
    await settled(doc);
    edit.focus();
    doc.present();
    await settled(doc);
    doc.select(-1, 7);
    await settled(doc);
    const area = /** @type {any} */ (window.document.activeElement);
    assert.equal(area.tagName, 'TEXTAREA');
    const press = (/** @type {any} */ init) => {
      const e = new window.KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      area.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // Typed through the renderer: its frame waits on the worker's layout.
    press({ key: ' ' });
    press({ key: 'x' });
    assert.equal(doc.current?.draft, 'one two x');
    assert.equal(doc.boxes.engine.busy, true, 'a layout in flight');
    assert.equal(press({ key: 'Backspace', ctrlKey: true }), false, 'the chord is the textarea\'s');
    assert.deepEqual([area.value, area.selectionStart, area.selectionEnd], ['one two x', 9, 9], 'which holds the draft and caret it edits');
    press({ key: 'y' });
    assert.equal(doc.current?.draft, 'one two xy');
    area.dispatchEvent(new window.Event('paste', { bubbles: true, cancelable: true }));
    assert.deepEqual([area.value, area.selectionStart], ['one two xy', 10], 'a paste too');
    await settled(doc);
  });

  it('serves layout from a worker thread', { timeout: 30000 }, async t => {
    const worker = new Worker(new URL('./fixtures/layout-worker.js', import.meta.url));
    // Closed after the test however it ends, a timeout too (a finally would wait on the hung await).
    closeAfter(t, async () => {
      await worker.terminate();
    });
    const layout = remoteLayout(worker);
    const here = App();
    const there = App();
    const local = new Document(mono, { width: 300, height: 400 });
    const remote = new Document(mono, { width: 300, height: 400, layout });
    render(here.view, local);
    render(there.view, remote);
    await settled(remote);
    assert.deepEqual(boxes(remote), boxes(local));
    $write(there.rows, [7, 8]);
    $write(here.rows, [7, 8]);
    local.present();
    remote.present();
    await settled(remote);
    assert.deepEqual(boxes(remote), boxes(local));
    local.close();
    remote.close();
    layout.close();
  });
});

describe('ren canv layout engine', () => {
  it('is replaceable: an engine set by useLayout gets plain CSS boxes, and lays the page out', async () => {
    const { Taffy } = await import('../src/taffy.js');
    /** @type {any[]} */
    const defined = [];
    // An engine of its own: here Taffy behind a wrapper that records what it is given.
    useLayout(() => {
      const inner = new Taffy();
      return {
        leaf: () => inner.leaf(),
        define: box => (defined.push(box), inner.define(box)),
        undefine: style => inner.undefine(style),
        set: (node, style) => inner.set(node, style),
        sized: (node, style, minWidth, minHeight, basis) => inner.sized(node, style, minWidth, minHeight, basis),
        children: (node, kids) => inner.children(node, kids),
        remove: node => inner.remove(node),
        compute: (node, width) => inner.compute(node, width),
        read: (node, out) => inner.read(node, out),
        close: () => inner.close(),
      };
    });
    try {
      const doc = new Document(mono, { width: 200, height: 200 });
      render(() => <View style={{ padding: 10, display: 'grid', columns: '1fr 1fr', fontSize: 10, lineHeight: 2 }}><Label text="ab" /><Label text="cd" /></View>, doc);
      assert.deepEqual(boxes(doc), [[0, 0, 200, 40], [10, 10, 90, 20], [100, 10, 90, 20]]);
      doc.close();
      assert.ok(defined.length > 0);
      for (const box of defined) {
        assert.deepEqual(box, JSON.parse(JSON.stringify(box)), 'plain data');
        assert.ok(['flex', 'grid', 'none'].includes(box.display) && ['row', 'column'].includes(box.direction));
      }
      assert.ok(defined.some(box => box.display === 'grid' && box.columns === '1fr 1fr'), 'grid as CSS text');
    } finally {
      await loadLayout();
      useLayout(() => new Taffy());
    }
  });
});
