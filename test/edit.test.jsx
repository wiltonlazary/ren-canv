// The portable Edit and Label on a canvas, as the DOM has them: a controlled
// value, the caret after the view rewrites a value and the caret API
// (setSelectionRange, selectionStart, selectionEnd), disabled and readOnly,
// a secret, the placeholder's color, autosize, and a Label's line clamp and
// ellipsis. Text at fontSize 10 is 5 wide per character, 20 high per line.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window as HappyWindow } from 'happy-dom';
import { $signal, $read, $write } from 'rrx-core';
import { View, Label, Edit, $active, $keys } from 'ren-core';
import { Document, Sfnt, render, attach, loadLayout } from 'ren-canv';
import { Wrap } from '../src/text.js';

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

await loadLayout();

const mono = {
  width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2,
  metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
  close() {},
};

/** The texts a frame draws, with their colors. @param {Document} doc */
const texts = doc => doc.commands().filter(c => c[0] === 'text').map(c => [c[1], c[5]]);

/** A Document of 300 × 300 with `view`, and a ref for each item a test names. @param {(refs: Record<string, any>) => any} view */
function page(view) {
  const doc = new Document(mono, { width: 300, height: 300 });
  /** @type {Record<string, any>} */
  const refs = {};
  render(() => <View style={{ fontSize: 10, lineHeight: 2 }}>{view(refs)}</View>, doc);
  doc.present();
  return { doc, refs };
}

describe('ren canv Edit and Label', () => {
  it('shows a controlled Edit\'s bound value again after a keystroke the view rejected', () => {
    /** @type {any} */
    let v;
    const { doc, refs } = page(r => {
      v = $signal($active(), 'ab');
      return <Edit ref={e => (r.edit = e)} value={v} onChange={e => { if (/^[a-z]*$/.test(e.value)) $write(v, e.value); }} />;
    });
    refs.edit.focus();
    doc.type('c');
    assert.equal(refs.edit.draft, 'abc');
    doc.type('X');
    assert.equal($read(v), 'abc');
    assert.equal(refs.edit.draft, 'abc', 'the rejected X is gone');
    assert.equal(doc.caret, 3);
    assert.ok(texts(doc).some(t => t[0] === 'abc'), 'and the frame shows the bound value');
    doc.close();
  });

  it('moves Home and End to the bounds of the caret\'s line in a multi-line Edit, as a textarea', () => {
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    render(() => <View><Edit ref={(/** @type {any} */ e) => (edit = e)} lines={3} value={'ab\ncd'} /></View>, doc);
    doc.present();
    edit.focus();
    doc.select(-1, 5);
    doc.key('Home');
    assert.equal(doc.caret, 3, 'the second line starts after the break');
    doc.select(-1, 1);
    doc.key('End');
    assert.equal(doc.caret, 2, 'the first line ends at the break');
    doc.select(4, 4);
    doc.key('Home', true);
    assert.deepEqual([doc.anchor, doc.caret], [4, 3], 'Shift extends to the line start');
    doc.close();
  });

  it('wraps, places the caret and types on code points: a surrogate pair is never split, and no empty row is added', () => {
    const sfnt = new Sfnt(readFileSync(new URL('./fixtures/dejavu.ttf', import.meta.url)));
    const fonts = { width: (/** @type {string} */ t, /** @type {number} */ s) => sfnt.width(t, s), metrics: (/** @type {number} */ s) => sfnt.metrics(s), close() {} };
    const lone = (/** @type {string[]} */ rows) => rows.some(r => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(r));
    const mixed = Wrap(fonts, 'ab\u{1F600}cd', 16, 30);
    assert.equal(lone(mixed), false, `no half of a pair in a row: ${JSON.stringify(mixed)}`);
    assert.equal(mixed.join(''), 'ab\u{1F600}cd', 'nothing lost');
    assert.deepEqual(Wrap(fonts, '\u{1F600}', 16, 5), ['\u{1F600}'], 'one character wider than the room is one row');
    assert.deepEqual(Wrap(fonts, 'ab', 16, 5), ['a', 'b'], 'no empty row after a word broken to the end');
    // A press inside the emoji puts the caret at one of its ends; typing keeps it whole.
    const doc = new Document(sfnt, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    /** @type {string | null} */
    let last = null;
    render(() => <View><Edit ref={(/** @type {any} */ e) => (edit = e)} value={'\u{1F600}'} onChange={(/** @type {any} */ e) => (last = e.value)} style={{ padding: 0, border: 0 }} /></View>, doc);
    doc.present();
    edit.focus();
    for (let dx = 0; dx <= 16; dx++) assert.notEqual(doc.place(edit, dx, 5), 1, `no caret inside the pair at ${dx}`);
    doc.select(-1, doc.place(edit, 9, 5));
    doc.key('x');
    assert.ok(last === '\u{1F600}x' || last === 'x\u{1F600}', JSON.stringify(last));
    doc.close();
  });

  it('never cuts a surrogate pair: an ellipsis, a place in a secret Edit, and keeps a one-line Edit\'s value on one line', () => {
    const lone = (/** @type {string} */ s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
    const doc = new Document(mono, { width: 300, height: 300 });
    render(() => (
      <View style={{ width: 100, fontSize: 10 }}>
        <Label text={'a'.repeat(18) + '\u{1F600}zzzz'} ellipsis />
        <Label text={'one two three four ' + 'b'.repeat(18) + '\u{1F600}zzzz'} lines={1} />
      </View>
    ), doc);
    doc.present();
    for (const drawn of doc.commands().filter(c => c[0] === 'text').map(c => String(c[1]))) assert.equal(lone(drawn), false, `an ellipsized row keeps the pair whole: ${JSON.stringify(drawn)}`);
    doc.close();
    // A secret Edit shows a bullet per UTF-16 unit; the caret lands on the value's code points.
    const secret = new Document(mono, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    /** @type {string | null} */
    let last = null;
    render(() => <View><Edit secret ref={(/** @type {any} */ e) => (edit = e)} value={'\u{1F600}'} onChange={(/** @type {any} */ e) => (last = e.value)} style={{ padding: 0, border: 0, fontSize: 10 }} /></View>, secret);
    secret.present();
    edit.focus();
    for (let dx = 0; dx <= 10; dx++) assert.notEqual(secret.place(edit, dx, 5), 1, `no place inside the pair at ${dx}`);
    secret.select(-1, secret.place(edit, 5, 5));
    secret.key('x');
    assert.ok(last === '\u{1F600}x' || last === 'x\u{1F600}', JSON.stringify(last));
    secret.close();
  });

  it('lets chords typed in the native entry reach the handlers, with their modifiers, and leaves copy to it', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    /** @type {string[]} */
    const heard = [];
    render(() => {
      $keys((/** @type {any} */ e) => {
        if (e.key === 'k' && e.ctrlKey) {
          heard.push(`keys k ctrl editable=${e.editable}`);
          e.preventDefault();
        }
      });
      return (
        <View onKey={(/** @type {any} */ e) => heard.push(`onKey ${e.key} ctrl=${e.ctrlKey} meta=${e.metaKey} alt=${e.altKey}`)}>
          <Edit ref={(/** @type {any} */ e) => (edit = e)} value="text" lines={3} />
        </View>
      );
    }, doc);
    const stop = attach(doc, canvas);
    edit.focus();
    doc.present();
    const area = /** @type {any} */ (window.document.activeElement);
    assert.equal(area.tagName, 'TEXTAREA');
    const press = (/** @type {any} */ init) => {
      const e = new window.KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      area.dispatchEvent(e);
      return e.defaultPrevented;
    };
    assert.equal(press({ key: 'k', ctrlKey: true }), true, 'a chord a handler prevents is kept from the textarea');
    assert.equal(press({ key: 'Enter', ctrlKey: true }), true);
    assert.equal(press({ key: 'c', metaKey: true }), false, 'copy, prevented by no handler, is the textarea\'s');
    assert.equal(press({ key: 'ArrowLeft', altKey: true }), false, 'a word move is the textarea\'s own');
    assert.deepEqual(heard, [
      'onKey k ctrl=true meta=false alt=false',
      'keys k ctrl editable=true',
      'onKey Enter ctrl=true meta=false alt=false',
      'onKey c ctrl=false meta=true alt=false',
      'onKey ArrowLeft ctrl=false meta=false alt=true',
    ]);
    assert.equal(doc.current, edit, 'the Edit keeps the focus');
    stop();
    doc.close();
  });

  it('leaves a modified caret or deletion key to the native entry, and moves as the plain key without one', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    /** @type {string[]} */
    const heard = [];
    render(() => <View onKey={(/** @type {any} */ e) => heard.push(`${e.key} ctrl=${e.ctrlKey} alt=${e.altKey} meta=${e.metaKey}`)}><Edit ref={(/** @type {any} */ e) => (edit = e)} value="one two three" /></View>, doc);
    const stop = attach(doc, canvas);
    edit.focus();
    doc.present();
    doc.select(-1, 8);
    const area = /** @type {any} */ (window.document.activeElement);
    assert.equal(area.tagName, 'TEXTAREA');
    for (const init of [{ key: 'ArrowLeft', ctrlKey: true }, { key: 'ArrowRight', altKey: true }, { key: 'Backspace', ctrlKey: true }, { key: 'Delete', altKey: true }, { key: 'Home', metaKey: true }, { key: 'End', ctrlKey: true }]) {
      const e = new window.KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      area.dispatchEvent(e);
      assert.equal(e.defaultPrevented, false, `${init.key} with a modifier is the textarea's`);
      assert.deepEqual([doc.anchor, doc.caret, doc.current?.draft], [8, 8, 'one two three'], `${init.key}: nothing moved or deleted here`);
    }
    assert.equal(heard.length, 6, 'the handlers heard each chord');
    const plain = new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    area.dispatchEvent(plain);
    assert.equal(plain.defaultPrevented, true, 'the plain key is still the renderer\'s');
    assert.equal(doc.caret, 7);
    stop();
    doc.close();
    // No native entry: the chord moves as the plain key does.
    const alone = new Document(mono, { width: 300, height: 300 });
    render(() => <View><Edit ref={(/** @type {any} */ e) => (edit = e)} value="one two three" /></View>, alone);
    alone.present();
    edit.focus();
    alone.select(-1, 8);
    assert.equal(alone.key('ArrowLeft', false, { ctrlKey: true }), true);
    assert.equal(alone.caret, 7);
    alone.close();
  });

  it('strips the line breaks a paste brings into a one-line Edit, as an input does', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    /** @type {string | null} */
    let last = null;
    render(() => <View><Edit ref={(/** @type {any} */ e) => (edit = e)} value="ab" onChange={(/** @type {any} */ e) => (last = e.value)} /></View>, doc);
    const stop = attach(doc, canvas);
    edit.focus();
    doc.present();
    const area = /** @type {any} */ (window.document.activeElement);
    area.value = 'afirst\r\nsecondb';
    area.setSelectionRange(14, 14);
    area.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    assert.equal(last, 'afirstsecondb', 'no line break in a one-line value');
    assert.deepEqual([doc.anchor, doc.caret], [12, 12], 'the caret shifts with what went');
    stop();
    doc.close();
  });

  it('steps, deletes and extends by grapheme cluster, as a browser: a flag, an accent apart, a ZWJ family', () => {
    const flag = '\u{1F1E7}\u{1F1F7}';
    const accent = 'e\u0301';
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const text = `a${flag}${accent}z${family}`;
    // a 0, the flag 1..5, e and its accent 5..7, z 7, the family 8..16.
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    render(() => <View><Edit ref={(/** @type {any} */ e) => (edit = e)} value={text} /></View>, doc);
    doc.present();
    edit.focus();
    doc.select(-1, 1);
    /** @type {number[]} */
    const right = [];
    for (let k = 0; k < 5; k++) {
      doc.key('ArrowRight');
      right.push(doc.caret);
    }
    assert.deepEqual(right, [5, 7, 8, 16, 16], 'ArrowRight');
    /** @type {number[]} */
    const left = [];
    for (let k = 0; k < 5; k++) {
      doc.key('ArrowLeft');
      left.push(doc.caret);
    }
    assert.deepEqual(left, [8, 7, 5, 1, 0], 'ArrowLeft');
    doc.select(-1, 1);
    doc.key('ArrowRight', true);
    doc.key('ArrowRight', true);
    assert.deepEqual([doc.anchor, doc.caret], [1, 7], 'Shift extends by cluster');
    assert.equal(doc.copied(), flag + accent);
    doc.close();
    /** The value after `key` at `caret`, in an Edit given the text afresh. @param {string} key @param {number} caret */
    const after = (key, caret) => {
      const fresh = new Document(mono, { width: 300, height: 300 });
      /** @type {any} */
      let field = null;
      /** @type {string | null} */
      let changed = null;
      render(() => <View><Edit ref={(/** @type {any} */ e) => (field = e)} value={text} onChange={(/** @type {any} */ e) => (changed = e.value)} /></View>, fresh);
      fresh.present();
      field.focus();
      fresh.select(-1, caret);
      fresh.key(key);
      fresh.close();
      return changed;
    };
    assert.equal(after('Delete', 1), `a${accent}z${family}`, 'Delete takes the flag whole');
    assert.equal(after('Delete', 8), `a${flag}${accent}z`, 'and the family');
    assert.equal(after('Backspace', 7), `a${flag}ez${family}`, 'Backspace after an accent apart takes the accent alone');
    assert.equal(after('Backspace', 5), `a${accent}z${family}`, 'Backspace takes the flag whole');
    assert.equal(after('Backspace', 16), `a${flag}${accent}z`, 'and the family');
    // An emoji shaped by a variation selector or a keycap goes whole.
    for (const emoji of ['\u2764\uFE0F', '1\uFE0F\u20E3', '\u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F']) {
      const fresh = new Document(mono, { width: 300, height: 300 });
      /** @type {any} */
      let field = null;
      /** @type {string | null} */
      let changed = null;
      render(() => <View><Edit ref={(/** @type {any} */ e) => (field = e)} value={`x${emoji}`} onChange={(/** @type {any} */ e) => (changed = e.value)} /></View>, fresh);
      fresh.present();
      field.focus();
      fresh.select(-1, 1 + emoji.length);
      fresh.key('Backspace');
      assert.equal(changed, 'x', `Backspace after ${JSON.stringify(emoji)}`);
      fresh.close();
    }
  });

  it('steps by the same clusters in a long value as the whole text holds: flags and a long ZWJ sequence past its window', () => {
    const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const flag = '\u{1F1E7}\u{1F1F7}';
    // A ZWJ sequence of 91 code points (181 code units), longer than the window read around the caret.
    const chain = `${'\u{1F468}\u200D'.repeat(45)}\u{1F467}`;
    for (const text of [
      `${'a'.repeat(3)}${flag.repeat(60)}b`,
      `${'a'.repeat(64)}${flag.repeat(60)}b${flag}`,
      `x${chain}y${chain}`,
      `${'ab'.repeat(40)}${chain}${'e\u0301'.repeat(30)}`,
    ]) {
      const bounds = [0, ...[...graphemes.segment(text)].map(g => g.index + g.segment.length)];
      const doc = new Document(mono, { width: 300, height: 300 });
      /** @type {any} */
      let edit = null;
      render(() => <View><Edit ref={(/** @type {any} */ e) => (edit = e)} value={text} /></View>, doc);
      doc.present();
      edit.focus();
      doc.select(-1, 0);
      /** @type {number[]} */
      const right = [0];
      while (doc.caret < text.length && right.length <= bounds.length) {
        doc.key('ArrowRight');
        right.push(doc.caret);
      }
      assert.deepEqual(right, bounds, `ArrowRight through ${JSON.stringify(text.slice(0, 12))}…`);
      /** @type {number[]} */
      const left = [text.length];
      while (doc.caret > 0 && left.length <= bounds.length) {
        doc.key('ArrowLeft');
        left.push(doc.caret);
      }
      assert.deepEqual(left, [...bounds].reverse(), 'ArrowLeft back');
      doc.close();
    }
  });

  it('reads only the text around the caret for an arrow, Delete or Backspace in a long value', (/** @type {import('node:test').TestContext} */ t) => {
    // The work, not the time: how much text each key hands the grapheme segmenter.
    const proto = /** @type {any} */ (Intl.Segmenter.prototype);
    const segment = proto.segment;
    /** @type {number[]} */
    const read = [];
    proto.segment = function (/** @type {string} */ input) {
      read.push(input.length);
      return segment.call(this, input);
    };
    t.after(() => void (proto.segment = segment));
    const text = 'ab '.repeat(333334);
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    render(() => <View><Edit ref={(/** @type {any} */ e) => (edit = e)} value={text} /></View>, doc);
    doc.present();
    edit.focus();
    doc.select(-1, 500000);
    read.length = 0;
    for (const key of ['ArrowRight', 'ArrowLeft', 'Delete', 'Backspace']) doc.key(key);
    assert.ok(read.length > 0 && Math.max(...read) <= 200, `the segmenter read ${JSON.stringify(read)} code units for four keys in a value of ${text.length}`);
    doc.close();
  });

  it('moves a multi-line Edit\'s caret up and down its drawn rows, keeping its x, and Shift extends', () => {
    // 5 wide a character: 40 wide, the rows wrap at 8; "abcdefg " / "hij " / "klmnopq " / "rs".
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    render(() => <View style={{ fontSize: 10, lineHeight: 2 }}><Edit ref={(/** @type {any} */ e) => (edit = e)} lines={4} value="abcdefg hij klmnopq rs" style={{ width: 40, padding: 0, border: 0 }} /></View>, doc);
    doc.present();
    edit.focus();
    doc.select(-1, 6);
    /** @type {number[]} */
    const down = [];
    for (let k = 0; k < 4; k++) {
      doc.key('ArrowDown');
      down.push(doc.caret);
    }
    // As Chrome (test/rows.test.jsx checks its recorded moves): the short row's end is the next row's start, shown at its end.
    assert.deepEqual(down, [12, 18, 22, 22], 'down: the short row takes its end, the next row the x it began at, the last row the end');
    /** @type {number[]} */
    const up = [];
    doc.select(-1, 17);
    for (let k = 0; k < 4; k++) {
      doc.key('ArrowUp');
      up.push(doc.caret);
    }
    assert.deepEqual(up, [12, 5, 0, 0], 'up, to the start past the first row');
    doc.select(-1, 2);
    doc.key('ArrowDown', true);
    assert.deepEqual([doc.anchor, doc.caret], [2, 10], 'Shift extends');
    doc.close();
    // Through the native entry: the renderer moves, and the textarea is set as drawn, wrapped.
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const attached = new Document({ ...mono, family: 'Drawn Face' }, { width: 300, height: 300 });
    render(() => <View style={{ fontSize: 10, lineHeight: 2 }}><Edit ref={(/** @type {any} */ e) => (edit = e)} lines={4} value="abcdefg hij klmnopq rs" style={{ width: 40, padding: 0, border: 0 }} /></View>, attached);
    const stop = attach(attached, canvas);
    edit.focus();
    attached.present();
    attached.select(-1, 6);
    const area = /** @type {any} */ (window.document.activeElement);
    const e = new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    area.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true, 'the renderer moves, not the textarea');
    assert.equal(attached.caret, 12);
    const style = area.getAttribute('style');
    assert.match(style, /white-space:pre-wrap/, 'the textarea wraps as the rows do');
    assert.match(style, /font-family:"Drawn Face"/, 'in the family the fonts draw');
    stop();
    attached.close();
    // Fonts that name no family: the generic one, a keyword, never quoted.
    const plain = new Document(mono, { width: 300, height: 300 });
    render(() => <View style={{ fontSize: 10, lineHeight: 2 }}><Edit ref={(/** @type {any} */ e) => (edit = e)} lines={4} value="abc" /></View>, plain);
    const detach = attach(plain, canvas);
    edit.focus();
    plain.present();
    const set = /** @type {any} */ (window.document.activeElement).getAttribute('style');
    assert.match(set, /box-sizing:border-box;font-family:sans-serif;white-space:pre-wrap/, 'the field\'s family: the generic one');
    assert.doesNotMatch(set, /"sans-serif"/, 'a keyword, never quoted');
    detach();
    plain.close();
  });

  it('keeps Home at the start of a value that begins with a line break', () => {
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    render(() => <View><Edit ref={(/** @type {any} */ e) => (edit = e)} lines={3} value={'\nabc'} /></View>, doc);
    doc.present();
    edit.focus();
    doc.select(-1, 0);
    doc.key('Home');
    assert.equal(doc.caret, 0, 'the first line is empty: Home stays at 0');
    doc.select(-1, 0);
    doc.key('Home', true);
    assert.deepEqual([doc.anchor, doc.caret], [0, 0]);
    doc.close();
  });

  it('rings a focused Edit with no background of its own outside its box, filling nothing', () => {
    const { doc, refs } = page(r => <Edit ref={e => (r.edit = e)} value="x" style={{ width: 100, background: 'transparent', border: 0, radius: 4 }} />);
    refs.edit.focus();
    doc.present();
    const drawn = doc.commands();
    assert.ok(!drawn.some(c => (c[0] === 'round' || c[0] === 'rround') && !String(c[5]).startsWith('#00')), 'no fill: the field\'s own color shows through, as on the DOM');
    const ring = drawn.find(c => c[0] === 'border');
    assert.ok(ring, 'a ring');
    assert.deepEqual([ring[1], ring[3] - ring[1], ring[6], ring[7]], [-2, 104, 6, 2], '2 wide, 2 outside the box, its radius grown by 2');
    doc.close();
  });

  it('puts the caret at the end when the view rewrites a focused value, as the DOM', () => {
    /** @type {any} */
    let v;
    const { doc, refs } = page(r => {
      v = $signal($active(), '');
      // A mask: digits, a dash after the third.
      const mask = (/** @type {string} */ s) => { const d = s.replace(/\D/g, ''); return d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d; };
      return <Edit ref={e => (r.edit = e)} value={v} onChange={e => $write(v, mask(e.value))} />;
    });
    refs.edit.focus();
    for (const key of '1234') doc.key(key);
    assert.equal(refs.edit.draft, '123-4');
    assert.equal(doc.caret, 5, 'after the added dash');
    // A keystroke the mask writes back as typed keeps the caret where the user put it.
    doc.key('ArrowLeft');
    doc.key('9');
    assert.equal(refs.edit.draft, '123-94');
    assert.equal(doc.caret, 5, 'right after the 9');
    doc.close();
  });

  it('leaves a collapsed caret when the view rewrites a native entry\'s input, as the DOM', () => {
    /** @type {any} */
    let v;
    const mask = (/** @type {string} */ s) => { const d = s.replace(/\D/g, ''); return d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d; };
    const { doc, refs } = page(r => {
      v = $signal($active(), '123-4');
      return <Edit ref={e => (r.a = e)} value={v} onChange={e => $write(v, mask(e.value))} />;
    });
    const { a } = refs;
    a.focus();
    // The entry inserted a 9 after "12": the mask moves the dash, the caret goes to the end.
    doc.input('1293-4', 3, 3);
    assert.equal(a.draft, '129-34');
    assert.deepEqual([a.selectionStart, a.selectionEnd], [6, 6], 'collapsed at the end, nothing selected');
    // The next keystroke inserts there, replacing nothing.
    doc.key('5');
    assert.equal(a.draft, '129-345');
    // A value the view keeps as entered keeps the entry's selection.
    doc.input('129-3457', 5, 8);
    assert.deepEqual([a.draft, a.selectionStart, a.selectionEnd], ['129-3457', 5, 8]);
    doc.close();
  });

  it('sets and reads an Edit\'s selection as an input\'s, focused or not', () => {
    const { doc, refs } = page(r => (
      <View>
        <Edit ref={e => (r.a = e)} value="hello world" />
        <Edit ref={e => (r.b = e)} value="second" />
      </View>
    ));
    const { a, b } = refs;
    assert.deepEqual([b.selectionStart, b.selectionEnd], [6, 6], 'an unfocused Edit: its end');
    a.focus();
    a.setSelectionRange(2, 5);
    assert.deepEqual([doc.anchor, doc.caret], [2, 5]);
    assert.deepEqual([a.selectionStart, a.selectionEnd, a.selectionDirection], [2, 5, 'forward']);
    a.setSelectionRange(1, 4, 'backward');
    assert.deepEqual([doc.anchor, doc.caret, a.selectionDirection], [4, 1, 'backward']);
    a.setSelectionRange(9, 3);
    assert.deepEqual([a.selectionStart, a.selectionEnd], [3, 3], 'an end before the start collapses at the end');
    a.setSelectionRange(-4, 99);
    assert.deepEqual([a.selectionStart, a.selectionEnd], [0, 11], 'clamped to the value');
    a.selectionStart = 6;
    assert.deepEqual([a.selectionStart, a.selectionEnd], [6, 11]);
    a.selectionEnd = 2;
    assert.deepEqual([a.selectionStart, a.selectionEnd], [2, 2]);
    // An unfocused Edit keeps it until it gets focus.
    b.setSelectionRange(1, 3);
    assert.deepEqual([b.selectionStart, b.selectionEnd], [1, 3]);
    b.focus();
    assert.deepEqual([doc.anchor, doc.caret], [1, 3]);
    doc.type('Z');
    assert.equal(b.draft, 'sZond');
    doc.close();
  });

  it('keeps a disabled Edit out of focus and edits, dimmed by the theme', () => {
    /** @type {any} */
    let off;
    const { doc, refs } = page(r => {
      off = $signal($active(), true);
      return (
        <View>
          <Edit ref={e => (r.a = e)} value="first" />
          <Edit ref={e => (r.b = e)} value="locked" disabled={off} />
          <Edit ref={e => (r.c = e)} value="last" />
        </View>
      );
    });
    const { a, b, c } = refs;
    assert.equal(b.r.bg, doc.theme.soft);
    assert.equal(b.r.fg, doc.theme.muted);
    assert.deepEqual(texts(doc).find(t => t[0] === 'locked'), ['locked', '#ff637460'], 'drawn in the muted color');
    b.focus();
    assert.equal(doc.focused, null, 'focus() does nothing');
    const box = b.getBoundingClientRect();
    doc.press(box.x + 20, box.y + 10);
    assert.equal(doc.focused, null, 'a press does not focus it');
    a.focus();
    doc.key('Tab');
    assert.equal(doc.focused, c, 'Tab skips it');
    // Enabled, focused, then disabled: it gives the focus up.
    $write(off, false);
    b.focus();
    assert.equal(doc.focused, b);
    $write(off, true);
    doc.present();
    assert.equal(doc.focused, null);
    doc.close();
  });

  it('lets a readOnly Edit take focus and selection but no edits', () => {
    /** @type {string[]} */
    const changes = [];
    const { doc, refs } = page(r => <Edit ref={e => (r.edit = e)} value="fixed" readOnly onChange={e => changes.push(e.value)} />);
    const { edit } = refs;
    edit.focus();
    assert.equal(doc.focused, edit);
    doc.key('x');
    doc.key('Backspace');
    doc.key('Delete');
    doc.type('typed');
    doc.compose('ime');
    assert.equal(edit.draft, 'fixed');
    assert.deepEqual(changes, []);
    doc.key('Home');
    doc.key('ArrowRight', true);
    doc.key('ArrowRight', true);
    assert.equal(doc.copied(), 'fi', 'it selects and copies');
    doc.input('fixedX', 6, 6);
    assert.equal(edit.draft, 'fixed', 'the native entry cannot change it either');
    doc.close();
  });

  it('draws a secret Edit as bullets, keeps its value, and never copies it', () => {
    /** @type {any} */
    let v;
    const { doc, refs } = page(r => {
      v = $signal($active(), 'pw');
      return <Edit ref={e => (r.edit = e)} value={v} secret onChange={e => $write(v, e.value)} />;
    });
    const { edit } = refs;
    assert.ok(texts(doc).some(t => t[0] === '••'));
    assert.ok(!texts(doc).some(t => t[0] === 'pw'), 'the value is never drawn');
    edit.focus();
    doc.type('d');
    assert.equal($read(v), 'pwd');
    assert.ok(texts(doc).some(t => t[0] === '•••'));
    doc.selectAll();
    assert.equal(doc.copied(), '', 'copy is refused');
    doc.close();
  });

  it('enters a secret in a password input and mirrors it as bullets', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {Record<string, any>} */
    const refs = {};
    render(() => (
      <View>
        <Edit ref={e => (refs.plain = e)} value="open" />
        <Edit ref={e => (refs.secret = e)} value="hidden" secret label="Password" />
        <Edit ref={e => (refs.fixed = e)} value="fixed" readOnly />
      </View>
    ), doc);
    const stop = attach(doc, /** @type {any} */ (canvas));
    refs.plain.focus();
    doc.present();
    assert.equal(window.document.activeElement.tagName, 'TEXTAREA');
    refs.secret.focus();
    doc.present();
    const active = window.document.activeElement;
    assert.equal(active.tagName, 'INPUT');
    assert.equal(active.type, 'password');
    assert.equal(active.value, 'hidden');
    refs.fixed.focus();
    doc.present();
    assert.equal(window.document.activeElement.tagName, 'TEXTAREA');
    assert.equal(window.document.activeElement.readOnly, true);
    const mirror = window.document.querySelector('[data-ren-aria]');
    assert.ok(mirror.textContent.includes('•'.repeat(6)));
    assert.ok(!mirror.textContent.includes('hidden'), 'assistive technology reads bullets');
    assert.ok(mirror.querySelector('[aria-readonly=true]') !== null);
    stop();
    doc.close();
  });

  it('keeps no typed secret in the hidden entry once focus leaves the Edit', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {Record<string, any>} */
    const refs = {};
    render(() => (
      <View>
        <Edit ref={e => (refs.plain = e)} value="open" />
        <Edit ref={e => (refs.secret = e)} secret label="Password" />
      </View>
    ), doc);
    const stop = attach(doc, /** @type {any} */ (canvas));
    /** The values the hidden entry controls hold. */
    const held = () => [...window.document.querySelectorAll('[data-ren-entry]')].map(el => /** @type {any} */ (el).value);
    const type = () => {
      refs.secret.focus();
      doc.present();
      const input = /** @type {any} */ (window.document.activeElement);
      assert.equal(input.type, 'password');
      input.value = 'hunter2';
      input.setSelectionRange(7, 7);
      input.dispatchEvent(new window.Event('input'));
      doc.present();
      assert.equal(input.value, 'hunter2');
    };
    type();
    refs.secret.blur();
    doc.present();
    assert.deepEqual(held().filter(v => v !== ''), [], 'blurred: no value held');
    type();
    refs.plain.focus();
    doc.present();
    assert.ok(!held().includes('hunter2'), 'moved to a plain Edit: the password input is cleared');
    stop();
    doc.close();
  });

  it('colors the placeholder by the portable style, inherited, else the theme', () => {
    const { doc } = page(() => (
      <View>
        <Edit label="plain" />
        <View style={{ placeholderColor: '#ff0000' }}>
          <Edit label="inherited" />
          <Edit label="own" style={{ placeholderColor: 0xff00ff00 }} />
        </View>
      </View>
    ));
    const colors = Object.fromEntries(texts(doc));
    assert.deepEqual(colors, { plain: '#ff637460', inherited: '#ffff0000', own: '#ff00ff00' });
    doc.close();
  });

  it('grows a multi-line Edit with its wrapped lines between its lines and autosize', () => {
    /** @type {any} */
    let v;
    /** @type {any} */
    let grow;
    const { doc, refs } = page(r => {
      v = $signal($active(), 'one');
      grow = $signal($active(), /** @type {boolean | number} */ (4));
      // 120 wide: 98 of content, 19 characters a row.
      return <Edit ref={e => (r.edit = e)} lines={2} autosize={grow} value={v} style={{ width: 120 }} />;
    });
    const { edit } = refs;
    const height = () => edit.getBoundingClientRect().height;
    // A field is 38 high, a line 20: rows past the first add 20 each.
    assert.equal(height(), 58, 'its lines at least');
    $write(v, 'one two three four five six seven eight nine');
    doc.present();
    assert.equal(height(), 78, 'three wrapped rows');
    $write(v, 'a\nb\nc\nd\ne\nf');
    doc.present();
    assert.equal(height(), 98, 'autosize rows at most');
    $write(grow, true);
    doc.present();
    assert.equal(height(), 138, 'no limit');
    edit.focus();
    doc.key('End');
    doc.key('Enter');
    assert.equal(height(), 158, 'typing a line grows it');
    $write(grow, false);
    doc.present();
    assert.equal(height(), 58, 'off: its lines');
    doc.close();
  });

  it('clamps a Label to its lines with an ellipsis, and ends one line with an ellipsis', () => {
    /** @type {any} */
    let lines;
    const { doc, refs } = page(r => {
      lines = $signal($active(), 2);
      return (
        <View style={{ width: 100 }}>
          <Label ref={e => (r.clamped = e)} text="one two three four five six seven eight nine ten" lines={lines} />
          <Label ref={e => (r.one = e)} text="a single line that is too long" ellipsis />
          <Label ref={e => (r.fits = e)} text="short" ellipsis />
        </View>
      );
    });
    const drawn = texts(doc).map(t => t[0]);
    // 20 characters a row at 100 wide; a space before the cut stays, as Chrome keeps it (test/rtl-oracle.test.jsx).
    assert.deepEqual(drawn, ['one two three four', 'five six seven eigh…', 'a single line that …', 'short'], 'two rows (the last kept ends with the ellipsis), then one line each (what fits stays whole)');
    assert.equal(refs.clamped.getBoundingClientRect().height, 40, 'as high as its lines');
    assert.ok(mono.width(drawn[2], 10) <= 100);
    assert.equal(refs.one.getBoundingClientRect().height, 20);
    $write(lines, 0);
    doc.present();
    assert.equal(refs.clamped.getBoundingClientRect().height, 20, 'unclamped: one line again');
    assert.equal(texts(doc)[0][0], 'one two three four five six seven eight nine ten');
    doc.close();
  });

  it('lets a Label with an ellipsis shrink below its text in a row', () => {
    const { doc, refs } = page(r => (
      <View style={{ direction: 'row', width: 100 }}>
        <Label ref={e => (r.cut = e)} text="a label much wider than its row" ellipsis />
        <Label text="tail" />
      </View>
    ));
    assert.equal(refs.cut.getBoundingClientRect().width, 80, 'the row minus the other Label');
    const drawn = texts(doc).map(t => t[0]);
    // 80 wide: 15 characters and the ellipsis.
    assert.equal(drawn[0], 'a label much wi…');
    doc.close();
  });
});
