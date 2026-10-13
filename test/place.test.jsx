// Placement as CSS has it: absolute items placed by their insets against
// their parent's padding box, relative ones moved by them, percent sizes,
// and stacking contexts (zIndex) painted and hit in z order; the damage of
// a change of order alone; an item's getBoundingClientRect. The numbers are
// what a browser computes for the CSS ren-dom writes (every primitive
// positioned relative, border-box sizes).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { $root, $signal, $read, $write } from 'rrx-core';
import { View, Label, Edit, Scroll, Action, Portal, Show, $active, $moves } from 'ren-core';
import { Document, render, loadLayout, remoteLayout, serveLayout } from 'ren-canv';
import { closeAfter } from './fixtures/after.js';


await loadLayout();

/** Every character is half its size wide. */
const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };

/** A Document that draws: it keeps the damage of each frame. */
class Probe extends Document {
  /** @param {any} [options] */
  constructor(options) {
    super(mono, { width: 200, height: 200, ...options });
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

/** The fills of a frame, by color, in painting order. @param {Document} doc */
const fills = doc => doc.commands().filter(c => c[0] === 'rect').map(c => c[5]);
/** An item's rectangle as [x, y, width, height]. @param {any} item */
const rect = item => {
  const r = item.getBoundingClientRect();
  // The engine keeps 32-bit floats.
  return [r.x, r.y, r.width, r.height].map(v => Math.round(v * 1000) / 1000);
};

describe('ren canv placement and stacking', () => {
  it('places absolute items by their insets in the padding box, moves relative ones, and takes percentages', () => {
    const doc = new Probe();
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ padding: 10 }}>
        <View ref={(/** @type {any} */ n) => (refs.box = n)} style={{ width: 120, height: 80, padding: 6, border: 2 }}>
          <View ref={(/** @type {any} */ n) => (refs.cover = n)} style={{ position: 'absolute', inset: 0 }} />
          <View ref={(/** @type {any} */ n) => (refs.below = n)} style={{ position: 'absolute', top: '100%', left: 0, width: '50%', height: 20 }} />
          <View ref={(/** @type {any} */ n) => (refs.corner = n)} style={{ position: 'absolute', right: 4, bottom: '10%', width: 10, height: 10 }} />
          <View ref={(/** @type {any} */ n) => (refs.flow = n)} style={{ height: 10, width: '50%' }} />
          <View ref={(/** @type {any} */ n) => (refs.moved = n)} style={{ height: 10, top: 5, left: -3 }} />
          <View ref={(/** @type {any} */ n) => (refs.next = n)} style={{ height: 10 }} />
        </View>
      </View>
    ), doc);
    assert.deepEqual(rect(refs.box), [10, 10, 120, 80]);
    assert.deepEqual(rect(refs.cover), [12, 12, 116, 76], 'inset 0: the padding box');
    assert.deepEqual(rect(refs.below), [12, 88, 58, 20], "top 100%: under it; width 50% of the padding box");
    assert.deepEqual(rect(refs.corner), [10 + 120 - 2 - 4 - 10, 10 + 80 - 2 - 7.6 - 10, 10, 10]);
    assert.deepEqual(rect(refs.flow), [18, 18, 52, 10], 'in the flow, 50% of the content box; the absolute ones take no room');
    assert.deepEqual(rect(refs.moved), [15, 33, 104, 10], 'relative: moved from where the flow puts it');
    assert.deepEqual(rect(refs.next), [18, 38, 104, 10], 'and the flow goes on as if it had not moved');
    doc.close();
  });

  it('paints stacking contexts in z order over the flow, negatives under it, and gives the press to the topmost', () => {
    const doc = new Probe();
    /** @type {string[]} */
    const pressed = [];
    const at = { position: 'absolute', top: 0, left: 0, width: 50, height: 50 };
    render(() => (
      <View style={{ height: 200 }}>
        <View style={{ height: 100, background: '#111111' }}>
          <View style={{ ...at, zIndex: -1, background: '#000001' }} />
          <View style={{ ...at, zIndex: 2, background: '#000002' }} onPointerDown={() => pressed.push('two')} />
          <View style={{ ...at, zIndex: 1, background: '#000003' }} onPointerDown={() => pressed.push('one')} />
          <View style={{ ...at, background: '#000004' }} onPointerDown={() => pressed.push('flow')} />
          <View style={{ ...at, zIndex: 0, background: '#000005' }} />
        </View>
        <View style={{ height: 100, margin: [-100, 0, 0, 0], background: '#222222' }} onPointerDown={() => pressed.push('later')} />
      </View>
    ), doc);
    assert.deepEqual(fills(doc), ['#ff000001', '#ff111111', '#ff000004', '#ff000005', '#ff222222', '#ff000003', '#ff000002'],
      'the negative under its parent\'s fill (the page is the context), auto and 0 in tree order, then 1 and 2 over what follows');
    doc.press(10, 10);
    assert.deepEqual(pressed, ['two']);
    doc.press(80, 80);
    assert.deepEqual(pressed, ['two', 'later'], 'the flow item over the one before it');
    doc.close();
  });

  it('keeps a context\'s children inside it: a z within a lower context stays under a higher one', () => {
    const doc = new Probe();
    const at = { position: 'absolute', top: 0, left: 0, width: 50, height: 50 };
    render(() => (
      <View>
        <View style={{ ...at, zIndex: 1 }}>
          <View style={{ ...at, zIndex: 100, background: '#000001' }} />
        </View>
        <View style={{ ...at, zIndex: 2, background: '#000002' }} />
        <View style={{ ...at, opacity: 0.5 }}>
          <View style={{ ...at, zIndex: -5, background: '#000003' }} />
        </View>
      </View>
    ), doc);
    assert.deepEqual(fills(doc), ['#ff000003', '#ff000001', '#ff000002'], 'an opacity is a context at 0: its negative child stays in it');
    doc.close();
  });

  it('draws what is placed out of the flow where its parent is not drawn, and past a long column', () => {
    const doc = new Probe();
    const rows = Array.from({ length: 40 }, (_, i) => i);
    render(() => (
      <View>
        <View style={{ height: 0 }}>
          <View style={{ position: 'absolute', top: 10, left: 0, width: 20, height: 20, background: '#000001' }} />
        </View>
        {rows.map(i => <View style={{ height: 20, background: i === 0 ? '#000009' : '#eeeeee' }} />)}
        <View style={{ position: 'absolute', top: 0, left: 100, width: 20, height: 20, background: '#000002' }} />
      </View>
    ), doc);
    const all = fills(doc);
    assert.ok(all.includes('#ff000001'), 'in a parent with no height');
    assert.ok(all.includes('#ff000002'), 'after rows below the viewport');
    assert.ok(all.indexOf('#ff000001') < all.indexOf('#ff000009'), 'the page is its context: a later row paints over it');
    doc.close();
  });

  it('repaints what a change of stacking order alone changes', () => {
    const doc = new Probe();
    /** @type {any} */
    let z = null;
    const at = { position: 'absolute', top: 20, left: 20, width: 40, height: 40 };
    render(() => {
      z = $signal($active(), 1);
      return (
        <View style={{ height: 200 }}>
          <View style={() => ({ ...at, zIndex: $read(z), background: '#000001' })} />
          <View style={{ ...at, left: 40, zIndex: 2, background: '#000002' }} />
        </View>
      );
    }, doc);
    assert.equal(doc.repaint, 'full');
    $write(z, 3);
    doc.present();
    assert.deepEqual(fills(doc), ['#ff000002', '#ff000001']);
    assert.equal(doc.repaint, 'damage', 'the same pieces, in another order');
    const d = /** @type {number[][]} */ (doc.damaged);
    assert.ok(d.some(([l, t, r, b]) => l <= 40 && t <= 20 && r >= 60 && b >= 60), `the overlap is damaged: ${JSON.stringify(d)}`);
    doc.close();
  });

  it('measures an item as the DOM does: its border box on the canvas, scrolls applied', () => {
    const doc = new Probe({ height: 100 });
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ padding: 5 }}>
        <Scroll ref={(/** @type {any} */ n) => (refs.scroll = n)} style={{ height: 60, border: 1 }}>
          <View style={{ height: 50, shrink: 0 }} />
          <View ref={(/** @type {any} */ n) => (refs.inner = n)} style={{ height: 30, margin: [0, 7], shrink: 0 }} />
          <View style={{ height: 50, shrink: 0 }} />
        </Scroll>
        <View style={{ height: 300 }} />
      </View>
    ), doc);
    assert.deepEqual(refs.inner.getBoundingClientRect(), { x: 13, y: 56, left: 13, top: 56, right: 13 + refs.inner.w, bottom: 86, width: refs.inner.w, height: 30 });
    refs.scroll.scrollTop = 20;
    doc.present();
    assert.equal(refs.inner.getBoundingClientRect().y, 36, "the Scroll's offset");
    doc.wheel(150, 90, 40);
    doc.present();
    assert.equal(doc.page, 40);
    assert.equal(refs.inner.getBoundingClientRect().y, -4, "and the page's");
    doc.close();
  });

  it('keeps an aspect ratio: the size not set follows the one that is', () => {
    const doc = new Probe({ width: 400 });
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ align: 'start' }}>
        <View ref={(/** @type {any} */ n) => (refs.wide = n)} style={{ width: 160, aspectRatio: 16 / 9 }} />
        <View ref={(/** @type {any} */ n) => (refs.tall = n)} style={{ height: 50, aspectRatio: 2 }} />
        <View style={{ width: 200, align: 'stretch' }}>
          <View ref={(/** @type {any} */ n) => (refs.fill = n)} style={{ aspectRatio: 4 }} />
        </View>
      </View>
    ), doc);
    doc.present();
    assert.deepEqual(rect(refs.wide).slice(2), [160, 90]);
    assert.deepEqual(rect(refs.tall).slice(2), [100, 50]);
    assert.deepEqual(rect(refs.fill).slice(2), [200, 50], 'stretched across, its height follows');
    doc.close();
  });

  it('lays the overlay out as high as the viewport, as a portal layer covering it', () => {
    const doc = new Probe({ width: 480, height: 360 });
    /** @type {any} */
    let cover = null;
    /** @type {any} */
    let half = null;
    render(() => (
      <Portal>
        <View ref={(/** @type {any} */ n) => (cover = n)} style={{ position: 'absolute', inset: 0 }} />
        <View ref={(/** @type {any} */ n) => (half = n)} style={{ height: '50%' }} />
      </Portal>
    ), doc);
    doc.present();
    assert.deepEqual(rect(cover), [0, 0, 480, 360]);
    assert.deepEqual(rect(half), [0, 0, 480, 180], 'a percentage of the viewport height');
    doc.resize(300, 200);
    assert.deepEqual(rect(cover), [0, 0, 300, 200]);
    doc.close();
  });

  it('gives a press to the topmost box: a plain View over an Action keeps it', () => {
    const doc = new Probe();
    let presses = 0;
    render(() => (
      <View style={{ padding: 10, align: 'start' }}>
        <Action text="under" style={{ width: 100, height: 40 }} onPress={() => presses++} />
        <View style={{ position: 'absolute', top: 10, left: 10, width: 50, height: 40 }} />
      </View>
    ), doc);
    doc.present();
    doc.press(30, 30);
    doc.release(30, 30);
    assert.equal(presses, 0, 'the View is over the Action there');
    doc.press(90, 30);
    doc.release(90, 30);
    assert.equal(presses, 1, 'and not there');
    doc.close();
  });

  it('lets the pointer through an item with pointerEvents none, not its children with auto', () => {
    const doc = new Probe();
    /** @type {string[]} */
    const pressed = [];
    render(() => (
      <View style={{ padding: 10, align: 'start' }}>
        <Action text="under" style={{ width: 100, height: 40 }} onPress={() => pressed.push('under')} />
        <View style={{ position: 'absolute', top: 10, left: 10, width: 100, height: 40, pointerEvents: 'none' }} onPress={() => pressed.push('glass')}>
          <View style={{ width: 20, height: 40, pointerEvents: 'auto' }} onPress={() => pressed.push('knob')} />
        </View>
      </View>
    ), doc);
    doc.present();
    doc.press(60, 30);
    doc.release(60, 30);
    doc.press(15, 30);
    doc.release(15, 30);
    assert.deepEqual(pressed, ['under', 'knob', 'glass'], 'through the glass; the knob takes it, and bubbles');
    doc.close();
  });

  it('holds a sticky item at its Scroll\'s top, within its parent', () => {
    const doc = new Probe();
    /** @type {any} */
    let scroll = null;
    /** @type {any} */
    let head = null;
    render(() => (
      <Scroll ref={(/** @type {any} */ n) => (scroll = n)} style={{ height: 100, border: 1 }}>
        <View style={{ height: 150 }}>
          <View ref={(/** @type {any} */ n) => (head = n)} style={{ position: 'sticky', top: 0, height: 20, background: '#ff0000', zIndex: 1 }} />
          <View style={{ height: 130, background: '#00ff00' }} />
        </View>
        <View style={{ height: 300, shrink: 0, background: '#0000ff' }} />
      </Scroll>
    ), doc);
    const top = () => {
      doc.present();
      return /** @type {any[]} */ (doc.commands().find(c => c[0] === 'rect' && c[5] === '#ffff0000'))[2];
    };
    assert.equal(top(), 1, 'where the flow puts it');
    scroll.scrollTop = 60;
    assert.equal(top(), 1, 'held at the top of the scrollport');
    scroll.scrollTop = 140;
    assert.equal(top(), 1 + 150 - 20 - 140, 'carried off with its parent');
    assert.deepEqual(rect(head), [1, 1 + 150 - 20 - 140, 190, 20], 'its rect is where it is held, as the DOM\'s');
    scroll.scrollTop = 60;
    doc.present();
    assert.deepEqual(rect(head), [1, 1, 190, 20]);
    doc.close();
  });

  it('holds a sticky cell of a boxless row within the nearest box around it (the table), as CSS does', () => {
    // rui-core's stickyHeader Table: its head row is display contents, its cells sticky;
    // held within the row's empty box, they scrolled away on the canvases.
    for (const inScroll of [false, true]) {
      const doc = new Probe();
      /** @type {any} */
      let scroll = null;
      /** @type {any} */
      let head = null;
      const table = (
        <View style={{ display: 'grid', columns: '1fr 1fr', height: 150, border: 2, shrink: 0 }}>
          <View role="row" style={{ display: 'contents' }}>
            <View ref={(/** @type {any} */ n) => (head = n)} style={{ position: 'sticky', top: 0, height: 20, background: '#ff0000', zIndex: 1 }} />
            <View style={{ position: 'sticky', top: 0, height: 20, zIndex: 1 }} />
          </View>
          <View role="row" style={{ display: 'contents' }}>
            <View style={{ height: 124 }} />
            <View style={{ height: 124 }} />
          </View>
        </View>
      );
      render(() => (
        <Scroll ref={(/** @type {any} */ n) => (scroll = n)} style={{ height: 100, border: 1 }}>
          {inScroll ? table : <View>{table}</View>}
          <View style={{ height: 300, shrink: 0 }} />
        </Scroll>
      ), doc);
      const top = () => {
        doc.present();
        return /** @type {any[]} */ (doc.commands().find(c => c[0] === 'rect' && c[5] === '#ffff0000'))[2];
      };
      assert.equal(top(), 3, 'where the flow puts it, inside the table\'s border');
      scroll.scrollTop = 60;
      assert.equal(top(), 1, 'held at the top of the scrollport');
      assert.equal(rect(head)[1], 1, 'its rect too');
      scroll.scrollTop = 140;
      assert.equal(top(), 1 + 2 + 146 - 20 - 140, 'carried off with the table\'s content box');
      assert.equal(rect(head)[1], 1 + 2 + 146 - 20 - 140);
      doc.close();
    }
  });

  it('scrolls a Scroll across with axis x: deltaX, Shift and the wheel, scrollLeft, a bar along its bottom', () => {
    const doc = new Probe();
    /** @type {any} */
    let scroll = null;
    /** @type {number[]} */
    const lefts = [];
    render(() => (
      <Scroll ref={(/** @type {any} */ n) => (scroll = n)} axis="x" style={{ width: 100, height: 60 }} onScroll={(/** @type {any} */ e) => lefts.push(e.scrollLeft)}>
        <View style={{ width: 300, height: 30, shrink: 0, background: '#ff0000' }} />
      </Scroll>
    ), doc);
    doc.present();
    assert.deepEqual([scroll.scrollWidth, scroll.clientWidth], [300, 100]);
    doc.wheel(50, 20, 0, { deltaX: 40 });
    assert.equal(scroll.scrollLeft, 40);
    doc.wheel(50, 20, 30, { shiftKey: true });
    assert.equal(scroll.scrollLeft, 70, 'Shift turns the wheel across');
    scroll.scrollLeft = 1000;
    assert.equal(scroll.scrollLeft, 200, 'clamped to what overflows');
    assert.deepEqual(lefts, [40, 70, 200]);
    doc.present();
    const red = /** @type {any[]} */ (doc.commands().find(c => c[0] === 'rect' && c[5] === '#ffff0000'));
    assert.equal(red[1], -200, 'its content moved across');
    const bar = doc.commands().filter(c => c[0] === 'round' && c[2] > 40);
    assert.equal(bar.length, 1, 'a bar along its bottom');
    doc.close();
  });

  it('takes a size prop that is not a finite number as unset, and draws text at most 10000 px', (/** @type {import('node:test').TestContext} */ t) => {
    const doc = new Probe();
    closeAfter(t, () => doc.close());
    render(() => (
      <View>
        <Label text="plain" />
        <Label text="inf" size={Infinity} />
        <Label text="neg" size={-Infinity} />
        <Edit value="edit" size={Infinity} />
        <Label text="lines" lines={Infinity} />
        <Label text="huge" style={{ fontSize: 1e39 }} />
      </View>
    ), doc);
    doc.present();
    const texts = /** @type {any[][]} */ (doc.commands().filter(c => c[0] === 'text'));
    const size = (/** @type {string} */ text) => texts.find(c => c[1] === text)?.[4];
    const plain = size('plain');
    assert.equal(size('inf'), plain, 'Infinity is unset');
    assert.equal(size('neg'), plain, '-Infinity is unset');
    assert.ok(Number.isFinite(size('edit')), `the Edit's text size ${size('edit')}`);
    assert.equal(size('huge'), 10000, 'a font size past 10000 is drawn at it');
    assert.ok(texts.find(c => c[1] === 'lines') !== undefined, 'lines={Infinity} clamps nothing away');
    for (const c of doc.commands()) assert.ok(c.every(v => typeof v !== 'number' || Number.isFinite(v)), JSON.stringify(c));
  });

  it('scrolls to 0 for a scrollTop or scrollLeft that is not a finite number, as the DOM does, and the wheel scrolls after', (/** @type {import('node:test').TestContext} */ t) => {
    const doc = new Probe();
    // Closed however the test ends: left open at NaN, its frames never settled.
    closeAfter(t, () => doc.close());
    /** @type {any} */
    let down = null;
    /** @type {any} */
    let across = null;
    render(() => (
      <View>
        <Scroll ref={(/** @type {any} */ n) => (down = n)} style={{ width: 100, height: 60 }}>
          <View style={{ height: 300, shrink: 0, background: '#ff0000' }} />
        </Scroll>
        <Scroll ref={(/** @type {any} */ n) => (across = n)} axis="x" style={{ width: 100, height: 60 }}>
          <View style={{ width: 300, height: 30, shrink: 0, background: '#00ff00' }} />
        </Scroll>
      </View>
    ), doc);
    doc.present();
    for (const bad of [NaN, 'abc', Infinity, -Infinity, undefined]) {
      down.scrollTop = 50;
      down.scrollTop = bad;
      assert.equal(down.scrollTop, 0, `scrollTop = ${String(bad)}`);
      across.scrollLeft = 50;
      across.scrollLeft = bad;
      assert.equal(across.scrollLeft, 0, `scrollLeft = ${String(bad)}`);
    }
    down.scrollTop = '30';
    assert.equal(down.scrollTop, 30, 'a string that reads as a number scrolls there');
    doc.scrollTo(down, NaN);
    assert.equal(down.scrollTop, 0, 'scrollTo too');
    doc.scrollTo(across, 0, NaN);
    assert.equal(across.scrollLeft, 0);
    doc.present();
    const red = /** @type {any[]} */ (doc.commands().find(c => c[0] === 'rect' && c[5] === '#ffff0000'));
    assert.deepEqual([red[2], red[4]], [0, 300], 'the content still drawn, at the top');
    doc.wheel(50, 20, 40);
    assert.equal(down.scrollTop, 40, 'the wheel scrolls from 0');
    doc.wheel(50, 80, 0, { deltaX: 40 });
    assert.equal(across.scrollLeft, 40);
  });

  it('reports an item\'s border box to onResize once laid out and when its size changes', () => {
    const doc = new Probe();
    const root = $root('sizes');
    const width = $signal(root, 100);
    /** @type {string[]} */
    const heard = [];
    render(() => (
      <View style={{ align: 'start' }}>
        <View style={() => ({ width: $read(width), height: 20, padding: 2 })} onResize={(/** @type {any} */ e) => heard.push(`${e.width}x${e.height}`)} />
      </View>
    ), doc, { root });
    doc.present();
    assert.deepEqual(heard, ['100x20']);
    $write(width, 100);
    doc.present();
    $write(width, 150);
    doc.present();
    assert.deepEqual(heard, ['100x20', '150x20'], 'only a new size');
    doc.close();
  });

  it('tells $moves when a frame paints an item somewhere new: a layout shift, a transform, a scroll', () => {
    const doc = new Probe();
    const root = $root('moves');
    const above = $signal(root, 10);
    const shift = $signal(root, 0);
    const open = $signal(root, true);
    /** @type {any} */
    let target = null;
    /** @type {any} */
    let scroll = null;
    /** @type {string[]} */
    const heard = [];
    const Follow = () => {
      $moves(target, e => heard.push(`${e.type} ${e.x},${e.y}`));
      return null;
    };
    render(() => (
      <Scroll ref={(/** @type {any} */ n) => (scroll = n)} style={{ height: 100 }}>
        <View style={() => ({ height: $read(above), shrink: 0 })} />
        <View ref={(/** @type {any} */ n) => (target = n)} style={() => ({ width: 40, height: 20, shrink: 0, translate: [$read(shift), 0] })} />
        <View style={{ height: 300, shrink: 0 }} />
        <Show when={open}>
          <Follow />
        </Show>
      </Scroll>
    ), doc, { root });
    doc.present();
    assert.deepEqual(heard, [], 'its first place is only noted');
    $write(above, 30);
    doc.present();
    assert.deepEqual(heard, ['move 0,30'], 'the content above grew');
    $write(shift, 12);
    doc.present();
    assert.deepEqual(heard, ['move 0,30', 'move 12,30'], 'a transform');
    doc.scrollTo(scroll, 5);
    doc.present();
    assert.deepEqual(heard.at(-1), 'move 12,25', 'a scroll');
    const count = heard.length;
    $write(above, 30);
    doc.present();
    assert.equal(heard.length, count, 'nothing moved: nothing told');
    $write(open, false);
    $write(above, 0);
    doc.present();
    assert.equal(heard.length, count, 'stopped with its owner');
    assert.equal(doc.moving.size, 0);
    doc.close();
  });

  it('places a fixed item against the viewport, over the page\'s scroll and its parent\'s clip', () => {
    const doc = new Probe({ width: 200, height: 100 });
    /** @type {any} */
    let bar = null;
    render(() => (
      <View>
        <View style={{ height: 50, overflow: 'hidden', margin: [20, 0, 0, 0] }}>
          <View ref={(/** @type {any} */ n) => (bar = n)} style={{ position: 'fixed', bottom: 10, right: 10, width: 30, height: 20, background: '#ff0000' }} />
        </View>
        <View style={{ height: 400, shrink: 0 }} />
      </View>
    ), doc);
    const red = () => {
      doc.present();
      return /** @type {any[]} */ (doc.commands().find(c => c[0] === 'rect' && c[5] === '#ffff0000')).slice(1, 5);
    };
    // The page overflows: its bar (the theme's, 8) takes its width.
    assert.deepEqual(red(), [200 - 8 - 10 - 30, 100 - 10 - 20, 200 - 8 - 10, 100 - 10]);
    doc.wheel(50, 50, 80);
    assert.deepEqual(red(), [152, 70, 182, 90], 'the page scrolls under it');
    void bar;
    doc.close();
  });

  it('sizes a fixed item between two insets by the viewport, and gives its placed box as its rect', () => {
    const doc = new Probe({ width: 480, height: 360 });
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ padding: [30, 0, 0, 50] }}>
        <View ref={(/** @type {any} */ n) => (refs.inline = n)} style={{ position: 'fixed', top: 10, left: '10%', right: '10%', height: 20, background: '#ff0000' }}>
          <View ref={(/** @type {any} */ n) => (refs.inner = n)} style={{ height: 10, margin: [5, 0, 0, 6] }} />
        </View>
        <View ref={(/** @type {any} */ n) => (refs.flow = n)} style={{ position: 'fixed', bottom: 4, width: 30, height: 10 }} />
        <Portal>
          <View ref={(/** @type {any} */ n) => (refs.toast = n)} style={{ position: 'fixed', left: 16, right: 16, bottom: 16, height: 40, background: '#00ff00' }} />
          <View ref={(/** @type {any} */ n) => (refs.side = n)} style={{ position: 'fixed', top: 0, bottom: 0, right: 0, width: 100, margin: [10, 0, 10, 0] }} />
        </Portal>
      </View>
    ), doc);
    doc.present();
    const painted = (/** @type {string} */ color) => /** @type {any[]} */ (doc.commands().find(c => c[0] === 'rect' && c[5] === color)).slice(1, 5);
    assert.deepEqual(rect(refs.toast), [16, 304, 448, 40], 'between left and right, above the bottom');
    assert.deepEqual(painted('#ff00ff00'), [16, 304, 464, 344], 'painted where its rect says');
    assert.deepEqual(rect(refs.side), [380, 10, 100, 340], 'between top and bottom, less its margins');
    assert.deepEqual(rect(refs.inline), [48, 10, 384, 20], 'in the page, percentages of the viewport');
    assert.deepEqual(painted('#ffff0000'), [48, 10, 432, 30]);
    assert.deepEqual(rect(refs.inner), [54, 15, 378, 10], 'what it holds goes with it');
    assert.deepEqual(rect(refs.flow), [50, 360 - 4 - 10, 30, 10], 'no horizontal inset: where the flow put it');
    doc.resize(300, 200);
    assert.deepEqual(rect(refs.toast), [16, 144, 268, 40], 'the viewport resized: sized again');
    assert.deepEqual(rect(refs.inline), [30, 10, 240, 20]);
    doc.close();
  });

  it('sizes a fixed item in the page by the viewport less the page\'s scrollbar', () => {
    const doc = new Probe({ width: 200, height: 100 });
    /** @type {any} */
    let bar = null;
    render(() => (
      <View>
        <View ref={(/** @type {any} */ n) => (bar = n)} style={{ position: 'fixed', left: 0, right: 0, bottom: 0, height: 10 }} />
        <View style={{ height: 400, shrink: 0 }} />
      </View>
    ), doc);
    doc.present();
    assert.deepEqual(rect(bar), [0, 90, 192, 10], 'the page overflows: its bar (8) is not the viewport');
    doc.wheel(50, 50, 80);
    assert.deepEqual(rect(bar), [0, 90, 192, 10], 'the page scrolls under it');
    doc.close();
  });

  it('gives the wheel to the Scrolls around the topmost box, not a Scroll beneath it', () => {
    const doc = new Probe({ width: 200, height: 200 });
    /** @type {any} */
    let scroll = null;
    render(() => (
      <View>
        <Scroll ref={(/** @type {any} */ n) => (scroll = n)} style={{ height: 100 }}>
          <View style={{ height: 300, shrink: 0 }} />
        </Scroll>
        <View style={{ position: 'absolute', top: 0, left: 0, width: 80, height: 80, background: '#ff0000' }} />
      </View>
    ), doc);
    doc.present();
    doc.wheel(40, 40, 30);
    assert.equal(scroll.scrollTop, 0, 'the popover over it keeps the wheel from it');
    doc.wheel(150, 40, 30);
    assert.equal(scroll.scrollTop, 30, 'beside it, the Scroll scrolls');
    doc.close();
  });

  it('lays placement out in a layout worker as in this thread', { timeout: 30000 }, async t => {
    const channel = new MessageChannel();
    const stop = serveLayout(channel.port2);
    const layout = remoteLayout(channel.port1);
    const view = () => (
      <View style={{ padding: 10 }}>
        <View style={{ width: '80%', height: 90, padding: 4 }}>
          <View style={{ position: 'absolute', inset: '10%', zIndex: 2, background: '#000001' }} />
          <View style={{ position: 'relative', top: 4, left: '5%', height: '50%', background: '#000002' }} />
        </View>
      </View>
    );
    const local = new Document(mono, { width: 200, height: 200 });
    const remote = new Document(mono, { width: 200, height: 200, layout });
    // Closed after the test however it ends, a timeout too (a finally would wait on the hung await).
    closeAfter(t, () => {
      local.close();
      remote.close();
      layout.close();
      stop();
      channel.port1.close();
    });
    render(view, local);
    render(view, remote);
    // It paints once the worker answers (`framed`, after each frame).
    assert.ok(remote.boxes.engine.busy);
    await new Promise(resolve => (remote.framed = resolve));
    assert.equal(remote.frames, 1);
    assert.deepEqual(remote.commands(), local.commands());
    const pop = /** @type {any} */ (local.root.first?.first?.first);
    // 80% of 180 is 144; 10% of it and of 90 in from each side.
    assert.deepEqual(rect(pop), [24.4, 19, 115.2, 72]);
  });
});
