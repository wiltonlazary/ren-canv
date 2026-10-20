// Text selection on a canvas, as in a browser: press and drag across Labels
// (in document order), double press for a word, triple for a Label, Shift
// to extend, select all and copy; inside an Edit the same gestures select
// its value. Presses on Actions press them; `select: 'none'` opts out.
// That is a page's behavior (`behavior: 'page'`); an application's (the
// default) selects only in an Edit and where `select: 'text'` opts in, and
// keeps Ctrl+A, the I-beam and the browser's context menu there too.
// Text at fontSize 10 is 5 wide per character, 20 high per line.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyWindow } from 'happy-dom';
import { View, Label, Edit, Action, Show, $active } from 'ren-core';
import { $signal, $read, $write } from 'rrx-core';
import { Document, render, attach, loadLayout } from 'ren-canv';

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

const mono = {
  width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2,
  metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
  close() {},
};

/** Labels at 0..20 and 20..40, an Action at 40..78, an unselectable Label at 78..98, an Edit at 98..136 (its text from x 11, its line box from y 107). @param {import('ren-canv').Options} [options] */
function page(options) {
  const doc = new Document(mono, { width: 300, height: 300, ...options });
  /** @type {string[]} */
  const pressed = [];
  render(() => (
    <View style={{ fontSize: 10, lineHeight: 2 }}>
      <Label text="hello world" />
      <Label text="second line" />
      <Action text="Go" onPress={() => pressed.push('go')} />
      <Label text="no" style={{ select: 'none' }} />
      <Edit value="alpha beta" />
    </View>
  ), doc);
  const highlights = () => doc.commands().filter(c => c[0] === 'rect' && c[5] === '#ffaae4f5').map(c => c.slice(1, 5));
  return { doc, pressed, highlights };
}

describe('ren canv text selection', () => {
  it('selects by dragging across Labels, and copies the text with a line break between them', () => {
    const { doc, highlights } = page({ behavior: 'page' });
    doc.press(12, 10);
    assert.equal(doc.copied(), '', 'a click in text selects nothing');
    assert.deepEqual(highlights(), []);
    doc.move(52, 30);
    assert.equal(doc.copied(), 'llo world\nsecond lin');
    // Each Label's highlight covers its selected characters.
    assert.deepEqual(highlights(), [[10, 0, 55, 20], [0, 20, 50, 40]]);
    doc.release(52, 30);
    doc.move(200, 200);
    assert.equal(doc.copied(), 'llo world\nsecond lin', 'moving without a button changes nothing');
    doc.press(250, 280);
    assert.equal(doc.copied(), '', 'a press on nothing clears it');
    assert.deepEqual(highlights(), []);
  });

  it('selects a word on a double press and the Label on a triple, and extends with Shift', () => {
    const { doc } = page({ behavior: 'page' });
    doc.press(40, 10, 2);
    assert.equal(doc.copied(), 'world');
    doc.press(40, 10, 3);
    assert.equal(doc.copied(), 'hello world');
    doc.press(0, 10);
    doc.press(30, 30, 1, true);
    assert.equal(doc.copied(), 'hello world\nsecond');
  });

  it('selects a number and a contraction whole on a double press, as a browser does', () => {
    const doc = new Document(mono, { width: 400, height: 100, behavior: 'page' });
    render(() => <View style={{ fontSize: 10, lineHeight: 2 }}><Label text="C 218.41 can't 3,284." /></View>, doc);
    // 5 wide a character: "218.41" at 10..40, "can't" at 45..70, "3,284" at 75..100.
    doc.press(22, 10, 2);
    assert.equal(doc.copied(), '218.41');
    doc.press(55, 10, 2);
    assert.equal(doc.copied(), "can't");
    doc.press(85, 10, 2);
    assert.equal(doc.copied(), '3,284', 'a final point ends the sentence, not the number');
    doc.close();
  });

  it('selects a word with letters past the BMP, marks and joiners whole on a double press, by code point', () => {
    for (const [text, at, want] of /** @type {[string, number, string][]} */ ([
      // 5 wide a UTF-16 unit: "x𝒜y" at 15..35 (𝒜 two units), "𠀀𠀁" at 15..35 (𠀁 from 25);
      // a press takes the offset nearest it, then the character after it.
      ['ab x\u{1D49C}y cd', 17, 'x\u{1D49C}y'],
      ['ab x\u{1D49C}y cd', 25, 'x\u{1D49C}y'],
      ['ab x\u{1D49C}y cd', 32, 'x\u{1D49C}y'],
      ['ab \u{20000}\u{20001} cd', 17, '\u{20000}\u{20001}'],
      ['ab \u{20000}\u{20001} cd', 27, '\u{20000}\u{20001}'],
      // Combining marks and joiners extend a word: café decomposed, não, कित (a vowel sign), a ZWJ.
      ['ab cafe\u0301 cd', 17, 'cafe\u0301'],
      ['ab cafe\u0301 cd', 37, 'cafe\u0301'],
      ['ab na\u0303o cd', 27, 'na\u0303o'],
      ['ab \u0915\u093f\u0924 cd', 17, '\u0915\u093f\u0924'],
      ['ab \u0915\u094d\u200d\u0937 cd', 22, '\u0915\u094d\u200d\u0937'],
      // An apostrophe between letters, the one before it with its accent composed or apart: café's.
      ['ab caf\u00e9\'s cd', 17, 'caf\u00e9\'s'],
      ['ab cafe\u0301\'s cd', 17, 'cafe\u0301\'s'],
      ['ab cafe\u0301\'s cd', 47, 'cafe\u0301\'s'],
    ])) {
      const doc = new Document(mono, { width: 400, height: 100, behavior: 'page' });
      render(() => <View style={{ fontSize: 10, lineHeight: 2 }}><Label text={text} /></View>, doc);
      doc.press(at, 10, 2);
      assert.equal(doc.copied(), want, `${JSON.stringify(text)} at ${at}`);
      doc.close();
    }
  });

  it('selects the whole word from a press on its point, comma or apostrophe, in a Label and an Edit', () => {
    const text = "C 218.41 can't 3,284.";
    // 5 wide a character in the Label: '.' 25..30, "'" 60..65, ',' 80..85, 'n' 55..60 (its right half nearest the "'").
    const cases = /** @type {[number, string][]} */ ([[5, '218.41'], [12, "can't"], [16, '3,284']]);
    const label = new Document(mono, { width: 400, height: 100, behavior: 'page' });
    render(() => <View style={{ fontSize: 10, lineHeight: 2 }}><Label text={text} /></View>, label);
    for (const [at, want] of cases) {
      label.press(at * 5 + 2, 10, 2);
      assert.equal(label.copied(), want, `the Label, pressed on ${JSON.stringify(text[at])}`);
    }
    label.press(58, 10, 2);
    assert.equal(label.copied(), "can't", 'the right half of its n');
    label.close();
    const edit = new Document(mono, { width: 400, height: 100 });
    render(() => <View style={{ fontSize: 10, lineHeight: 2 }}><Edit value={text} /></View>, edit);
    edit.present();
    /** The x of each caret offset along the Edit's line, found by pressing across it. @type {Map<number, number>} */
    const xs = new Map();
    for (let x = 0; x < 300; x++) {
      edit.press(x, 20);
      edit.release(x, 20);
      if (!xs.has(edit.caret)) xs.set(edit.caret, x);
    }
    for (const [at, want] of cases) {
      edit.press(/** @type {number} */ (xs.get(at)), 20, 2);
      assert.equal(edit.copied(), want, `the Edit, pressed on ${JSON.stringify(text[at])}`);
    }
    edit.close();
  });

  it('places an empty paragraph\'s row after its line break: a press there and a selection over it', () => {
    for (const [text, want] of /** @type {[string, number[]][]} */ ([['a\n\nb', [0, 2, 3]], ['a\n\n\nb', [0, 2, 3, 4]], ['\nb', [0, 1]]])) {
      const doc = new Document(mono, { width: 300, height: 300, behavior: 'page' });
      /** @type {any} */
      let label = null;
      render(() => <View style={{ fontSize: 10, lineHeight: 2 }}><Label ref={(/** @type {any} */ n) => (label = n)} text={text} style={{ wrap: true, width: 100 }} /></View>, doc);
      doc.present();
      assert.deepEqual(label.starts, want, JSON.stringify(text));
      // A drag from the first row's start to the last row's start: all but the last row's text.
      doc.press(0, 10);
      doc.move(0, 20 * (want.length - 1) + 10);
      doc.release(0, 20 * (want.length - 1) + 10);
      assert.equal(doc.copied(), text.slice(0, want[want.length - 1]), `${JSON.stringify(text)}: copied to the last row`);
      doc.close();
    }
  });

  it('runs a wrapped row\'s highlight on past its end when the selection goes on', () => {
    const doc = new Document(mono, { width: 300, height: 300, behavior: 'page' });
    render(() => <View style={{ fontSize: 10, lineHeight: 2, width: 30 }}><Label text="aa bb cc" style={{ wrap: true }} /></View>, doc);
    doc.press(0, 10);
    doc.move(10, 30);
    assert.equal(doc.copied(), 'aa bb cc'.slice(0, 8));
    const rects = doc.commands().filter(c => c[0] === 'rect' && c[5] === '#ffaae4f5').map(c => c.slice(1, 5));
    // Rows "aa bb" (0..25, then the space it breaks at: 30) and "cc".
    assert.deepEqual(rects, [[0, 0, 30, 20], [0, 20, 10, 40]]);
  });

  it('extends a drag past the text to the nearest text', () => {
    const { doc } = page({ behavior: 'page' });
    doc.press(5, 10);
    doc.move(290, 30);
    assert.equal(doc.copied(), 'ello world\nsecond line', 'past the end of the row: to its end');
  });

  it('presses Actions instead of selecting, and leaves unselectable text alone', () => {
    const { doc, pressed } = page({ behavior: 'page' });
    doc.press(10, 50);
    assert.deepEqual(pressed, ['go']);
    assert.equal(doc.copied(), '');
    assert.equal(doc.press(5, 88), false, "select: 'none' is not selectable");
    assert.equal(doc.selectAll(), true);
    assert.equal(doc.copied(), 'hello world\nsecond line', 'select all takes the selectable text');
  });

  it("selects inside an Edit: a drag, a double press, select all", () => {
    const { doc } = page();
    doc.press(17, 115);
    assert.equal(doc.focused?.kind, 4);
    assert.equal(doc.caret, 1);
    doc.move(37, 115);
    assert.deepEqual([doc.anchor, doc.caret], [1, 5]);
    assert.equal(doc.copied(), 'lpha');
    doc.release(37, 115);
    doc.press(17, 115, 2);
    assert.equal(doc.copied(), 'alpha');
    doc.press(17, 115, 3);
    assert.equal(doc.copied(), 'alpha beta');
    doc.press(17, 115);
    doc.selectAll();
    assert.equal(doc.copied(), 'alpha beta');
  });

  it('routes the platform: click counts, Shift, Ctrl+A and copy through attach', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const { doc } = page({ behavior: 'page' });
    const stop = attach(doc, canvas);
    const fire = (/** @type {string} */ type, /** @type {any} */ props) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      for (const key in props) Object.defineProperty(event, key, { value: props[key] });
      canvas.dispatchEvent(event);
      return event;
    };
    // As Chrome sends them: a pointerdown's detail is 0, so the count comes from the presses' times and places.
    const down = (/** @type {number} */ at, /** @type {number} */ x = 40) => fire('pointerdown', { button: 0, offsetX: x, offsetY: 10, detail: 0, timeStamp: at });
    down(1000);
    assert.equal(doc.copied(), '');
    down(1200);
    assert.equal(doc.copied(), 'world', 'a double click selects the word');
    down(1400, 42);
    assert.equal(doc.copied(), 'hello world', 'a triple click, a pixel or two away, the Label');
    down(3000);
    assert.equal(doc.copied(), '', 'a press long after starts a new run');
    down(3100, 12);
    assert.equal(doc.copied(), '', 'as does a press far away');
    down(3300, 12);
    assert.equal(doc.copied(), 'hello');
    /** @type {Record<string, string>} */
    const clipboard = {};
    const copied = fire('copy', { clipboardData: { setData: (/** @type {string} */ type, /** @type {string} */ text) => (clipboard[type] = text) } });
    assert.equal(clipboard['text/plain'], 'hello');
    assert.equal(copied.defaultPrevented, true);
    const all = fire('keydown', { key: 'a', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
    assert.equal(all.defaultPrevented, true);
    assert.equal(doc.copied(), 'hello world\nsecond line');
    stop();
  });

  it("keeps the browser's context menu away where the app shows its own (prevent=\"contextmenu\")", () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300, behavior: 'page' });
    render(() => (
      <View style={{ fontSize: 10, lineHeight: 2 }}>
        <View prevent="contextmenu" onPointerDown={() => {}}>
          <Label text="menu here" />
        </View>
        <Label text="the browser's" />
        <View prevent={['press', 'contextmenu']}>
          <Label text="a list" />
        </View>
        <View prevent>
          <Label text="press only" />
        </View>
      </View>
    ), doc);
    const stop = attach(doc, canvas);
    const menu = (/** @type {number} */ y) => {
      const event = new window.Event('contextmenu', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'offsetX', { value: 10 });
      Object.defineProperty(event, 'offsetY', { value: y });
      canvas.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(menu(10), true, 'on a Label inside the item that asks');
    assert.equal(menu(30), false);
    assert.equal(menu(50), true, 'named in a list');
    assert.equal(menu(70), false, 'true is press and submit only');
    assert.equal(menu(200), false, 'over nothing');
    stop();
  });

  it('lets a right press reach the pointer handlers, pressing and selecting nothing', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300, behavior: 'page' });
    /** @type {string[]} */
    const pressed = [];
    /** @type {number[]} */
    const buttons = [];
    render(() => (
      <View style={{ fontSize: 10, lineHeight: 2 }} onPointerDown={e => buttons.push(e.button)}>
        <Label text="hello world" />
        <Action text="Go" onPress={() => pressed.push('go')} />
      </View>
    ), doc);
    const stop = attach(doc, canvas);
    const fire = (/** @type {string} */ type, /** @type {any} */ props) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      for (const key in props) Object.defineProperty(event, key, { value: props[key] });
      canvas.dispatchEvent(event);
    };
    fire('pointerdown', { button: 2, offsetX: 40, offsetY: 10, timeStamp: 0 });
    fire('pointerup', { button: 2, offsetX: 40, offsetY: 10 });
    assert.equal(doc.copied(), '', 'no selection');
    fire('pointerdown', { button: 2, offsetX: 10, offsetY: 30, timeStamp: 1000 });
    fire('pointerup', { button: 2, offsetX: 10, offsetY: 30 });
    assert.deepEqual(pressed, [], 'the Action is not pressed');
    assert.deepEqual(buttons, [2, 2], 'the handler heard both right presses');
    stop();
  });

  it('keeps a touch the app pressed from the page\'s pan, and ends a press the browser takes back with pointercancel', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {string[]} */
    const heard = [];
    render(() => (
      <View style={{ fontSize: 10, lineHeight: 2 }} onPointerCancel={e => heard.push(`page ${e.type}`)}>
        <View
          style={{ height: 40 }}
          onPointerDown={e => heard.push(`down ${e.x}`)}
          onPointerMove={e => heard.push(`move ${e.x}`)}
          onPointerUp={e => heard.push(`up ${e.x},${e.y}`)}
          onPointerCancel={e => heard.push(`cancel ${e.x},${e.y} ${e.buttons}`)}
        />
      </View>
    ), doc);
    const stop = attach(doc, canvas);
    const fire = (/** @type {string} */ type, /** @type {any} */ props = {}) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      for (const key in props) Object.defineProperty(event, key, { value: props[key] });
      canvas.dispatchEvent(event);
      return event.defaultPrevented;
    };
    fire('pointerdown', { button: 0, offsetX: 10, offsetY: 10, pointerType: 'touch' });
    assert.equal(fire('touchstart'), true, 'the pressed item keeps the touch');
    fire('pointermove', { offsetX: 30, offsetY: 12, buttons: 1 });
    // Chrome's cancel says 0, 0: it is where the pointer was, and no release follows.
    fire('pointercancel', { offsetX: 0, offsetY: 0 });
    assert.deepEqual(heard, ['down 10', 'move 30', 'cancel 30,12 0', 'page pointercancel']);
    assert.equal(doc.pressed, null, 'the press ended');
    heard.length = 0;
    fire('pointermove', { offsetX: 40, offsetY: 12, buttons: 0 });
    fire('pointerup', { offsetX: 40, offsetY: 12 });
    assert.deepEqual(heard, ['move 40', 'up 40,12'], 'nothing holds the pointer after');
    fire('pointerdown', { button: 0, offsetX: 10, offsetY: 200, pointerType: 'touch' });
    assert.equal(fire('touchstart'), false, 'a touch on nothing lets the page pan');
    stop();
  });

  it('keeps the page from the pans and zoom a touch\'s items forbid (touchAction), and lets it take the rest', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 400 });
    const press = () => {};
    render(() => (
      <View style={{ fontSize: 10, lineHeight: 2 }}>
        <View style={{ height: 40, touchAction: 'none' }} />
        <View style={{ height: 40, touchAction: 'pan-y' }} onPointerDown={press} />
        <View style={{ height: 40, touchAction: 'pan-x pan-y' }}>
          <View style={{ height: 20, touchAction: 'pan-x pinch-zoom' }} />
        </View>
        <View style={{ height: 40, touchAction: 'auto' }} onPointerDown={press} />
        <View style={{ height: 40 }}>
          <View style={{ height: 20, touchAction: 'pinch-zoom' }} />
        </View>
        <View style={{ height: 40 }} onPointerDown={press} />
      </View>
    ), doc);
    const stop = attach(doc, canvas);
    const fire = (/** @type {string} */ type, /** @type {any} */ props = {}) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      for (const key in props) Object.defineProperty(event, key, { value: props[key] });
      canvas.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const at = (/** @type {number} */ x, /** @type {number} */ y) => [{ clientX: x, clientY: y }];
    /** A touch at y: whether its start, then its first move by (dx, dy), were cancelled. @param {number} y @param {number} dx @param {number} dy */
    const gesture = (y, dx, dy) => {
      fire('pointerdown', { button: 0, offsetX: 10, offsetY: y, pointerType: 'touch' });
      const start = fire('touchstart', { touches: at(10, y) });
      const move = fire('touchmove', { touches: at(10 + dx, y + dy) });
      fire('pointerup', { offsetX: 10, offsetY: y });
      return [start, move];
    };
    assert.equal(doc.touchAction(10, 10), 0);
    assert.deepEqual(gesture(10, 0, 20), [true, false], 'none: the start is cancelled, the page stays');
    assert.deepEqual(gesture(50, 0, 20), [false, false], 'pan-y: a vertical pan is the page\'s, though a handler took the press');
    assert.deepEqual(gesture(50, 20, 2), [false, true], 'pan-y: a horizontal first move is cancelled');
    assert.equal(doc.touchAction(10, 90), 1, 'the item and its ancestors allow a pan-x together');
    assert.deepEqual(gesture(90, 20, 0), [false, false]);
    assert.deepEqual(gesture(90, 0, 20), [false, true]);
    assert.deepEqual(gesture(130, 0, 20), [false, false], 'auto: the page pans, though a handler took the press');
    assert.equal(doc.touchAction(10, 170), 4);
    assert.deepEqual(gesture(170, 0, 20), [false, true], 'pinch-zoom alone: a one finger pan stays on the canvas');
    fire('pointerdown', { button: 0, offsetX: 10, offsetY: 170, pointerType: 'touch' });
    assert.equal(fire('touchstart', { touches: [...at(10, 170), ...at(40, 170)] }), false, 'a second finger may zoom');
    assert.equal(fire('touchmove', { touches: [...at(10, 170), ...at(60, 170)] }), false);
    fire('pointerdown', { button: 0, offsetX: 10, offsetY: 90, pointerType: 'touch' });
    assert.equal(fire('touchstart', { touches: [...at(10, 90), ...at(40, 90)] }), true, 'pan-x alone forbids a pinch zoom');
    assert.equal(fire('touchmove', { touches: [...at(10, 90), ...at(60, 90)] }), true);
    assert.equal(doc.touchAction(10, 210), -1, 'none set: the default');
    assert.deepEqual(gesture(210, 0, 20), [true, false], 'a press taken keeps the page from panning');
    assert.deepEqual(gesture(390, 0, 20), [false, false], 'nothing there: the page pans');
    stop();
  });
  it('leaves a removed Label out of the selection and what it copies, as a DOM range does', () => {
    const doc = new Document(mono, { width: 300, height: 200, behavior: 'page' });
    /** @type {any} */
    let on = null;
    /** @type {any} */
    let first = null;
    render(() => {
      on = $signal($active(), true);
      return (
        <View style={{ fontSize: 10, lineHeight: 2 }}>
          <Show when={() => $read(on)}><Label text="one" /></Show>
          <Label text="two" />
          <Show when={() => $read(on)}><Label text="three" /></Show>
        </View>
      );
    }, doc);
    doc.present();
    doc.selectAll();
    assert.equal(doc.copied(), 'one\ntwo\nthree');
    first = doc.anchorItem;
    $write(on, false);
    doc.present();
    assert.equal(doc.copied(), 'two', 'the removed Labels copy nothing');
    assert.equal(doc.selected.length, 1);
    assert.equal(doc.anchorItem, null, 'a removed end is let go');
    assert.equal(doc.focusItem, null);
    assert.equal(first.from, -1, 'a removed Label keeps no range');
    doc.close();
  });
});

/**
 * A Label of loose text at 0..20, a `select: 'text'` View holding two at
 * 20..40 and 40..60, loose text at 60..80, an Edit at 80..118 (its text from
 * x 11, its line box from y 89), attached to a happy-dom canvas.
 * @param {import('ren-core/host').Behavior} [behavior]
 */
function app(behavior) {
  const window = new Window();
  const canvas = window.document.createElement('canvas');
  window.document.body.appendChild(canvas);
  const doc = new Document(mono, { width: 300, height: 300, behavior });
  render(() => (
    <View style={{ fontSize: 10, lineHeight: 2 }}>
      <Label text="loose text" />
      <View style={{ select: 'text' }}>
        <Label text="chosen one" />
        <Label text="chosen two" />
      </View>
      <Label text="after" />
      <Edit value="alpha beta" />
    </View>
  ), doc);
  const stop = attach(doc, canvas);
  const fire = (/** @type {string} */ type, /** @type {any} */ props) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    for (const key in props) Object.defineProperty(event, key, { value: props[key] });
    canvas.dispatchEvent(event);
    return event.defaultPrevented;
  };
  /** Ctrl+A on the canvas: whether the browser's is cancelled. */
  const all = () => fire('keydown', { key: 'a', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
  /** A context menu at a point: whether the browser's is cancelled. @param {number} x @param {number} y */
  const menu = (x, y) => fire('contextmenu', { offsetX: x, offsetY: y });
  /** The cursor the canvas shows with the pointer at a point. @param {number} x @param {number} y */
  const cursor = (x, y) => {
    fire('pointermove', { offsetX: x, offsetY: y, buttons: 0 });
    return doc.cursor;
  };
  return { doc, canvas, stop, all, menu, cursor };
}

describe('ren canv behavior: an application by default, a page on demand', () => {
  it('selects only where select: \'text\' opts in: loose text takes no drag and no double press', () => {
    const { doc, stop } = app();
    doc.press(5, 10);
    doc.move(40, 10);
    doc.release(40, 10);
    assert.equal(doc.copied(), '', 'a drag over loose text');
    doc.press(5, 10, 2);
    assert.equal(doc.copied(), '', 'a double press on loose text');
    doc.press(5, 70, 3);
    assert.equal(doc.copied(), '', 'a triple press on loose text');
    doc.press(0, 30);
    doc.move(22, 50);
    doc.release(22, 50);
    assert.equal(doc.copied(), 'chosen one\nchos', 'a drag in the opted-in View');
    doc.press(5, 50, 2);
    assert.equal(doc.copied(), 'chosen');
    stop();
  });

  it('keeps Ctrl+A from the page: it selects inside the opted-in element the selection is in, an Edit\'s value, else nothing', () => {
    const { doc, stop, all } = app();
    assert.equal(all(), true, 'the browser selects nothing');
    assert.equal(doc.copied(), '');
    doc.press(5, 30);
    assert.equal(all(), true);
    assert.equal(doc.copied(), 'chosen one\nchosen two', 'the opted-in View\'s text');
    doc.press(5, 10);
    assert.equal(all(), true);
    assert.equal(doc.copied(), '', 'from loose text: nothing');
    assert.equal(doc.selectAll(), false);
    doc.press(17, 97);
    assert.equal(doc.focused?.kind, 4);
    assert.equal(all(), true);
    assert.equal(doc.copied(), 'alpha beta', 'the focused Edit\'s value');
    stop();
  });

  it("keeps the browser's context menu in an Edit only, and none with editMenu: false", () => {
    const one = app();
    assert.equal(one.menu(10, 10), true, 'over loose text');
    assert.equal(one.menu(10, 30), true, 'over opted-in text');
    assert.equal(one.menu(200, 250), true, 'over nothing');
    assert.equal(one.menu(17, 97), false, 'over an Edit: paste, spelling');
    one.stop();
    const two = app({ editMenu: false });
    assert.equal(two.menu(17, 97), true, 'editMenu: false');
    two.stop();
    const three = app({ like: 'page', editMenu: false });
    assert.equal(three.menu(10, 10), false, 'a page keeps it outside the Edit');
    assert.equal(three.menu(17, 97), true, 'its Edit as editMenu says');
    three.stop();
    // An item that shows the app's own still cancels the browser's in an Edit.
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300 });
    render(() => <View prevent="contextmenu" style={{ fontSize: 10, lineHeight: 2 }}><Edit value="own menu" /></View>, doc);
    const stop = attach(doc, canvas);
    const event = new window.Event('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'offsetX', { value: 17 });
    Object.defineProperty(event, 'offsetY', { value: 17 });
    canvas.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, 'prevent="contextmenu"');
    stop();
  });

  it('shows the I-beam over opted-in text and an Edit, the default over loose text; textCursor over any selectable text', () => {
    const one = app();
    assert.equal(one.cursor(5, 10), 'default', 'loose text');
    assert.equal(one.cursor(5, 30), 'text', 'opted-in text');
    assert.equal(one.canvas.style.cursor, 'text', 'on the canvas');
    assert.equal(one.cursor(17, 97), 'text', 'an Edit');
    assert.equal(one.cursor(200, 250), 'default', 'nothing');
    one.stop();
    const two = app({ select: true });
    assert.equal(two.cursor(5, 10), 'default', 'selectable loose text, no textCursor');
    assert.equal(two.cursor(5, 30), 'text');
    two.stop();
    const three = app({ select: true, textCursor: true });
    assert.equal(three.cursor(5, 10), 'text', 'textCursor alone');
    three.stop();
    const four = app('page');
    assert.equal(four.cursor(5, 10), 'text', 'a page');
    four.stop();
    const five = app({ like: 'page', textCursor: false });
    assert.equal(five.cursor(5, 10), 'default');
    assert.equal(five.cursor(5, 30), 'text', 'opted-in text still');
    five.stop();
    // A cursor a style names wins over the I-beam, and the text under it stays its own target.
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {string[]} */
    const pressed = [];
    render(() => (
      <View style={{ fontSize: 10, lineHeight: 2, select: 'text' }}>
        <View style={{ cursor: 'pointer' }} onPress={() => pressed.push('card')}><Label text="card" /></View>
        <View onPress={() => pressed.push('row')}><Label text="row" /></View>
      </View>
    ), doc);
    const stop = attach(doc, canvas);
    doc.move(5, 10);
    assert.equal(doc.cursor, 'pointer');
    doc.move(5, 30);
    assert.equal(doc.cursor, 'text');
    doc.press(5, 30);
    doc.release(5, 30);
    assert.deepEqual(pressed, ['row'], 'the press reaches its target');
    stop();
  });

  it("restores each part of a page alone: select, selectAll, menu; and the whole of it as 'page'", () => {
    const select = app({ select: true });
    select.doc.press(5, 10);
    select.doc.move(40, 10);
    select.doc.release(40, 10);
    assert.equal(select.doc.copied(), 'oose te', 'select: loose text');
    select.doc.press(5, 10);
    assert.equal(select.all(), true, 'Ctrl+A still the app\'s');
    assert.equal(select.doc.copied(), '');
    select.stop();
    const all = app({ selectAll: true });
    assert.equal(all.all(), true);
    assert.equal(all.doc.copied(), 'chosen one\nchosen two', 'selectAll: all the selectable text');
    all.stop();
    const menu = app({ menu: true });
    assert.equal(menu.menu(10, 10), false, 'menu: the browser\'s over loose text');
    menu.stop();
    const page = app('page');
    page.doc.press(5, 10, 2);
    assert.equal(page.doc.copied(), 'loose');
    assert.equal(page.all(), true);
    assert.equal(page.doc.copied(), 'loose text\nchosen one\nchosen two\nafter');
    assert.equal(page.menu(10, 10), false);
    page.stop();
  });

  it('leaves Ctrl+A to the browser in a page with nothing to select', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    for (const [behavior, prevented] of /** @type {[import('ren-core/host').Behavior, boolean][]} */ ([['page', false], ['app', true]])) {
      const doc = new Document(mono, { width: 300, height: 300, behavior });
      render(() => <View style={{ height: 40 }} />, doc);
      const stop = attach(doc, canvas);
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries({ key: 'a', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })) Object.defineProperty(event, key, { value });
      canvas.dispatchEvent(event);
      assert.equal(event.defaultPrevented, prevented, String(behavior));
      stop();
      doc.close();
    }
  });

  it('keeps the canvas from the touch callout and from being selected itself, until it stops', () => {
    /** A canvas whose style keeps every property it is given (happy-dom drops the -webkit- ones). */
    const canvas = () => {
      /** @type {Map<string, string>} */
      const props = new Map([['user-select', 'text']]);
      const style = {
        /** @param {string} name @param {string} value */
        setProperty: (name, value) => void props.set(name, value),
        /** @param {string} name */
        getPropertyValue: name => props.get(name) ?? '',
        /** @param {string} name */
        removeProperty: name => void props.delete(name),
      };
      return { style, props, addEventListener() {}, removeEventListener() {} };
    };
    for (const [behavior, want] of /** @type {[import('ren-core/host').Behavior | undefined, string[][]][]} */ ([
      [undefined, [['user-select', 'none'], ['-webkit-touch-callout', 'none'], ['-webkit-tap-highlight-color', 'transparent'], ['-webkit-user-select', 'none']]],
      [{ callout: true }, [['user-select', 'none'], ['-webkit-user-select', 'none']]],
      [{ select: true }, [['user-select', 'text'], ['-webkit-touch-callout', 'none'], ['-webkit-tap-highlight-color', 'transparent']]],
      ['page', [['user-select', 'text']]],
    ])) {
      const doc = new Document(mono, { width: 300, height: 300, behavior });
      const element = canvas();
      const stop = attach(doc, element);
      assert.deepEqual([...element.props], want, JSON.stringify(behavior));
      stop();
      assert.deepEqual([...element.props], [['user-select', 'text']], 'put back');
      doc.close();
    }
  });
});
