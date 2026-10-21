// Text actions, as an application's own menus use them: an Edit's (ren-core's
// editOf: its value and selection, kept while it has no focus, `replace` as
// the user's edit, and its undo history, which Ctrl or Cmd+Z and the native
// entry's undo walk too), the root's (textAt over static text, selectText
// opening selection on one text, selectedText), the pointer's type, and the
// root-wide presses ($presses). Text at fontSize 10 is 5 wide per character,
// 20 high per line.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyWindow } from 'happy-dom';
import { $signal, $read, $write } from 'rrx-core';
import { View, Label, Edit, Action, Portal, $active, $presses, editOf, textAt, selectText, selectedText } from 'ren-core';
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

await loadLayout();

const mono = {
  width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2,
  metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
  close() {},
};

/** A Document of 300 × 300 with `view`, and a ref for each item a test names. @param {(refs: Record<string, any>) => any} view @param {import('ren-canv').Options} [options] */
function page(view, options) {
  const doc = new Document(mono, { width: 300, height: 300, ...options });
  /** @type {Record<string, any>} */
  const refs = {};
  render(() => <View style={{ fontSize: 10, lineHeight: 2 }}>{view(refs)}</View>, doc);
  doc.present();
  return { doc, refs };
}

/** The middle of an item's box. @param {any} item @returns {[number, number]} */
const middle = item => {
  const r = item.getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
};

/** Types each character as a key. @param {Document} doc @param {string} text */
const typed = (doc, text) => {
  for (const c of text) doc.key(c);
};

/** What textAt found, its node told as `node` or not (an item's own inspection is too large for an assertion's message). @param {any} hit @param {any} node */
const told = (hit, node) => (hit === null ? null : { node: hit.node === node, text: hit.text, pressed: hit.pressed });

const UNDO = { ctrlKey: true };
const REDO = { ctrlKey: true, shiftKey: true };

describe('ren canv text actions', () => {
  it("undoes and redoes an Edit's typing with Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y, a word a step, restoring the caret", () => {
    /** @type {string[]} */
    const heard = [];
    const { doc, refs } = page(r => <Edit ref={e => (r.edit = e)} onChange={(/** @type {any} */ e) => heard.push(e.value)} />);
    refs.edit.focus();
    typed(doc, 'ab cd');
    assert.equal(refs.edit.draft, 'ab cd');
    assert.equal(doc.key('z', false, UNDO), true, 'the renderer takes the undo (the native entry undoes nothing)');
    assert.equal(refs.edit.draft, 'ab ', 'the last word goes as one step');
    assert.equal(doc.caret, 3);
    doc.key('z', false, UNDO);
    assert.equal(refs.edit.draft, '');
    assert.equal(doc.key('z', false, UNDO), true);
    assert.equal(refs.edit.draft, '', 'nothing more to undo');
    doc.key('Z', true, REDO);
    assert.equal(refs.edit.draft, 'ab ');
    doc.key('y', false, UNDO);
    assert.equal(refs.edit.draft, 'ab cd');
    assert.equal(doc.caret, 5);
    assert.deepEqual(heard.slice(-4), ['ab ', '', 'ab ', 'ab cd'], 'each step is a change');
    doc.close();
  });

  it('keeps deletions as their own steps, and starts a step where the caret jumped', () => {
    const { doc, refs } = page(r => <Edit ref={e => (r.edit = e)} value="hello" />);
    refs.edit.focus();
    doc.key('Backspace');
    doc.key('Backspace');
    typed(doc, 'p');
    assert.equal(refs.edit.draft, 'help');
    doc.select(-1, 0);
    typed(doc, 'X');
    assert.equal(refs.edit.draft, 'Xhelp');
    doc.key('z', false, UNDO);
    assert.equal(refs.edit.draft, 'help', 'the typing after the jump is a step');
    assert.equal(doc.caret, 0);
    doc.key('z', false, UNDO);
    assert.equal(refs.edit.draft, 'hel', 'the typing after the deletions is a step');
    doc.key('z', false, UNDO);
    assert.equal(refs.edit.draft, 'hello', 'the deletions are one');
    assert.equal(doc.caret, 5);
    // An edit after an undo drops the steps it undid.
    typed(doc, '!');
    assert.equal(editOf(refs.edit)?.canRedo(), false);
    doc.close();
  });

  it("gives an Edit's actions on its ref: value, selection, replace as the user's edit, select all and the history", () => {
    /** @type {string[]} */
    const heard = [];
    const { doc, refs } = page(r => (
      <View>
        <Edit ref={e => (r.edit = e)} value="one two" onChange={(/** @type {any} */ e) => heard.push(e.value)} />
        <Edit ref={e => (r.other = e)} />
      </View>
    ));
    const actions = /** @type {import('ren-core').EditActions} */ (editOf(refs.edit));
    assert.ok(actions !== null);
    assert.equal(editOf(refs.other) === actions, false);
    assert.equal(/** @type {any} */ (doc.root)[Symbol.for('ren.edit')], undefined, 'only an Edit has them');
    assert.equal(actions.value(), 'one two');
    assert.deepEqual([actions.canUndo(), actions.canRedo(), actions.undo()], [false, false, false]);
    // Unfocused: replace the selection set from code.
    actions.setSelection(4, 7);
    assert.deepEqual(actions.selection(), { start: 4, end: 7, direction: 'forward' });
    actions.replace('three\nfour');
    assert.equal(actions.value(), 'one threefour', 'a one-line Edit drops the line break');
    assert.deepEqual(heard, ['one threefour']);
    assert.deepEqual(actions.selection(), { start: 13, end: 13, direction: 'forward' }, 'the caret follows the text');
    assert.equal(doc.current, null, 'replace focuses nothing');
    assert.equal(actions.canUndo(), true);
    assert.equal(actions.undo(), true);
    assert.equal(actions.value(), 'one two');
    assert.deepEqual(actions.selection(), { start: 4, end: 7, direction: 'forward' }, 'undo selects what it put back');
    assert.equal(actions.canRedo(), true);
    assert.equal(actions.redo(), true);
    assert.equal(actions.value(), 'one threefour');
    assert.deepEqual(heard, ['one threefour', 'one two', 'one threefour']);
    // Focused: select all, then replace.
    actions.focus();
    assert.equal(doc.current, refs.edit);
    actions.selectAll();
    assert.deepEqual([doc.anchor, doc.caret], [0, 13]);
    actions.replace('x');
    assert.equal(actions.value(), 'x');
    assert.equal(doc.caret, 1);
    assert.deepEqual([actions.secret(), actions.readOnly(), actions.disabled()], [false, false, false]);
    doc.close();
  });

  it('takes no replace, undo or redo in a read-only Edit', () => {
    let changes = 0;
    const { doc, refs } = page(r => <Edit ref={e => (r.edit = e)} value="fixed" readOnly onChange={() => changes++} />);
    const actions = /** @type {import('ren-core').EditActions} */ (editOf(refs.edit));
    actions.replace('x');
    assert.equal(actions.value(), 'fixed');
    assert.deepEqual([actions.undo(), actions.readOnly(), changes], [false, true, 0]);
    doc.close();
  });

  it("drops a typed text's line breaks in a one-line Edit", () => {
    const { doc, refs } = page(r => <Edit ref={e => (r.edit = e)} />);
    refs.edit.focus();
    doc.type('a\r\nb');
    assert.equal(refs.edit.draft, 'ab');
    doc.close();
  });

  it("replaces under a controlled Edit's rule, and a value the view sets forgets the history", () => {
    /** @type {any} */
    let v;
    const { doc, refs } = page(r => {
      v = $signal($active(), 'ab');
      return <Edit ref={e => (r.edit = e)} value={v} onChange={(/** @type {any} */ e) => { if (/^[a-z]*$/.test(e.value)) $write(v, e.value); }} />;
    });
    const actions = /** @type {import('ren-core').EditActions} */ (editOf(refs.edit));
    actions.replace('c');
    assert.equal($read(v), 'abc', 'the view takes it');
    assert.equal(actions.canUndo(), true, 'a value written back as it was edited keeps the history');
    actions.replace('X');
    assert.equal(actions.value(), 'abc', 'the view rejects it: its bound value shows again');
    assert.equal(actions.canUndo(), false, 'and the history goes with the edit it held');
    refs.edit.focus();
    typed(doc, 'd');
    assert.equal(actions.canUndo(), true);
    $write(v, 'new');
    doc.present();
    assert.equal(actions.value(), 'new');
    assert.equal(actions.canUndo(), false, 'a value set from outside clears it');
    assert.equal(doc.key('z', false, UNDO), true);
    assert.equal(actions.value(), 'new');
    doc.close();
  });

  it("keeps an Edit's selection while it has no focus, and takes it again with the focus", () => {
    const { doc, refs } = page(r => (
      <View>
        <Edit ref={e => (r.a = e)} value="alpha beta" />
        <Edit ref={e => (r.b = e)} value="gamma" />
      </View>
    ));
    refs.a.focus();
    doc.select(2, 6);
    refs.b.focus();
    assert.deepEqual([refs.a.selectionStart, refs.a.selectionEnd, refs.a.selectionDirection], [2, 6, 'forward']);
    assert.deepEqual(editOf(refs.a)?.selection(), { start: 2, end: 6, direction: 'forward' });
    refs.a.focus();
    assert.deepEqual([doc.anchor, doc.caret], [2, 6]);
    // Backward, through a blur.
    doc.select(6, 1);
    refs.a.blur();
    assert.deepEqual(editOf(refs.a)?.selection(), { start: 1, end: 6, direction: 'backward' });
    refs.a.focus();
    assert.deepEqual([doc.anchor, doc.caret], [6, 1]);
    doc.close();
  });

  it("routes the native entry's undo and redo (beforeinput) and its Ctrl+Z to the Edit's history", () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    render(() => <View><Edit ref={(/** @type {any} */ e) => (edit = e)} value="" /></View>, doc);
    const stop = attach(doc, canvas);
    edit.focus();
    doc.present();
    const area = /** @type {any} */ (window.document.activeElement);
    assert.equal(area.tagName, 'TEXTAREA');
    typed(doc, 'hi');
    const before = (/** @type {string} */ inputType) => {
      const e = new window.InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
      area.dispatchEvent(e);
      return e.defaultPrevented;
    };
    assert.equal(before('historyUndo'), true, 'the textarea undoes nothing of its own');
    assert.equal(edit.draft, '');
    assert.equal(area.value, '', 'and shows the value undone');
    assert.equal(before('historyRedo'), true);
    assert.equal(edit.draft, 'hi');
    const key = new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    area.dispatchEvent(key);
    assert.equal(key.defaultPrevented, true);
    assert.equal(edit.draft, '');
    // A paste through the native entry is a step of its own.
    area.value = 'pasted';
    area.setSelectionRange(6, 6);
    area.dispatchEvent(new window.InputEvent('input', { inputType: 'insertFromPaste', bubbles: true }));
    assert.equal(edit.draft, 'pasted');
    typed(doc, 'x');
    doc.key('z', false, UNDO);
    assert.equal(edit.draft, 'pasted');
    doc.key('z', false, UNDO);
    assert.equal(edit.draft, '');
    stop();
    doc.close();
  });

  it('keeps the native entry focused on a right press, for the app\'s own menu', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = new Document(mono, { width: 300, height: 300 });
    /** @type {any} */
    let edit = null;
    render(() => <View><Edit ref={(/** @type {any} */ e) => (edit = e)} value="text" /></View>, doc);
    const stop = attach(doc, canvas);
    edit.focus();
    doc.present();
    const down = (/** @type {number} */ button) => {
      const e = new window.MouseEvent('mousedown', { button, bubbles: true, cancelable: true });
      canvas.dispatchEvent(e);
      return e.defaultPrevented;
    };
    assert.equal(down(2), true, 'a right press does not move the focus to the canvas');
    assert.equal(down(0), false, 'a main press is the press handler\'s');
    edit.blur();
    doc.present();
    assert.equal(down(2), false, 'with no field focused it is the browser\'s');
    stop();
    doc.close();
  });

  it("finds the text under a pointer event, pressed in an Action (its own too) or a press target, and none over an Edit or nothing", () => {
    /** @type {any[]} */
    const found = [];
    const { doc, refs } = page(r => (
      <View onPointerDown={(/** @type {any} */ e) => found.push(textAt(e))} style={{ height: 300 }}>
        <Label ref={e => (r.label = e)} text="static text" />
        <Edit ref={e => (r.edit = e)} value="field" />
        <Action ref={e => (r.action = e)} text="Go" onPress={() => {}} />
        <Action onPress={() => {}}><Label ref={e => (r.pay = e)} text="Pay" /></Action>
        <View onPress={() => {}}><Label ref={e => (r.amount = e)} text="12.50" /></View>
      </View>
    ));
    doc.secondary(...middle(refs.label), { button: 2 });
    assert.deepEqual(told(found.pop(), refs.label), { node: true, text: 'static text', pressed: false }, 'loose text an app does not select is found too');
    doc.secondary(...middle(refs.edit), { button: 2 });
    assert.equal(found.pop(), null);
    doc.secondary(...middle(refs.action), { button: 2 });
    assert.deepEqual(told(found.pop(), refs.action), { node: true, text: 'Go', pressed: true }, "an Action's own text");
    doc.secondary(...middle(refs.pay), { button: 2 });
    assert.deepEqual(told(found.pop(), refs.pay), { node: true, text: 'Pay', pressed: true }, "an Action's label");
    doc.secondary(...middle(refs.amount), { button: 2 });
    assert.deepEqual(told(found.pop(), refs.amount), { node: true, text: '12.50', pressed: true }, "a pressable View's label");
    doc.secondary(200, 280, { button: 2 });
    assert.equal(found.pop(), null);
    // Anonymous text in a View is its run's.
    const run = page(r => <View ref={e => (r.box = e)} onPointerDown={(/** @type {any} */ e) => found.push(textAt(e))}>Count: {3}</View>);
    run.doc.secondary(5, 10, { button: 2 });
    const hit = found.pop();
    assert.equal(hit?.text, 'Count: 3');
    assert.equal(hit?.node.getRootNode(), run.doc);
    run.doc.close();
    doc.close();
  });

  it('opens selection on one text: all of it, a drag within it, until a press outside, Escape or its release', () => {
    const { doc, refs } = page(r => (
      <View>
        <Label ref={e => (r.label = e)} text="hello world" />
        <Label ref={e => (r.other = e)} text="other line" />
      </View>
    ));
    // The app's behavior: loose text does not select.
    doc.press(12, 10);
    doc.move(40, 10);
    doc.release(40, 10);
    assert.equal(selectedText(refs.label), '');
    let release = /** @type {() => void} */ (selectText(refs.label));
    assert.equal(selectedText(refs.label), 'hello world', 'all of it is selected');
    assert.equal(doc.cursorAt(null, 12, 10), 'text', 'with the I-beam over it');
    // A drag inside keeps a part, and stays in it past its end.
    doc.press(12, 10);
    doc.move(27, 10);
    assert.equal(selectedText(refs.label), 'llo');
    doc.move(150, 30);
    doc.release(150, 30);
    assert.equal(selectedText(refs.label), 'llo world', 'the selection stays in the text');
    assert.equal(doc.selected.includes(refs.other), false);
    // A right press inside keeps it (the app's menu copies it).
    doc.secondary(12, 10, { button: 2 });
    assert.equal(selectedText(refs.label), 'llo world');
    // A press outside ends it: the text selects no more.
    doc.press(5, 30);
    assert.equal(selectedText(refs.label), '');
    doc.press(12, 10);
    doc.move(40, 10);
    doc.release(40, 10);
    assert.equal(selectedText(refs.label), '');
    // Escape ends it.
    release = /** @type {() => void} */ (selectText(refs.label));
    assert.equal(selectedText(refs.label), 'hello world');
    doc.key('Escape');
    assert.equal(selectedText(refs.label), '');
    // And its release; an earlier release ends nothing later.
    selectText(refs.label);
    release();
    assert.equal(selectedText(refs.label), 'hello world', "a spent release leaves a newer opening");
    /** @type {() => void} */ (selectText(refs.other))();
    assert.equal(selectedText(refs.label), '');
    assert.equal(doc.opted, null);
    doc.close();
  });

  it('selects in an opened text an Action holds, pressing, focusing and clicking nothing until it ends', () => {
    let presses = 0;
    /** @type {any} */
    let hit = null;
    const { doc, refs } = page(r => (
      <View onPointerDown={(/** @type {any} */ e) => (hit = textAt(e))}>
        <Action ref={e => (r.action = e)} onPress={() => presses++} style={{ align: 'start' }}>
          <Label ref={e => (r.label = e)} text="hello world" />
        </Action>
        <Label ref={e => (r.other = e)} text="other line" />
      </View>
    ));
    const box = refs.label.getBoundingClientRect();
    const x = box.x;
    const y = box.y + box.height / 2;
    doc.secondary(x + 12, y, { button: 2 });
    assert.equal(hit?.pressed, true);
    let release = /** @type {() => void} */ (selectText(hit.node));
    assert.equal(selectedText(refs.label), 'hello world');
    // A press and a drag inside select a part, and press nothing.
    doc.press(x + 12, y);
    assert.equal(doc.pressed === null, true, 'the Action is not pressed');
    assert.equal(refs.action.state & 2, 0, 'nor in its press state');
    assert.equal(doc.current === null, true, 'nor focused');
    doc.move(x + 27, y);
    doc.release(x + 27, y);
    assert.equal(selectedText(refs.label), 'llo');
    assert.equal(presses, 0, 'nor clicked');
    // A right press inside keeps it.
    doc.secondary(x + 12, y, { button: 2 });
    assert.equal(selectedText(refs.label), 'llo');
    // Escape ends it, and the Action presses again.
    doc.key('Escape');
    assert.equal(selectedText(refs.label), '');
    doc.press(x + 12, y);
    doc.release(x + 12, y);
    assert.deepEqual([presses, doc.current === refs.action], [1, true]);
    // So after its release, and after a press outside.
    release = /** @type {() => void} */ (selectText(refs.label));
    release();
    doc.press(x + 12, y);
    doc.release(x + 12, y);
    assert.equal(presses, 2);
    selectText(refs.label);
    doc.press(...middle(refs.other));
    doc.release(...middle(refs.other));
    assert.equal(doc.opted === null, true);
    doc.press(x + 12, y);
    doc.release(x + 12, y);
    assert.equal(presses, 3);
    doc.close();
  });

  it("selects in an Action's own text once opened, pressing, focusing and clicking nothing until it ends", () => {
    let presses = 0;
    /** @type {any} */
    let hit = null;
    const { doc, refs } = page(r => (
      <View onPointerDown={(/** @type {any} */ e) => (hit = textAt(e))}>
        <Action ref={e => (r.action = e)} text="hello world" onPress={() => presses++} style={{ align: 'start' }} />
      </View>
    ));
    const box = refs.action.getBoundingClientRect();
    const y = box.y + box.height / 2;
    // Where its text starts: its content box's left (aligned to the start).
    const texts = doc.painter.texts;
    let x = -1;
    for (let i = 0; i < texts.n; i++) if (texts.items[i] === refs.action) x = texts.box[i * 6 + 4];
    assert.ok(x >= box.x, 'its text is a text the pointer reaches');
    doc.secondary(x + 12, y, { button: 2 });
    assert.equal(hit?.node === refs.action && hit.pressed, true);
    let release = /** @type {() => void} */ (selectText(refs.action));
    assert.equal(selectedText(refs.action), 'hello world', 'all of it is selected');
    assert.equal(doc.selectAll(), true);
    assert.equal(doc.copied(), 'hello world');
    assert.equal(doc.cursorAt(refs.action, x + 12, y), 'text', 'with the I-beam over it');
    doc.press(x + 12, y);
    assert.equal(doc.pressed === null && doc.current === null && (refs.action.state & 2) === 0, true, 'the Action is not pressed or focused');
    doc.move(x + 27, y);
    doc.release(x + 27, y);
    assert.equal(selectedText(refs.action), 'llo');
    assert.equal(presses, 0, 'nor clicked');
    // It paints the selection behind its text.
    const shown = doc.commands().some((/** @type {any[]} */ c) => c[0] === 'rect' && c[1] === x + 10 && c[3] === x + 25);
    assert.equal(shown, true, 'the part selected is painted');
    doc.secondary(x + 12, y, { button: 2 });
    assert.equal(selectedText(refs.action), 'llo', 'a right press inside keeps it');
    doc.key('Escape');
    assert.equal(selectedText(refs.action), '');
    doc.press(x + 12, y);
    doc.release(x + 12, y);
    assert.deepEqual([presses, doc.current === refs.action], [1, true], 'after Escape it presses again');
    // Its release ends it too.
    release = /** @type {() => void} */ (selectText(refs.action));
    release();
    doc.press(x + 12, y);
    doc.release(x + 12, y);
    assert.equal(presses, 2);
    doc.close();
  });

  it('selects in an opened text a pressable View holds, without its press', () => {
    let presses = 0;
    const { doc, refs } = page(r => (
      <View ref={e => (r.row = e)} onPress={() => presses++} tabIndex={0}>
        <Label ref={e => (r.amount = e)} text="1234.50" />
      </View>
    ));
    const box = refs.amount.getBoundingClientRect();
    const y = box.y + box.height / 2;
    selectText(refs.amount);
    doc.press(box.x + 2, y);
    doc.move(box.x + 22, y);
    doc.release(box.x + 22, y);
    assert.equal(selectedText(refs.amount), '1234');
    assert.deepEqual([presses, doc.current === null, doc.pressed === null], [0, true, true]);
    doc.key('Escape');
    doc.press(box.x + 2, y);
    assert.deepEqual([presses, doc.current === refs.row], [1, true]);
    doc.close();
  });

  it("selects all of the open text with Ctrl+A, and gives a focused Edit's selection (none of a secret's) as the selected text", () => {
    const { doc, refs } = page(r => (
      <View>
        <Label ref={e => (r.label = e)} text="hello world" />
        <Edit ref={e => (r.edit = e)} value="field" />
        <Edit ref={e => (r.secret = e)} value="hidden" secret />
      </View>
    ));
    const release = /** @type {() => void} */ (selectText(refs.label));
    doc.press(12, 10);
    doc.move(27, 10);
    doc.release(27, 10);
    assert.equal(doc.selectAll(), true);
    assert.equal(selectedText(refs.label), 'hello world');
    release();
    refs.edit.focus();
    doc.select(1, 3);
    assert.equal(selectedText(refs.label), 'ie');
    // Opening selection on a text takes the focus from the Edit.
    selectText(refs.label);
    assert.equal(doc.current, null);
    assert.equal(selectedText(refs.edit), 'hello world');
    refs.secret.focus();
    doc.selectAll();
    assert.equal(selectedText(refs.label), '');
    doc.close();
  });

  it("tells a pointer event's type: the platform's, a mouse's without one", () => {
    /** @type {string[]} */
    const types = [];
    const { doc } = page(() => <View style={{ height: 100 }} onPointerDown={(/** @type {any} */ e) => types.push(e.pointerType)} />);
    doc.press(10, 10);
    doc.press(10, 10, 1, false, { pointerType: 'touch' });
    doc.secondary(10, 10, { button: 2, pointerType: 'pen' });
    assert.deepEqual(types, ['mouse', 'touch', 'pen']);
    doc.close();
  });

  it('hears every press in the root with $presses, the overlay\'s and a right press\'s too, after the items', () => {
    /** @type {string[]} */
    const heard = [];
    /** @type {any} */
    let stop = false;
    const { doc, refs } = page(r => {
      $presses((/** @type {any} */ e) => {
        const text = textAt(e);
        heard.push(`presses ${e.button} ${e.pointerType} ${e.target === doc.root ? 'page' : e.target.kind} ${text?.text ?? '-'}`);
        if (e.target === r.edit) e.preventDefault();
      });
      return (
        <View onPointerDown={(/** @type {any} */ e) => { heard.push('view'); if (stop) e.stopPropagation(); }}>
          <Label ref={e => (r.label = e)} text="words" />
          <Edit ref={e => (r.edit = e)} value="field" />
          <Portal><Label ref={e => (r.popup = e)} text="popup" style={{ position: 'absolute', left: 200, top: 200 }} /></Portal>
        </View>
      );
    });
    doc.press(...middle(refs.label));
    doc.secondary(...middle(refs.label), { button: 2, pointerType: 'touch' });
    doc.press(...middle(refs.popup));
    doc.press(290, 290);
    assert.deepEqual(heard, ['view', 'presses 0 mouse 3 words', 'view', 'presses 2 touch 3 words', 'presses 0 mouse 3 popup', 'presses 0 mouse page -']);
    // Its preventDefault keeps the press's own action, as an item handler's.
    heard.length = 0;
    doc.press(...middle(refs.edit));
    assert.equal(doc.current, null, 'the prevented press focuses nothing');
    // An item's stopPropagation keeps it from the root's.
    stop = true;
    heard.length = 0;
    doc.press(...middle(refs.label));
    assert.deepEqual(heard, ['view']);
    doc.close();
  });
});
