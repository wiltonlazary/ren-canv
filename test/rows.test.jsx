// A multi-line Edit's rows and the keys that move over them, against
// Chrome's own, as recorded from a textarea of the same width, lines and
// font in headless Chrome (fixtures/rows.json, made by
// scripts/rows-oracle.mjs): where it wraps, and the selection and scroll
// after ArrowUp and ArrowDown, Home and End, their Shift variants, and
// Left and Right between them. The Edit measures each character and
// cluster at the width Chrome laid it out at, so the two wrap alike.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { View, Edit, Label, $active } from 'ren-core';
import { $signal, $write } from 'rrx-core';
import { Document, render, attach, loadLayout } from 'ren-canv';
import { Window } from 'happy-dom';
import { Lines } from '../src/text.js';

await loadLayout();

/**
 * @typedef {object} Run
 * @property {string} name
 * @property {[number, number]} from the anchor and caret it starts from
 * @property {{ key: string, shift: boolean, ctrl: boolean }[]} keys
 * @property {[number, number, number][]} after each key: the anchor, the caret, the scrollTop
 * @typedef {object} Case
 * @property {string} name
 * @property {string} text
 * @property {number} width
 * @property {number} lines
 * @property {number} size
 * @property {number} line
 * @property {number} ascent
 * @property {number} descent
 * @property {number[]} starts the rows' starts
 * @property {Record<string, number>} widths each cluster's and code point's
 * @property {Run[]} runs
 * @property {Record<string, number>} wordLeft where Ctrl+ArrowLeft takes the caret from each
 */
/**
 * @typedef {object} Heard an event the textarea heard, with its value and selection then
 * @property {string} type @property {string | null} inputType @property {string | null} data @property {boolean | null} composing
 * @property {string} value @property {number} start @property {number} end
 * @typedef {{ from: [number, number], events: Heard[] }} Native
 */
const oracle = /** @type {{ recorded: string, cases: Case[], shrink: { name: string, scrolled: number, shrunk: number, emptied: number }, native: { case: string, paste: Native, composition: Native } }} */ (JSON.parse(readFileSync(new URL('./fixtures/rows.json', import.meta.url), 'utf8')));

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Fonts that measure as Chrome laid the case out: each cluster at its width, a part of one by its code points. @param {Case} c */
function fonts(c) {
  /** @param {string} text @param {number} size */
  const width = (text, size) => {
    let w = 0;
    for (const { segment } of graphemes.segment(text)) {
      if (segment in c.widths) w += c.widths[segment];
      else for (const p of segment) w += c.widths[p] ?? 0;
    }
    return (w * size) / c.size;
  };
  return { width, metrics: (/** @type {number} */ size) => ({ ascent: (c.ascent * size) / c.size, descent: (c.descent * size) / c.size }), close() {} };
}

/** A focused multi-line Edit set as the case's field. @param {Case} c */
function field(c) {
  const doc = new Document(fonts(c), { width: 600, height: 600 });
  /** @type {any} */
  let edit = null;
  render(() => <View style={{ fontSize: c.size, lineHeight: c.line / c.size }}><Edit ref={(/** @type {any} */ e) => (edit = e)} value={c.text} lines={c.lines} style={{ width: c.width, height: c.lines * c.line, padding: 0, border: 0 }} /></View>, doc);
  doc.present();
  edit.focus();
  return { doc, edit };
}

/** The runs of the cases named. @param {string[]} names */
const runs = names => oracle.cases.flatMap(c => c.runs.filter(r => names.includes(r.name)).map(r => /** @type {[Case, Run]} */ ([c, r])));

/** One window for the runs played through a native entry (closed after the file). */
const window = new Window();
after(() => window.happyDOM.close());

/**
 * Plays a run's keys, each checked against Chrome's: on a Document with no
 * native entry, then through `attach` (the path Skia and three.js take),
 * each key sent to the textarea and followed by the selectionchange Chrome
 * sends for the selection the entry wrote.
 * @param {Case} c @param {Run} r
 */
function replay(c, r) {
  const keys = r.keys.map(k => `${k.shift ? 'Shift+' : ''}${k.key}`).join(' ');
  {
    const { doc, edit } = field(c);
    doc.select(r.from[0], r.from[1]);
    const seen = [];
    for (const k of r.keys) {
      doc.key(k.key, k.shift, { shiftKey: k.shift, ctrlKey: k.ctrl });
      seen.push([doc.anchor, doc.caret, edit.scrollTop]);
    }
    doc.close();
    assert.deepEqual(seen, r.after, `${c.name}: ${r.name} (${keys})`);
  }
  const canvas = window.document.createElement('canvas');
  window.document.body.appendChild(canvas);
  // The page's focus nowhere else (a run before left it on its canvas): the entry takes it.
  /** @type {any} */ (window.document.activeElement)?.blur?.();
  const { doc, edit } = field(c);
  const stop = attach(doc, canvas);
  edit.focus();
  doc.select(r.from[0], r.from[1]);
  doc.present();
  const area = /** @type {any} */ (window.document.activeElement);
  assert.equal(area.tagName, 'TEXTAREA', `${c.name}: ${r.name}: the native entry has the focus`);
  const seen = [];
  for (const k of r.keys) {
    area.dispatchEvent(new window.KeyboardEvent('keydown', { key: k.key, shiftKey: k.shift, ctrlKey: k.ctrl, bubbles: true, cancelable: true }));
    window.document.dispatchEvent(new window.Event('selectionchange'));
    seen.push([doc.anchor, doc.caret, edit.scrollTop]);
  }
  stop();
  doc.close();
  canvas.remove();
  assert.deepEqual(seen, r.after, `${c.name}: ${r.name} (${keys}), through the native entry`);
}

describe(`ren canv rows, as ${oracle.recorded} moves over a textarea's`, () => {
  it("gives an Edit's caret row and row count as Chrome wraps the textarea, the caret at a wrap on the next row", () => {
    for (const c of oracle.cases) {
      const { doc, edit } = field(c);
      /** The row Chrome's rows put an offset on: the last that starts at or before it. @param {number} at */
      const rowOf = at => c.starts.reduce((row, start, i) => (start <= at ? i : row), 0);
      for (let at = 0; at <= c.text.length; at++) {
        edit.setSelectionRange(at, at);
        assert.deepEqual(edit.caretRow(), { row: rowOf(at), rows: c.starts.length }, `${c.name}: the caret at ${at}`);
      }
      // End on a row that wraps puts the caret at its end: that row's.
      edit.setSelectionRange(0, 0);
      doc.key('End');
      if (c.starts.length > 1 && doc.caret === c.starts[1]) assert.equal(edit.caretRow().row, 0, `${c.name}: End keeps the caret on its row`);
      // Unfocused, it keeps the row of the selection it will take.
      edit.setSelectionRange(c.text.length, c.text.length);
      edit.blur();
      assert.equal(edit.caretRow().row, c.starts.length - 1, `${c.name}: unfocused`);
      doc.close();
    }
    const doc = new Document(fonts(oracle.cases[0]), { width: 600, height: 600 });
    /** @type {any} */
    let one = null;
    render(() => <Edit ref={(/** @type {any} */ e) => (one = e)} value="a long one-line value that never wraps" style={{ width: 40 }} />, doc);
    assert.deepEqual(one.caretRow(), { row: 0, rows: 1 }, 'a one-line Edit: row 0 of 1');
    doc.close();
  });

  it('lands ArrowUp and ArrowDown at a row\'s end as Chrome does: at the next row\'s start, shown at this row\'s end', () => {
    for (const [c, r] of runs(['down through short rows and a word broken mid-word', 'up from inside the broken word', 'Shift with down and up'])) replay(c, r);
  });

  it('takes Home and End to the drawn row\'s start and end, as Chrome does, with Shift too', () => {
    for (const [c, r] of runs(['Home and End by row, and with Shift', 'End at a mid-word break, then down and up'])) replay(c, r);
  });

  it('lands ArrowUp and ArrowDown at a cluster\'s edge, never inside a conjunct or a ZWJ family, as Chrome does', () => {
    for (const [c, r] of runs(['down onto a conjunct and a family', 'down and back up over clusters', 'Home and End over clusters'])) replay(c, r);
  });

  it('keeps the x of a vertical move in whole pixels, as Chrome does', () => {
    for (const [c, r] of runs(['End, then down from the row end'])) replay(c, r);
  });

  it('begins a vertical move\'s x again after a move across or typing, as Chrome does', () => {
    for (const [c, r] of runs(['the goal x reset by Left and Right back to the same caret', 'the goal x reset by typing', 'the goal x reset by Left and Right'])) replay(c, r);
  });

  it('scrolls a field with fewer lines than rows to show the caret\'s row, as Chrome does', () => {
    for (const [c, r] of runs(['down and up, scrolling', 'End, down, Home and up, scrolling'])) replay(c, r);
    // Typed past its lines: the caret and the rows drawn follow, inside the field.
    const c = /** @type {Case} */ (oracle.cases.find(k => k.name.startsWith('more rows')));
    const { doc, edit } = field(c);
    doc.select(-1, c.text.length);
    for (const k of ['Enter', 'a', 'Enter', 'b']) doc.key(k);
    doc.present();
    const caret = `#${(/** @type {any} */ (doc).theme.caret >>> 0).toString(16).padStart(8, '0')}`;
    const drawn = /** @type {number[]} */ (doc.commands().find(k => k[0] === 'rect' && k[5] === caret));
    assert.ok(drawn !== undefined, 'the caret is drawn');
    // Its line box, whose font box shows whole (as Chrome scrolls it), a pixel of it clipped at most.
    assert.ok(drawn[2] >= -1 && drawn[4] <= c.lines * c.line + 1, `the caret, rows ${drawn[2]} to ${drawn[4]}, in the field's ${c.lines * c.line}`);
    assert.ok(edit.scrollTop > 0, 'scrolled');
    doc.close();
  });

  it('keeps a platform word move not yet mirrored: Ctrl+ArrowLeft three times back to back, as Chrome ends them', async (/** @type {import('node:test').TestContext} */ t) => {
    void t;
    for (const [c, r] of runs(['three Ctrl+ArrowLeft back to back'])) {
      const canvas = window.document.createElement('canvas');
      window.document.body.appendChild(canvas);
      const { doc } = field(c);
      const stop = attach(doc, canvas);
      doc.select(r.from[0], r.from[1]);
      doc.present();
      const area = /** @type {any} */ (window.document.activeElement);
      assert.equal(area.tagName, 'TEXTAREA');
      // happy-dom tells a select event at once where Chrome tells selectionchange later: held back here.
      let platform = false;
      window.addEventListener('select', (/** @type {any} */ e) => void (platform && e.stopPropagation()), true);
      for (const k of r.keys) {
        const e = new window.KeyboardEvent('keydown', { key: k.key, ctrlKey: k.ctrl, shiftKey: k.shift, bubbles: true, cancelable: true });
        area.dispatchEvent(e);
        assert.equal(e.defaultPrevented, false, 'the word move is the textarea\'s');
        // The platform moves the textarea's caret a word, as Chrome does from there; its selectionchange comes later.
        const at = c.wordLeft[area.selectionStart];
        platform = true;
        area.setSelectionRange(at, at);
        platform = false;
      }
      window.document.dispatchEvent(new window.Event('selectionchange'));
      const [anchor, caret] = r.after[r.after.length - 1];
      assert.deepEqual([doc.anchor, doc.caret], [anchor, caret], `${c.name}: ${r.name}`);
      stop();
      doc.close();
      canvas.remove();
    }
  });

  it('keeps a selection\'s end at the end of a row after Shift+End, and Shift+Down from a row\'s start, as Chrome does', () => {
    for (const [c, r] of runs(['Shift+End twice', 'Shift+Down through soft wraps', 'End, then Shift+Down', 'down to a wrap, Shift+Right, down', 'End twice, Home twice'])) replay(c, r);
  });

  it('keeps a caret on spaces hanging past the field at the field\'s edge, for its x and as drawn, as Chrome does', () => {
    for (const [c, r] of runs(['End on the hanging spaces, then down and up', 'down and up across the hanging spaces', 'End at the full row, then down', 'down from the leading space', 'End and down from the second row'])) replay(c, r);
    // Drawn inside the field: the caret at the end of the hanging spaces.
    const c = /** @type {Case} */ (oracle.cases.find(k => k.name === 'spaces hanging past the field at a wrap'));
    const { doc } = field(c);
    doc.key('Home');
    doc.key('End');
    doc.present();
    const color = `#${(/** @type {any} */ (doc).theme.caret >>> 0).toString(16).padStart(8, '0')}`;
    const caret = /** @type {number[]} */ (doc.commands().find(k => k[0] === 'rect' && k[5] === color));
    assert.ok(caret[3] <= c.width, `the caret, ${caret[1]} to ${caret[3]}, inside the field's ${c.width}`);
    doc.close();
  });

  it('scrolls a field shortened while it has no focus back to its rows, as Chrome does', () => {
    const c = /** @type {Case} */ (oracle.cases.find(k => k.name === oracle.shrink.name));
    const doc = new Document(fonts(c), { width: 600, height: 600 });
    /** @type {any} */
    let edit = null;
    /** @type {any} */
    let value = null;
    render(() => {
      value = $signal($active(), c.text);
      return <View style={{ fontSize: c.size, lineHeight: c.line / c.size }}><Edit ref={(/** @type {any} */ e) => (edit = e)} value={value} label="Type here" lines={c.lines} style={{ width: c.width, height: c.lines * c.line, padding: 0, border: 0 }} /></View>;
    }, doc);
    doc.present();
    edit.focus();
    doc.select(-1, 0);
    for (let k = 0; k < 12; k++) doc.key('ArrowDown');
    assert.equal(edit.scrollTop, oracle.shrink.scrolled, 'scrolled to its end');
    doc.focus(null);
    $write(value, 'x');
    doc.present();
    assert.equal(edit.scrollTop, oracle.shrink.shrunk, 'shortened');
    $write(value, '');
    doc.present();
    assert.equal(edit.scrollTop, oracle.shrink.emptied, 'emptied');
    const label = /** @type {any[]} */ (doc.commands().find(k => k[0] === 'text' && k[1] === 'Type here'));
    assert.ok(label !== undefined && label[3] >= 0 && label[3] <= c.lines * c.line, `its placeholder drawn in the field: ${JSON.stringify(label)}`);
    doc.close();
  });

  it('wraps a Label\'s rows where Chrome wraps pre-wrap text, keeping its spaces, and copies a row as it is in the text', () => {
    for (const c of oracle.cases) {
      const doc = new Document(fonts(c), { width: 600, height: 600 });
      /** @type {any} */
      let label = null;
      render(() => <View style={{ fontSize: c.size, lineHeight: c.line / c.size }}><Label ref={(/** @type {any} */ n) => (label = n)} text={c.text} style={{ wrap: true, width: c.width }} /></View>, doc);
      doc.present();
      assert.deepEqual(label.starts, c.starts, `${c.name}: where the rows start`);
      const last = c.starts.length - 1;
      doc.selectText(label, c.starts[last], label, c.text.length);
      assert.equal(doc.copied(), c.text.slice(c.starts[last]), `${c.name}: the last row copied`);
      doc.close();
    }
    // An Edit over the same spaces, as Chrome moves over them.
    for (const [c, r] of runs(['down through repeated spaces'])) replay(c, r);
  });

  it('takes a paste and an IME composition through the native entry, as Chrome\'s textarea hears them', () => {
    const c = /** @type {Case} */ (oracle.cases.find(k => k.name === oracle.native.case));
    for (const [name, native] of /** @type {[string, Native][]} */ ([['a paste', oracle.native.paste], ['a composition', oracle.native.composition]])) {
      const canvas = window.document.createElement('canvas');
      window.document.body.appendChild(canvas);
      /** @type {any} */ (window.document.activeElement)?.blur?.();
      const { doc, edit } = field(c);
      const stop = attach(doc, canvas);
      edit.focus();
      doc.select(native.from[0], native.from[1]);
      doc.present();
      const area = /** @type {any} */ (window.document.activeElement);
      assert.equal(area.tagName, 'TEXTAREA');
      // The platform's own edits, as Chrome made them: each event with the value and selection the textarea had then
      // (happy-dom's select event, which Chrome sends later as selectionchange, held back).
      let platform = false;
      const hold = (/** @type {any} */ e) => void (platform && e.stopPropagation());
      window.addEventListener('select', hold, true);
      for (const e of native.events) {
        platform = true;
        if (area.value !== e.value) area.value = e.value;
        area.setSelectionRange(e.start, e.end);
        platform = false;
        const init = { bubbles: true, cancelable: e.type !== 'input', data: e.data ?? undefined, inputType: e.inputType ?? undefined, isComposing: e.composing ?? undefined };
        const event =
          e.type === 'keydown' ? new window.KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
          : e.type.startsWith('composition') ? new window.CompositionEvent(e.type, init)
          : e.type === 'paste' ? new window.Event('paste', { bubbles: true, cancelable: true })
          : new window.InputEvent(e.type, init);
        // happy-dom's CompositionEvent keeps no data of its own.
        if (e.type.startsWith('composition')) Object.defineProperty(event, 'data', { value: e.data });
        area.dispatchEvent(event);
        if (e.type === 'input') assert.equal(/** @type {any} */ (doc.current).draft, e.value, `${name}: the draft after ${e.inputType}`);
      }
      window.removeEventListener('select', hold, true);
      window.document.dispatchEvent(new window.Event('selectionchange'));
      const last = native.events[native.events.length - 1];
      assert.deepEqual([/** @type {any} */ (doc.current).draft, doc.anchor, doc.caret], [last.value, last.start, last.end], `${name}: where Chrome leaves it`);
      assert.equal(doc.composing, false, `${name}: no composition left open`);
      stop();
      doc.close();
      canvas.remove();
    }
  });

  it('wraps the rows where Chrome wraps them: spaces hang at a row\'s end, a word breaks between clusters', () => {
    for (const c of oracle.cases) {
      const measure = fonts(c);
      const rows = Lines({ width: (/** @type {string} */ text) => measure.width(text, c.size) }, c.text, c.width);
      assert.deepEqual(rows.map(row => row.start), c.starts, c.name);
    }
  });
});
