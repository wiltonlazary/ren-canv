// The engine on its own: a Document with a fixed-width measure and no
// surface. Layout, paint commands, hit testing, focus and editing are the
// engine's, whatever replays the frames (ren-skia, ren-three).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyWindow } from 'happy-dom';
import { $signal, $read, $write } from 'rrx-core';
import { View, Label, Edit, Action, Scroll, Show, For, Image, $active, $keys, $scrolls, $viewport, $media, $parts } from 'ren-core';
import { Document, render, attach, decode, loadLayout } from 'ren-canv';

/** The happy-dom windows this file's tests open, each closed after its test (its window.close() frees nothing). @type {HappyWindow[]} */
const windows = [];
/** happy-dom's Window, tracked for closing. */
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

/** The layout engine (Taffy's WebAssembly), once, before any Document. */
await loadLayout();

/** Every character is half its size wide. */
const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };
const make = () => new Document(mono, { width: 200, height: 200 });
const texts = (/** @type {Document} */ doc) => doc.commands().filter(c => c[0] === 'text').map(c => c[1]);

describe('ren canv document', () => {
  it('follows the size and place of an item another Document adopted, where it is now', () => {
    // ren-three makes a panel's items on the overlay, where their handlers bind, then a panel adopts them.
    const made = new Document(mono, { width: 200, height: 100 });
    const panel = new Document(mono, { width: 200, height: 100 });
    const item = made.element('View', {});
    made.set(item, 'style', { width: 100, height: 50 });
    /** @type {string[]} */
    const heard = [];
    const stop = made.listen(item, 'resize', (/** @type {any} */ e) => heard.push(`${e.width}x${e.height}`));
    made.listen(item, 'pointerdown', () => {});
    panel.insert(panel.root, item, null);
    panel.present();
    assert.deepEqual(heard, ['100x50'], 'heard where it is laid out');
    assert.deepEqual([made.pointing, panel.pointing], [0, 1], 'its pointer listener counts there');
    stop();
    assert.equal(panel.resizing.has(item), false, 'and stops there');
    made.close();
    panel.close();
  });

  it('lays out and paints a view into commands, with no surface', () => {
    const doc = make();
    render(() => <View pad={10}><Label text="Hi" /></View>, doc);
    assert.equal(doc.frames, 1);
    assert.equal(doc.repaint, 'none', 'nothing draws without a surface');
    assert.deepEqual(texts(doc), ['Hi']);
    assert.deepEqual(decode(doc.frame), doc.commands());
    doc.close();
  });

  it('separates the parts a child shows ($parts): For rows, a Show showing nothing skipped, an accessor, nested arrays', () => {
    const doc = make();
    /** @type {any} */
    let state = null;
    /** @param {{ children?: any }} props */
    const Group = props => (
      <View layout="row">
        <For each={$parts(props.children)}>{(part, i) => [() => (i() > 0 ? <Label text="|" /> : null), part]}</For>
      </View>
    );
    const App = () => {
      const R = $active();
      state = { items: $signal(R, ['x', 'y']), on: $signal(R, false) };
      return (
        <Group>
          <Label text="a" />
          <For each={state.items}>{(/** @type {() => string} */ x) => <Label text={x} />}</For>
          <Show when={state.on}><Label text="shown" /></Show>
          {() => ($read(state.on) ? <Action text="on" /> : null)}
          {[[<Label text="s" />], <Label text="t" />]}
        </Group>
      );
    };
    render(() => <App />, doc);
    doc.present();
    assert.deepEqual(texts(doc), ['a', '|', 'x', '|', 'y', '|', 's', '|', 't']);
    $write(state.on, true);
    $write(state.items, ['y', 'z']);
    doc.present();
    assert.deepEqual(texts(doc), ['a', '|', 'y', '|', 'z', '|', 'shown', '|', 'on', '|', 's', '|', 't']);
    doc.close();
  });

  it('routes presses, focus and typing to the primitives', () => {
    const doc = make();
    /** @type {string[]} */
    const seen = [];
    const App = () => {
      const count = $signal($active(), 0);
      return (
      <View>
        <Action text={() => `pressed ${$read(count)}`} onPress={() => $write(count, $read(count) + 1)} />
        <Edit label="Name" value="" onChange={e => seen.push(e.value)} />
      </View>
      );
    };
    render(() => <App />, doc);
    const hits = doc.painter.hits;
    const box = (/** @type {number} */ i) => [hits.box[i * 6], hits.box[i * 6 + 1]];
    const [ax, ay] = box(0);
    assert.ok(doc.press(ax + 5, ay + 5));
    assert.ok(texts(doc).includes('pressed 1'));
    const [ex, ey] = box(1);
    doc.press(ex + 5, ey + 5);
    assert.equal(doc.focused?.kind, 4, 'the Edit has focus');
    doc.type('ab');
    doc.key('Backspace');
    assert.deepEqual(seen, ['ab', 'a']);
    doc.key('Tab', true);
    assert.equal(doc.focused?.kind, 5, 'Shift+Tab moves back to the Action');
    doc.close();
  });

  it('keeps an accessibility mirror and a native text entry beside a canvas', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = make();
    render(() => <View><Label text="Read me" /><Action text="Go" /><Edit label="Name" value="x" /></View>, doc);
    const stop = attach(doc, canvas);
    const mirror = /** @type {any} */ (window.document.querySelector('[data-ren-aria]'));
    assert.ok(mirror.textContent.includes('Read me'));
    assert.equal(mirror.querySelector('button').textContent, 'Go');
    const entry = /** @type {any} */ (window.document.querySelector('[data-ren-entry]'));
    assert.ok(entry, 'the text entry');
    // Until an Edit takes the focus it rests a pixel wide at its containing block's corner, not in flow after the canvas, where it would overflow the canvas's container.
    for (const [name, value] of [['left', '0px'], ['top', '0px'], ['width', '1px'], ['height', '1px']]) assert.equal(entry.style.getPropertyValue(name), value, name);
    stop();
    assert.equal(window.document.querySelector('[data-ren-aria]'), null);
    doc.close();
  });

  it("shifts the drawing by the canvas's place past the device pixels a browser snaps it to", async () => {
    const window = new Window();
    const canvas = /** @type {any} */ (window.document.createElement('canvas'));
    window.document.body.appendChild(canvas);
    let at = { left: 10.5, top: 394.171875 };
    canvas.getBoundingClientRect = () => ({ ...at, right: at.left + 100, bottom: at.top + 100, width: 100, height: 100, x: at.left, y: at.top });
    const doc = make();
    render(() => <Label text="x" />, doc);
    const stop = attach(doc, canvas);
    // timer: feature, the shift is measured in a frame: this one, asked after it, runs after it.
    const frame = () => new Promise(r => window.requestAnimationFrame(() => r(undefined)));
    await frame();
    assert.deepEqual([doc.shiftX, doc.shiftY], [-0.5, 0.171875], 'the fractions the DOM keeps and the canvas loses');
    at = { left: 10, top: 20 };
    window.dispatchEvent(new window.Event('resize'));
    await frame();
    assert.deepEqual([doc.shiftX, doc.shiftY], [0, 0], 'measured again when the window resizes');
    stop();
    assert.equal(doc.framed, null);
    doc.close();
  });

  it('sends pointer events to primitives as the DOM names them: offsets, bubbling, a drag held by a capture', () => {
    const doc = new Document(mono, { width: 200, height: 200 });
    /** @type {string[]} */
    const seen = [];
    const note = (/** @type {string} */ who) => (/** @type {any} */ e) =>
      void seen.push(`${who} ${e.type} ${e.offsetX},${e.offsetY} @${e.x},${e.y}${e.shiftKey ? ' shift' : ''} on ${e.target === e.currentTarget ? 'self' : 'child'}`);
    render(() => (
      <View style={{ padding: 10, fontSize: 10, lineHeight: 2 }}>
        <View style={{ height: 50, border: 2 }} onPointerDown={(/** @type {any} */ e) => (note('pad')(e), e.currentTarget.setPointerCapture(e.pointerId))} onPointerMove={note('pad')} onPointerUp={note('pad')}>
          <Label text="plain text" />
        </View>
        <View onPointerDown={note('row')}>
          <Action text="go" onPress={() => seen.push('pressed')} />
        </View>
      </View>
    ), doc);
    // The pad: its padding box starts at 12,12 (padding 10, border 2).
    doc.press(40, 30, 1, false, { shiftKey: true });
    assert.deepEqual(seen, ['pad pointerdown 28,18 @40,30 shift on child'], 'the Label under the pointer is the target (as the DOM\'s element under it), and it bubbles to the pad');
    seen.length = 0;
    // Dragged out of it, the pad keeps the pointer it captured until release (as on the DOM).
    doc.move(150, 190);
    doc.release(150, 190);
    doc.move(40, 30);
    assert.deepEqual(seen, ['pad pointermove 138,178 @150,190 on self', 'pad pointerup 138,178 @150,190 on self', 'pad pointermove 28,18 @40,30 on child']);
    seen.length = 0;
    // An Action inside a listening row: the row hears it bubble, then the press runs.
    doc.press(40, 80);
    doc.release(40, 80);
    assert.deepEqual(seen, ['row pointerdown 30,20 @40,80 on child', 'pressed'], 'the Action starts at 10,60: offsets are the target\'s');
    doc.close();
  });

  it('keeps the native entry\'s label and lines up to date while its Edit has focus', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 200 });
    /** @type {any} */
    let label = null;
    /** @type {any} */
    let lines = null;
    /** @type {any} */
    let edit = null;
    render(() => {
      label = $signal($active(), 'Name');
      lines = $signal($active(), 1);
      return <View><Edit ref={(/** @type {any} */ n) => (edit = n)} value="" label={() => $read(label)} lines={() => $read(lines)} /></View>;
    }, doc);
    const stop = attach(doc, canvas);
    edit.focus();
    const area = /** @type {any} */ (window.document.querySelector('[data-ren-entry]'));
    assert.equal(window.document.activeElement, area);
    assert.equal(area.getAttribute('aria-label'), 'Name');
    $write(label, 'Email');
    doc.present();
    assert.equal(area.getAttribute('aria-label'), 'Email', 'a label changed under the focus names the entry');
    $write(lines, 3);
    doc.present();
    assert.equal(area.getAttribute('rows'), '3');
    assert.equal(area.getAttribute('enterkeyhint'), 'enter');
    stop();
    doc.close();
  });

  it('moves the focus into the mirror when "Enable accessibility" turns it on', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 200, aria: 'demand' });
    render(() => <View><Label text="hello" /></View>, doc);
    const stop = attach(doc, canvas);
    const enable = /** @type {any} */ (window.document.querySelector('[data-ren-aria-enable]'));
    enable.focus();
    enable.click();
    const first = /** @type {any} */ (window.document.querySelector('[data-ren-aria]')).firstChild;
    // A div without a tab index takes no focus in a browser (Chrome leaves it on the body).
    assert.equal(first.getAttribute('tabindex'), '-1', 'focusable, out of the Tab order');
    assert.equal(window.document.activeElement, first);
    stop();
    doc.close();
  });

  it('releases a pointer capture when the captured item is removed, as the DOM does', () => {
    const doc = new Document(mono, { width: 300, height: 200 });
    /** @type {string[]} */
    const seen = [];
    /** @type {any} */
    let on = null;
    /** @type {any} */
    let handle = null;
    render(() => {
      on = $signal($active(), true);
      return (
        <View style={{ width: 300, height: 200 }} onPointerMove={(/** @type {any} */ e) => seen.push(`move on ${e.target === handle ? 'handle' : 'other'}`)} onPointerUp={() => seen.push('up')}>
          <Show when={() => $read(on)}>
            <View ref={(/** @type {any} */ n) => (handle = n)} style={{ width: 50, height: 50 }} onPointerDown={(/** @type {any} */ e) => e.currentTarget.setPointerCapture(e.pointerId)} />
          </Show>
        </View>
      );
    }, doc);
    doc.present();
    doc.press(10, 10);
    doc.move(20, 20);
    assert.equal(handle.hasPointerCapture(1), true);
    $write(on, false);
    doc.present();
    assert.equal(handle.hasPointerCapture(1), false, 'the removed item holds no capture');
    assert.equal(doc.grabbed, null);
    doc.move(100, 100);
    doc.release(100, 100);
    assert.deepEqual(seen, ['move on handle', 'move on other', 'up'], 'moves and the release go to what is under the pointer');
    doc.close();
  });

  it('lets a pointer handler keep the surface from its own response: focus, a scroll', () => {
    const doc = new Document(mono, { width: 200, height: 100 });
    let presses = 0;
    let wheels = 0;
    render(() => (
      <View style={{ fontSize: 10, lineHeight: 2 }}>
        <Action text="kept" onPress={() => presses++} onPointerDown={(/** @type {any} */ e) => e.preventDefault()} />
        <Scroll style={{ height: 40 }} onWheel={(/** @type {any} */ e) => (wheels++, e.deltaY > 0 && e.preventDefault())}>
          {Array.from({ length: 10 }, (_, i) => <Label text={`line ${i}`} />)}
        </Scroll>
      </View>
    ), doc);
    doc.press(20, 10);
    assert.equal(presses, 1, 'the click is no default of a pointerdown: it still presses, as on the DOM');
    assert.equal(doc.focused, null, 'but no focus');
    doc.wheel(20, 60, 20);
    assert.equal(wheels, 1);
    const scroll = /** @type {any} */ (doc.root.first).first.next;
    assert.equal(scroll.offset, 0, 'prevented: no scroll');
    doc.wheel(20, 60, -5);
    assert.equal(wheels, 2, 'not prevented: it scrolls (already at the top)');
    doc.close();
  });

  it('focuses the Edit pressed even when a pointerdown handler lays something over it', () => {
    const doc = new Document(mono, { width: 200, height: 100 });
    /** @type {any} */
    let open;
    render(() => (
      open = $signal($active(), false),
      <View style={{ fontSize: 10, lineHeight: 2, height: 100 }}>
        <View onPointerDown={() => ($write(open, true), doc.present())}>
          <Edit value="field" />
        </View>
        {() => ($read(open) ? <View style={{ position: 'absolute', top: 0, left: 0, width: 200, height: 100, background: '#000001' }} onPointerDown={() => $write(open, false)} /> : null)}
      </View>
    ), doc);
    doc.present();
    doc.press(10, 10);
    doc.release(10, 10);
    assert.equal($read(open), true, 'the handler opened the backdrop');
    assert.equal(doc.focused?.kind, 4, 'the Edit pressed has the focus, as the DOM focuses the element pressed');
    doc.close();
  });

  it('stops a pointer event where a handler stops it', () => {
    const doc = new Document(mono, { width: 200, height: 100 });
    /** @type {string[]} */
    const seen = [];
    render(() => (
      <View onPointerDown={() => seen.push('outer')}>
        <View style={{ height: 40 }} onPointerDown={(/** @type {any} */ e) => (seen.push('inner'), e.stopPropagation())} />
      </View>
    ), doc);
    doc.press(10, 10);
    assert.deepEqual(seen, ['inner']);
    doc.close();
  });

  it('passes the browser event\'s buttons and modifiers through attach', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 200, height: 100 });
    /** @type {any[]} */
    const seen = [];
    render(() => <View style={{ height: 50 }} onPointerDown={(/** @type {any} */ e) => seen.push([e.ctrlKey, e.altKey, e.buttons])} onWheel={(/** @type {any} */ e) => seen.push(['wheel', e.deltaX, e.deltaY])} />, doc);
    const stop = attach(doc, /** @type {any} */ (canvas));
    const down = new window.PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, ctrlKey: true, altKey: true });
    Object.defineProperty(down, 'offsetX', { value: 10 });
    Object.defineProperty(down, 'offsetY', { value: 10 });
    canvas.dispatchEvent(down);
    const wheel = new window.WheelEvent('wheel', { bubbles: true, deltaX: 3, deltaY: 7 });
    Object.defineProperty(wheel, 'offsetX', { value: 10 });
    Object.defineProperty(wheel, 'offsetY', { value: 10 });
    canvas.dispatchEvent(wheel);
    assert.deepEqual(seen, [[true, true, 1], ['wheel', 3, 7]]);
    stop();
    doc.close();
  });

  it('holds the pointer only where a handler captures it, as on the DOM', () => {
    const doc = new Document(mono, { width: 200, height: 200 });
    /** @type {string[]} */
    const seen = [];
    render(() => <View style={{ height: 50 }} onPointerDown={() => seen.push('down')} onPointerMove={() => seen.push('move')} onPointerUp={() => seen.push('up')} />, doc);
    doc.press(10, 10);
    doc.move(150, 190);
    doc.release(150, 190);
    assert.deepEqual(seen, ['down'], 'uncaptured: the moves and the release happen elsewhere');
    doc.close();
  });

  it('bubbles keys from the focused item, as the DOM\'s keydown, and lets a handler keep the field from editing', () => {
    const doc = new Document(mono, { width: 300, height: 200 });
    /** @type {string[]} */
    const seen = [];
    /** @type {any} */
    let field = null;
    render(() => (
      <View onKey={(/** @type {any} */ e) => seen.push(`view ${e.key}${e.ctrlKey ? ' ctrl' : ''} from ${e.target === e.currentTarget ? 'self' : 'child'}`)}>
        <Action text="act" />
        <Edit ref={(/** @type {any} */ el) => (field = el)} value="" onKey={(/** @type {any} */ e) => e.key === 'x' && e.preventDefault()} />
      </View>
    ), doc);
    doc.press(20, 10);
    doc.key('j', false, { ctrlKey: true });
    assert.deepEqual(seen, ['view j ctrl from child'], 'the focused Action, then the view');
    field.focus();
    assert.equal(doc.current, field, 'a ref focuses, as an element');
    doc.key('x');
    doc.key('y');
    assert.equal(field.draft, 'y', 'a prevented key does not edit');
    field.blur();
    assert.equal(doc.current, null);
    doc.close();
  });

  it("hears the root's keys with $keys after the focused item, and with nothing focused, chords too", () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 200 });
    const stop = attach(doc, canvas);
    /** @type {string[]} */
    const seen = [];
    let stopping = false;
    /** @type {any} */
    let field = null;
    const App = () => {
      $keys(e => {
        seen.push(`root ${e.editable ? 'field ' : ''}${e.ctrlKey ? 'ctrl+' : ''}${e.key}`);
        if (e.ctrlKey && e.key === 'k') e.preventDefault();
      });
      return (
        <View>
          <Edit ref={(/** @type {any} */ el) => (field = el)} value="" onKey={(/** @type {any} */ e) => {
            seen.push(`edit ${e.key}`);
            if (stopping) e.stopPropagation();
          }} />
        </View>
      );
    };
    const dispose = render(() => <App />, doc);
    const fire = (/** @type {string} */ key, ctrl = false) => {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(event, { key, ctrlKey: ctrl, metaKey: false, altKey: false, shiftKey: false });
      canvas.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(fire('k', true), true, 'nothing focused: the root hears a chord, and prevents it');
    field.focus();
    fire('a');
    assert.deepEqual(seen, ['root ctrl+k', 'edit a', 'root field a'], 'the focused item first, then the root, told a field typed it');
    assert.equal(field.draft, 'a', 'and the field edits');
    fire('k', true);
    assert.equal(field.draft, 'a', 'a chord does not edit');
    stopping = true;
    fire('b');
    assert.deepEqual(seen.slice(3), ['edit k', 'root field ctrl+k', 'edit b'], "a focused stopPropagation keeps it from the root's");
    dispose();
    stopping = false;
    doc.key('c');
    assert.equal(seen.length, 6, 'removed with the view');
    stop();
    doc.close();
  });

  it("hears every Scroll's scroll and the page's with $scrolls, as a document's capture listener", () => {
    const doc = new Document(mono, { width: 200, height: 100 });
    /** @type {string[]} */
    const seen = [];
    /** @type {any} */
    let scroll = null;
    const App = () => {
      $scrolls(e => seen.push(e.target === scroll ? 'scroll' : e.target === doc.root ? 'page' : 'other'));
      return (
        <View style={{ fontSize: 10, lineHeight: 2 }}>
          <Scroll ref={(/** @type {any} */ el) => (scroll = el)} style={{ height: 40 }} onScroll={() => seen.push('own')}>
            {Array.from({ length: 10 }, (_, i) => <Label text={`line ${i}`} />)}
          </Scroll>
          {Array.from({ length: 10 }, (_, i) => <Label text={`row ${i}`} />)}
        </View>
      );
    };
    const dispose = render(() => <App />, doc);
    doc.wheel(20, 20, 10);
    assert.deepEqual(seen, ['scroll', 'own'], 'the root first, as a capture listener, then its own handler');
    scroll.scrollTop = 30;
    assert.deepEqual(seen.slice(2), ['scroll', 'own'], 'a scroll set by a ref too');
    doc.wheel(20, 90, 10);
    assert.deepEqual(seen.slice(4), ['page'], 'the page');
    dispose();
    doc.wheel(20, 20, 10);
    assert.equal(seen.length, 5, 'removed with the view');
    doc.close();
  });

  it("reports its size and the window's preferences as the root's viewport, for $viewport and $media", () => {
    const g = /** @type {any} */ (globalThis);
    /** @type {Set<() => void>} */
    const changes = new Set();
    let dark = true;
    g.matchMedia = (/** @type {string} */ q) => ({
      get matches() {
        return q.includes('dark') ? dark : false;
      },
      addEventListener: (/** @type {string} */ _type, /** @type {() => void} */ fn) => changes.add(fn),
      removeEventListener: (/** @type {string} */ _type, /** @type {() => void} */ fn) => changes.delete(fn),
    });
    try {
      const doc = new Document(mono, { width: 1000, height: 600 });
      const App = () => {
        const v = $viewport();
        const wide = $media('(min-width: 62em)');
        return <Label text={() => `${$read(v.width)}x${$read(v.height)} ${$read(wide) ? 'wide' : 'narrow'}${$read(v.dark) ? ' dark' : ''}`} />;
      };
      const dispose = render(() => <App />, doc);
      assert.deepEqual(texts(doc), ['1000x600 wide dark']);
      doc.resize(480, 800);
      assert.deepEqual(texts(doc), ['480x800 narrow dark']);
      dark = false;
      for (const fn of [...changes]) fn();
      doc.present();
      assert.deepEqual(texts(doc), ['480x800 narrow']);
      dispose();
      assert.equal(changes.size, 0, 'it stops following with the last reader');
      assert.equal(doc.viewers.size, 0);
      doc.close();
    } finally {
      delete g.matchMedia;
    }
  });

  it('gives a Scroll the DOM\'s scrollTop, scrollHeight and clientHeight, and a scroll event', () => {
    const doc = new Document(mono, { width: 200, height: 200 });
    /** @type {number[]} */
    const tops = [];
    /** @type {any} */
    let region = null;
    render(() => (
      <View style={{ fontSize: 10, lineHeight: 2 }}>
        <Scroll ref={(/** @type {any} */ el) => (region = el)} style={{ height: 60 }} onScroll={(/** @type {any} */ e) => tops.push(e.target.scrollTop)}>
          {Array.from({ length: 10 }, (_, i) => <Label text={`line ${i}`} />)}
        </Scroll>
      </View>
    ), doc);
    assert.equal(region.scrollHeight, 200);
    assert.equal(region.clientHeight, 60);
    region.scrollTop = 50;
    region.scrollTop = 1000;
    assert.equal(region.scrollTop, 140, 'clamped to the content');
    doc.wheel(10, 10, -40, { deltaY: -40, deltaMode: 0 });
    assert.deepEqual(tops, [50, 140, 100]);
    doc.close();
  });

  it('sends pointerenter and pointerleave as the DOM does: to each item entered or left, without bubbling', () => {
    const doc = new Document(mono, { width: 200, height: 200 });
    /** @type {string[]} */
    const seen = [];
    const on = (/** @type {string} */ who) => ({ onPointerEnter: () => seen.push(`enter ${who}`), onPointerLeave: () => seen.push(`leave ${who}`) });
    render(() => (
      <View style={{ height: 120 }} {...on('outer')}>
        <View style={{ height: 40 }} {...on('a')} />
        <View style={{ height: 40 }} {...on('b')} />
      </View>
    ), doc);
    doc.move(10, 10);
    doc.move(10, 50);
    doc.move(10, 100);
    doc.leave();
    assert.deepEqual(seen, ['enter outer', 'enter a', 'leave a', 'enter b', 'leave b', 'leave outer']);
    doc.close();
  });

  it('shows the hovered item\'s cursor on the canvas, from its style, its hover style or an ancestor\'s', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 200, height: 200 });
    render(() => (
      <View style={{ cursor: 'grab' }}>
        <Action text="go" style={{ height: 40, cursor: 'pointer' }} />
        <View style={{ height: 40, hover: { cursor: 'ns-resize' } }} onPointerDown={() => {}} />
        <Edit value="" />
        <View style={{ height: 40 }} onPointerDown={() => {}} />
      </View>
    ), doc);
    const stop = attach(doc, /** @type {any} */ (canvas));
    const at = (/** @type {number} */ y) => {
      const e = new window.PointerEvent('pointermove', { bubbles: true });
      Object.defineProperty(e, 'offsetX', { value: 10 });
      Object.defineProperty(e, 'offsetY', { value: y });
      canvas.dispatchEvent(e);
      return canvas.style.cursor;
    };
    assert.deepEqual([at(10), at(50), at(90), at(140)], ['pointer', 'ns-resize', 'text', 'grab']);
    stop();
    doc.close();
  });

  it('shows a cursor set on an item with nothing else, and a cursor changed under a still pointer', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 200, height: 200 });
    /** @type {any} */
    let tool = null;
    render(() => {
      tool = $signal($active(), 'move');
      return <View><View style={() => ({ height: 50, cursor: $read(tool) })} /></View>;
    }, doc);
    const stop = attach(doc, /** @type {any} */ (canvas));
    const at = (/** @type {number} */ x) => {
      const e = new window.PointerEvent('pointermove', { bubbles: true });
      Object.defineProperty(e, 'offsetX', { value: x });
      Object.defineProperty(e, 'offsetY', { value: 10 });
      canvas.dispatchEvent(e);
      return canvas.style.cursor;
    };
    assert.equal(at(10), 'move', 'a cursor alone makes the item a pointer target');
    $write(tool, 'crosshair');
    doc.present();
    assert.equal(at(11), 'crosshair', 'the next move shows the new cursor');
    stop();
    doc.close();
  });

  it('shows a pressed or focused style\'s cursor, after the press with no move and on a move while pressed', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 200, height: 200 });
    render(() => (
      <View>
        <View style={{ height: 50, cursor: 'grab', press: { cursor: 'grabbing' } }} onPress={() => {}} />
        <Action text="go" style={{ height: 40, cursor: 'pointer', focus: { cursor: 'help' } }} />
      </View>
    ), doc);
    const stop = attach(doc, /** @type {any} */ (canvas));
    const send = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y) => {
      const e = new window.PointerEvent(type, { bubbles: true, button: 0 });
      Object.defineProperty(e, 'offsetX', { value: x });
      Object.defineProperty(e, 'offsetY', { value: y });
      canvas.dispatchEvent(e);
      return canvas.style.cursor;
    };
    assert.equal(send('pointermove', 10, 10), 'grab');
    assert.equal(send('pointerdown', 10, 10), 'grabbing', 'the press shows its cursor with no move');
    assert.equal(send('pointermove', 12, 10), 'grabbing', 'and keeps it while pressed');
    assert.equal(send('pointerup', 12, 10), 'grab', 'the release shows the item\'s own again');
    assert.equal(send('pointermove', 10, 70), 'pointer');
    send('pointerdown', 10, 70);
    send('pointerup', 10, 70);
    assert.equal(canvas.style.cursor, 'help', 'the focused Action shows its focus style\'s cursor');
    stop();
    doc.close();
  });

  it('shows the cursor a frame draws under a still pointer: a restyled item, an item shown there', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 200, height: 200 });
    /** @type {any} */
    let tool = null;
    /** @type {any} */
    let open = null;
    render(() => {
      tool = $signal($active(), 'move');
      open = $signal($active(), false);
      return (
        <View>
          <View style={() => ({ height: 50, cursor: $read(tool) })} />
          <Show when={() => $read(open)}><View style={{ height: 50, cursor: 'pointer' }} /></Show>
        </View>
      );
    }, doc);
    const stop = attach(doc, /** @type {any} */ (canvas));
    const at = (/** @type {number} */ y) => {
      const e = new window.PointerEvent('pointermove', { bubbles: true });
      Object.defineProperty(e, 'offsetX', { value: 10 });
      Object.defineProperty(e, 'offsetY', { value: y });
      canvas.dispatchEvent(e);
      return canvas.style.cursor;
    };
    assert.equal(at(10), 'move');
    $write(tool, 'crosshair');
    doc.present();
    assert.equal(canvas.style.cursor, 'crosshair', 'a restyle shows with no move');
    assert.equal(at(70), 'default');
    $write(open, true);
    doc.present();
    assert.equal(canvas.style.cursor, 'pointer', 'an item shown under the pointer shows its cursor with no move');
    canvas.dispatchEvent(new window.PointerEvent('pointerleave'));
    $write(open, false);
    doc.present();
    assert.equal(canvas.style.cursor, 'pointer', 'a pointer gone from the canvas finds nothing again');
    stop();
    doc.close();
  });

  it('takes a new theme at once, keeping the scene, focus and state', () => {
    const doc = new Document(mono, { width: 200, height: 200, theme: { accent: 0xff112233, field: 38 } });
    render(() => (
      <View>
        <Action text="go" />
        <Edit value="kept" />
      </View>
    ), doc);
    doc.press(20, 50);
    const focused = doc.current;
    const fill = () => doc.commands().find(c => c[0] === 'round')?.[5];
    assert.equal(fill(), '#ff112233');
    doc.setTheme({ accent: 0xff445566, field: 50 });
    assert.equal(fill(), '#ff445566', 'painted in the new theme');
    assert.equal(/** @type {any} */ (doc.root.first).first.h, 50, 'laid out in its metrics');
    assert.equal(doc.current, focused, 'the focus stays');
    assert.equal(doc.background, doc.theme.canvas, 'the background follows the theme');
    doc.close();
  });
  it('tells an Image given a source that failed here, after the next present', async () => {
    const doc = new Document(mono, { width: 200, height: 100 });
    /** @type {string[]} */
    const heard = [];
    /** @type {any} */
    let shown = null;
    render(() => {
      shown = $signal($active(), false);
      return <View><Show when={() => $read(shown)}><Image source="gone.png" width={10} height={10} onError={() => heard.push('error')} /></Show></View>;
    }, doc);
    doc.present();
    // The replay's loader failed on it (Replay2D or ren-skia's call this).
    doc.failed('gone.png');
    $write(shown, true);
    doc.present();
    assert.deepEqual(heard, [], 'told after the frame');
    await Promise.resolve();
    assert.deepEqual(heard, ['error'], 'an Image mounted on a failed source hears error');
    // The replay evicted it (forgot): the next Image on it waits for its own load.
    doc.forgot('gone.png');
    $write(shown, false);
    doc.present();
    $write(shown, true);
    doc.present();
    await Promise.resolve();
    assert.deepEqual(heard, ['error'], 'no error from a failure forgotten');
    assert.equal(doc.broken.size, 0);
    doc.close();
  });
  it('keeps the accessibility mirror where assistive technology reads it: no content-visibility on its box', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 200, height: 100 });
    render(() => <View><Action text="Go" /></View>, doc);
    const stop = attach(doc, canvas);
    const box = /** @type {any} */ (window.document.querySelector('[data-ren-aria]'));
    // Chrome leaves the content of an off-screen content-visibility:auto box out of its accessibility tree.
    assert.doesNotMatch(box.getAttribute('style'), /content-visibility/);
    assert.equal(box.querySelector('button').textContent, 'Go');
    stop();
    doc.close();
  });
});
