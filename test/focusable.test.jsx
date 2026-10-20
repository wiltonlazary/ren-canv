// What takes the focus and the pointer on a Document, as the DOM decides it:
// a tabIndex makes a View, Layout or Scroll focusable (from code, and by a
// press inside it; in the Tab order from 0) and keeps an Action or Edit out
// of the Tab order (-1); an inert region takes no focus, pointer or
// selection, and the mirror leaves it out. Both cross a worker as props.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyWindow } from 'happy-dom';
import { $root, $signal, $read, $write } from 'rrx-core';
import { View, Label, Action, Edit, $focus } from 'ren-core';
import { serve } from 'ren-core/worker';
import { connect } from 'ren-core/remote';
import { Document, render, attach, loadLayout } from 'ren-canv';
import { closeAfter } from './fixtures/after.js';

/** The happy-dom windows this file's tests open, each closed after its test. @type {HappyWindow[]} */
const windows = [];
class Window extends HappyWindow {
  /** @param {ConstructorParameters<typeof HappyWindow>} args */
  constructor(...args) {
    super(...args);
    windows.push(this);
  }
}
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

await loadLayout();

/** Every character is half its size wide. */
const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };
const make = () => new Document(mono, { width: 200, height: 300 });

/** The page point at an item's center (or `dx`, `dy` from its corner). @param {Document} doc @param {any} item @param {number} [dx] @param {number} [dy] */
const point = (doc, item, dx, dy) => {
  doc.present();
  doc.boxes.fix(item);
  let x = dx ?? item.w / 2;
  let y = dy ?? item.h / 2;
  for (let n = item; n !== null && n !== doc.root && n !== doc.overlay; n = n.parent) {
    doc.boxes.fix(n);
    x += n.x;
    y += n.y;
  }
  return [x, y];
};

/** The focused item's tag. @param {Document} doc @param {Map<any, string>} tags */
const focused = (doc, tags) => (doc.focused === null ? 'none' : tags.get(doc.focused) ?? '?');

describe('ren canv: tabIndex and inert', () => {
  it("rings an item focused from code after a key, as Chrome's :focus-visible, and not after a press", () => {
    const doc = make();
    /** @type {any[]} */
    const tabs = [];
    render(() => (
      <View style={{ direction: 'row' }}>
        {[0, 1, 2].map(i => (
          <Action
            ref={(/** @type {any} */ n) => (tabs[i] = n)}
            text={'tab ' + i}
            tabIndex={i === 0 ? 0 : -1}
            onKey={(/** @type {any} */ e) => {
              // A roving focus: the arrow keys move it among the tabs.
              if (e.key === 'ArrowRight') tabs[(i + 1) % 3].focus();
            }}
          />
        ))}
      </View>
    ), doc);
    doc.present();
    doc.key('Tab');
    assert.equal(doc.current, tabs[0]);
    assert.equal(doc.ring, true, 'Tab: the ring');
    doc.key('ArrowRight');
    assert.equal(doc.current, tabs[1]);
    assert.equal(doc.ring, true, 'moved by a key: the ring stays');
    const { x, y } = doc.center(tabs[2]);
    doc.press(x, y);
    assert.equal(doc.current, tabs[2]);
    assert.equal(doc.ring, false, 'a press: no ring');
    tabs[0].focus();
    assert.equal(doc.current, tabs[0]);
    assert.equal(doc.ring, false, 'focused from code after a press: no ring');
    doc.close();
  });

  it('takes a region given a tabIndex into the focus, and keeps an item with -1 out of the Tab order', () => {
    const doc = make();
    /** @type {Map<any, string>} */
    const tags = new Map();
    /** @param {string} tag */
    const ref = tag => (/** @type {any} */ item) => void tags.set(item, tag);
    /** @type {string[]} */
    const pressed = [];
    render(() => (
      <View style={{ gap: 0, fontSize: 10, lineHeight: 2 }}>
        <Action ref={ref('A')} text="A" style={{ height: 20 }} />
        <Action ref={ref('B')} text="B" tabIndex={-1} style={{ height: 20 }} />
        <View ref={ref('main')} tabIndex={-1} style={{ height: 60, gap: 0 }} onPress={() => pressed.push('main')}>
          <Label ref={ref('title')} text="Main" style={{ height: 20 }} />
          <Edit ref={ref('E')} value="" style={{ height: 20 }} />
        </View>
        <View ref={ref('zero')} tabIndex={0} style={{ height: 20 }} />
        <Action ref={ref('C')} text="C" style={{ height: 20 }} />
      </View>
    ), doc);
    const item = (/** @type {string} */ tag) => [...tags].find(([, t]) => t === tag)?.[0];
    /** @type {string[]} */
    const order = [];
    for (let i = 0; i < 5; i++) {
      doc.key('Tab');
      order.push(focused(doc, tags));
    }
    assert.deepEqual(order, ['A', 'E', 'zero', 'C', 'A'], 'B and main (-1) are out of the Tab order, zero (0) in it');
    // A region focused from code (a skip link's target): Tab goes on from where it is.
    item('main').focus();
    assert.equal(focused(doc, tags), 'main');
    doc.key('Tab');
    assert.equal(focused(doc, tags), 'E', 'Tab from the region: the next in the document');
    item('main').focus();
    doc.key('Tab', true);
    assert.equal(focused(doc, tags), 'A', 'Shift+Tab from the region: the one before it');
    // -1 keeps an Action focusable from code and by a press.
    item('B').focus();
    assert.equal(focused(doc, tags), 'B');
    // Enter on a focused region presses nothing (only an Action's default is a press).
    item('main').focus();
    doc.key('Enter');
    assert.deepEqual(pressed, []);
    // A press inside the region (on its Label) focuses it, as a click focuses the nearest focusable ancestor.
    doc.focus(null);
    const [x, y] = point(doc, item('title'));
    doc.press(x, y);
    assert.equal(focused(doc, tags), 'main');
    assert.deepEqual(pressed, ['main']);
    // $focus (focusFirst, focusLast): the first and last item Tab reaches inside.
    const outer = /** @type {any} */ (item('A')).parent;
    assert.equal($focus(outer), true);
    assert.equal(focused(doc, tags), 'A');
    assert.equal($focus(outer, true), true);
    assert.equal(focused(doc, tags), 'C');
    assert.equal($focus(item('main')), true);
    assert.equal(focused(doc, tags), 'E');
    // A Label takes no focus, tabIndex or not.
    item('title').focus?.();
    assert.equal(focused(doc, tags), 'E');
    doc.close();
  });

  it('orders a positive tabIndex first, ascending, then the rest in document order', () => {
    const doc = make();
    /** @type {Map<any, string>} */
    const tags = new Map();
    /** @param {string} tag */
    const ref = tag => (/** @type {any} */ item) => void tags.set(item, tag);
    render(() => (
      <View>
        <Action ref={ref('a')} text="a" />
        <Action ref={ref('two')} text="two" tabIndex={2} />
        <Action ref={ref('b')} text="b" />
        <View ref={ref('one')} tabIndex={1} />
      </View>
    ), doc);
    /** @type {string[]} */
    const order = [];
    for (let i = 0; i < 5; i++) {
      doc.key('Tab');
      order.push(focused(doc, tags));
    }
    assert.deepEqual(order, ['one', 'two', 'a', 'b', 'one']);
    doc.close();
  });

  it('keeps an inert region from the focus and the pointer, and the mirror leaves it out', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = make();
    const R = $root('app');
    const off = $signal(R, false);
    /** @type {Map<any, string>} */
    const tags = new Map();
    /** @param {string} tag */
    const ref = tag => (/** @type {any} */ item) => void tags.set(item, tag);
    /** @type {string[]} */
    const heard = [];
    render(() => (
      <View ref={ref('outer')} style={{ gap: 0, fontSize: 10, lineHeight: 2 }} onPress={(/** @type {any} */ e) => heard.push(`outer ${tags.get(e.target)}`)}>
        <Action ref={ref('A')} text="A" style={{ height: 20 }} />
        <View ref={ref('region')} inert style={{ gap: 0, pointerEvents: 'auto' }}>
          <Action ref={ref('B')} text="B" style={{ height: 20, pointerEvents: 'auto' }} onPress={() => heard.push('B')} />
          <Label ref={ref('text')} text="cannot select" style={{ height: 20 }} />
        </View>
        <View inert={off} style={{ gap: 0 }}>
          <Action ref={ref('C')} text="C" style={{ height: 20 }} />
        </View>
      </View>
    ), doc, { root: R });
    const item = (/** @type {string} */ tag) => [...tags].find(([, t]) => t === tag)?.[0];
    /** @type {string[]} */
    const order = [];
    for (let i = 0; i < 3; i++) {
      doc.key('Tab');
      order.push(focused(doc, tags));
    }
    assert.deepEqual(order, ['A', 'C', 'A'], 'Tab skips the inert region');
    item('B').focus();
    assert.equal(focused(doc, tags), 'A', "focus() of an inert item leaves the focus where it is");
    assert.equal($focus(item('region')), false, 'nothing inside an inert region takes the focus');
    // The pointer goes through it to what is under it (pointer-events none, which a child cannot take back).
    const [bx, by] = point(doc, item('B'));
    doc.press(bx, by);
    assert.deepEqual(heard, ['outer outer'], 'the press reaches the View under it, not B');
    // Made inert while it holds the focus: the focus leaves it.
    item('C').focus();
    assert.equal(focused(doc, tags), 'C');
    $write(off, true);
    doc.present();
    assert.equal(focused(doc, tags), 'none');
    // The mirror marks it inert, which takes it out of the accessibility tree.
    const stop = attach(doc, canvas);
    const mirror = /** @type {any} */ (window.document.querySelector('[data-ren-aria]'));
    const inert = [...mirror.querySelectorAll('[inert]')];
    assert.equal(inert.length, 2, 'both inert regions');
    assert.ok(inert[0].textContent.includes('cannot select'));
    $write(off, false);
    doc.present();
    assert.equal(mirror.querySelectorAll('[inert]').length, 1, 'not inert: the mark goes');
    stop();
    doc.close();
    void $read;
  });

  it('selects no text in an inert region', () => {
    // A page's: its loose text selectable.
    const doc = new Document(mono, { width: 200, height: 300, behavior: 'page' });
    /** @type {any} */
    let shut = null;
    /** @type {any} */
    let open = null;
    render(() => (
      <View style={{ gap: 0, fontSize: 10, lineHeight: 2 }}>
        <View inert style={{ select: 'text' }}><Label ref={(/** @type {any} */ l) => (shut = l)} text="cannot select" style={{ select: 'text' }} /></View>
        <Label ref={(/** @type {any} */ l) => (open = l)} text="can select" />
      </View>
    ), doc);
    const [ox, oy] = point(doc, open, 2, 10);
    doc.press(ox, oy, 2);
    assert.equal(doc.copied(), 'can', 'a double press selects a word');
    const [sx, sy] = point(doc, shut, 2, 10);
    doc.press(sx, sy, 2);
    assert.equal(doc.copied(), '', 'not in an inert region, whatever its style says');
    doc.close();
  });

  it("gives a canvas wheel handler the wheel's deltaMode", () => {
    const doc = make();
    /** @type {number[][]} */
    const seen = [];
    render(() => <View style={{ height: 100 }} onWheel={(/** @type {any} */ e) => void seen.push([e.deltaMode, e.deltaY])} />, doc);
    doc.wheel(10, 10, 3, { deltaY: 3, deltaMode: 1 });
    doc.wheel(10, 10, 40, { deltaY: 40, deltaMode: 0 });
    assert.deepEqual(seen, [[1, 3], [0, 40]]);
    doc.close();
  });

  it('carries inert and tabIndex across a worker', { timeout: 30000 }, async t => {
    const doc = make();
    const W = $root('app');
    const off = $signal(W, true);
    const { port1, port2 } = new MessageChannel();
    const connection = connect(port2, doc, doc.root, { schedule: 'now' });
    const session = serve(() => (
      <View>
        <Action text="A" />
        <View tabIndex={-1} inert={off}><Action text="B" /></View>
        <Action text="C" tabIndex={-1} />
      </View>
    ), { port: port1, root: W });
    closeAfter(t, () => {
      connection.close();
      session.close();
      port1.close();
      port2.close();
      doc.close();
    });
    await connection.idle();
    const outer = /** @type {any} */ (doc.root.first);
    const region = outer.first.next;
    assert.equal(region.inert, true);
    assert.equal(region.tabIndex, -1);
    /** @type {string[]} */
    const order = [];
    for (let i = 0; i < 2; i++) {
      doc.key('Tab');
      order.push(doc.focused?.text ?? 'none');
    }
    assert.deepEqual(order, ['A', 'A'], 'the region is inert and C is out of the Tab order');
    $write(off, false);
    await connection.idle();
    doc.key('Tab');
    assert.equal(doc.focused?.text, 'B');
  });
});
