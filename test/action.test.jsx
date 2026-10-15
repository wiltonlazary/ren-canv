// An Action holding content, as a DOM button holds it: its children laid
// out as a View's (the portable style applies) and painted inside it, one
// press and focus target with the states, keys and ring of a text Action,
// named in the accessibility mirror by the text it holds.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyWindow } from 'happy-dom';
import { View, Label, Action, Edit, Show, Image, $focus, $active } from 'ren-core';
import { $signal, $read, $write } from 'rrx-core';
import { Document, render, attach, loadLayout } from 'ren-canv';
import { readFileSync } from 'node:fs';

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

/** Every character is half its size wide. */
const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };
const make = () => new Document(mono, { width: 300, height: 200 });
const texts = (/** @type {Document} */ doc) => doc.commands().filter(c => c[0] === 'text');
/** An item's page box. @param {any} item */
const box = item => {
  const r = item.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height];
};

describe('ren canv an Action holding content', () => {
  it('presses an Action inside a View whose pointerdown was prevented, as the DOM clicks it', () => {
    const doc = make();
    let presses = 0;
    /** @type {any} */
    let action = null;
    render(() => (
      <View style={{ align: 'start' }} onPointerDown={(/** @type {any} */ e) => e.preventDefault()}>
        <Action ref={(/** @type {any} */ n) => (action = n)} text="Go" onPress={() => presses++} />
      </View>
    ), doc);
    const [x, y] = box(action);
    doc.press(x + 4, y + 4);
    doc.release(x + 4, y + 4);
    assert.equal(presses, 1);
    assert.equal(doc.focused, null, 'the prevented pointerdown keeps its focus');
    doc.close();
  });

  it('hears files dropped on an item, bubbling from the item under the point', () => {
    const doc = make();
    /** @type {string[]} */
    const heard = [];
    /** @type {any} */
    let zone = null;
    render(() => (
      <View style={{ align: 'start' }} onDrop={(/** @type {any} */ e) => heard.push(`outer ${e.files.length}`)}>
        <View ref={(/** @type {any} */ n) => (zone = n)} style={{ width: 100, height: 50, background: '#eee' }} onDrop={(/** @type {any} */ e) => heard.push(`zone ${e.files.map((/** @type {any} */ f) => f.name)}`)} />
      </View>
    ), doc);
    const [x, y] = box(zone);
    assert.ok(doc.dropFiles(x + 10, y + 10, [{ name: "a.txt" }]));
    assert.deepEqual(heard, ['zone a.txt', 'outer 1']);
    // Through attach: the canvas's drag and drop.
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const stop = attach(doc, canvas);
    const over = new window.Event('dragover', { cancelable: true });
    canvas.dispatchEvent(over);
    assert.ok(over.defaultPrevented, 'the drag is accepted');
    const drop = /** @type {any} */ (new window.Event('drop', { cancelable: true }));
    Object.defineProperties(drop, { offsetX: { value: x + 5 }, offsetY: { value: y + 5 }, dataTransfer: { value: { files: [{ name: 'b.png' }] } } });
    canvas.dispatchEvent(drop);
    assert.deepEqual(heard.slice(2), ['zone b.png', 'outer 1']);
    stop();
    doc.close();
  });

  it('tells the item a drag or drop at a point reaches: the one under it or an ancestor that hears one', () => {
    const doc = make();
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ align: 'start' }}>
        <View ref={(/** @type {any} */ n) => (refs.zone = n)} style={{ width: 100, height: 50 }} onDragOver={() => {}}>
          <Label ref={(/** @type {any} */ n) => (refs.label = n)} text="drop here" />
        </View>
        <View ref={(/** @type {any} */ n) => (refs.plain = n)} style={{ width: 100, height: 50, background: '#eee' }} onPress={() => {}} />
      </View>
    ), doc);
    doc.present();
    const [lx, ly] = box(refs.label);
    assert.equal(doc.dropTarget(lx + 2, ly + 2), refs.zone, "a bare View's child: the View hears the drag");
    const [px, py] = box(refs.plain);
    assert.equal(doc.dropTarget(px + 5, py + 5), null, 'painted, but nothing there hears a drag');
    assert.equal(doc.dropTarget(250, 190), null, 'nothing under it');
    doc.close();
  });

  it('passes a drag over the canvas to the items under it, as the DOM: enter, leave, over, bubbling', () => {
    const doc = make();
    /** @type {string[]} */
    const heard = [];
    const log = (/** @type {string} */ who) => (/** @type {any} */ e) => heard.push(`${who} ${e.type} ${e.files} ${e.types.join(',')} ${e.target === e.currentTarget ? 'own' : 'bubbled'}`);
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ align: 'start', gap: 10 }} onDragEnter={log('outer')} onDragLeave={log('outer')}>
        <View ref={(/** @type {any} */ n) => (refs.zone = n)} style={{ width: 100, height: 50, padding: 10, background: '#eee' }} onDragEnter={log('zone')} onDragOver={log('zone')} onDragLeave={log('zone')}>
          <View ref={(/** @type {any} */ n) => (refs.child = n)} style={{ width: 20, height: 20, background: '#ddd' }} />
        </View>
        <View ref={(/** @type {any} */ n) => (refs.other = n)} style={{ width: 100, height: 50, background: '#ccc' }} onDragOver={(/** @type {any} */ e) => e.stopPropagation()} />
      </View>
    ), doc);
    const [x, y] = box(refs.zone);
    assert.ok(doc.dragOver(x + 50, y + 40, 1, ['image/png']), 'the zone hears it');
    assert.deepEqual(heard.splice(0), ['zone dragenter 1 image/png own', 'outer dragenter 1 image/png bubbled', 'zone dragover 1 image/png own']);
    doc.dragOver(x + 52, y + 40, 1, ['image/png']);
    assert.deepEqual(heard.splice(0), ['zone dragover 1 image/png own'], 'over again: no enter');
    const [cx, cy] = box(refs.child);
    doc.dragOver(cx + 5, cy + 5, 1, ['image/png']);
    assert.deepEqual(heard.splice(0), ['zone dragenter 1 image/png bubbled', 'outer dragenter 1 image/png bubbled', 'zone dragleave 1 image/png own', 'outer dragleave 1 image/png bubbled', 'zone dragover 1 image/png bubbled'], 'a child: its enter first, then the last one\'s leave, as the DOM');
    const [ox, oy] = box(refs.other);
    assert.ok(doc.dragOver(ox + 5, oy + 5, 2, ['', 'text/plain']), 'its own handler stops it');
    assert.deepEqual(heard.splice(0), ['outer dragenter 2 ,text/plain bubbled', 'zone dragleave 2 ,text/plain bubbled', 'outer dragleave 2 ,text/plain bubbled']);
    doc.dragLeave();
    assert.deepEqual(heard.splice(0), ['outer dragleave 0  bubbled'], 'leaving the canvas');
    doc.dragOver(x + 50, y + 40);
    heard.length = 0;
    doc.dropFiles(x + 50, y + 40, []);
    doc.dragLeave();
    assert.deepEqual(heard, [], 'a drop ends the drag without a leave');
    // Through attach: the canvas element's drag events.
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const stop = attach(doc, canvas);
    const drag = (/** @type {string} */ type, /** @type {number} */ px, /** @type {number} */ py) => {
      const e = /** @type {any} */ (new window.Event(type, { cancelable: true }));
      Object.defineProperties(e, { offsetX: { value: px }, offsetY: { value: py }, dataTransfer: { value: { items: [{ kind: 'file', type: 'application/pdf' }, { kind: 'string', type: 'text/plain' }] } } });
      canvas.dispatchEvent(e);
      return e;
    };
    assert.ok(drag('dragenter', x + 50, y + 40).defaultPrevented, 'the drag is accepted');
    drag('dragover', x + 50, y + 40);
    drag('dragleave', 0, 0);
    assert.deepEqual(heard, ['zone dragenter 1 application/pdf own', 'outer dragenter 1 application/pdf bubbled', 'zone dragover 1 application/pdf own', 'zone dragover 1 application/pdf own', 'zone dragleave 0  own', 'outer dragleave 0  bubbled']);
    stop();
    doc.close();
  });

  it('maps a point in a Label to the offset of its text there', () => {
    const doc = make();
    /** @type {any} */
    let label = null;
    render(() => (
      <View style={{ padding: 10, align: 'start' }}>
        <Label ref={(/** @type {any} */ n) => (label = n)} text="one two three" style={{ fontSize: 10, lineHeight: 2, wrap: true, width: 40 }} />
      </View>
    ), doc);
    doc.present();
    // Characters are 5 wide, rows 20 high: 'one two' / 'three'.
    assert.equal(label.offsetAt(10 + 11, 10 + 5), 2, 'in the first row, nearest the third character');
    assert.equal(label.offsetAt(10 + 6, 10 + 25), 8 + 1, 'in the second row');
    doc.close();
  });

  it('gives the leave of a dragged item hidden or removed since to its nearest ancestor still attached', () => {
    const doc = make();
    /** @type {string[]} */
    const heard = [];
    const log = (/** @type {string} */ who) => (/** @type {any} */ e) => heard.push(`${who} ${e.type} ${e.target === e.currentTarget ? 'own' : 'bubbled'}`);
    /** @type {any} */
    let shown = null;
    /** @type {any} */
    let kept = null;
    /** @type {any} */
    const refs = {};
    render(() => {
      shown = $signal($active(), true);
      kept = $signal($active(), true);
      return (
      <View style={{ align: 'start', gap: 10 }} onDragLeave={log('outer')}>
        <View ref={(/** @type {any} */ n) => (refs.zone = n)} style={{ width: 100, height: 50, padding: 10, background: '#eee' }} onDragEnter={log('zone')} onDragLeave={log('zone')}>
          <View ref={(/** @type {any} */ n) => (refs.child = n)} hidden={() => !$read(shown)} style={{ width: 20, height: 20, background: '#ddd' }} onDragOver={() => $write(shown, false)} />
        </View>
        <View ref={(/** @type {any} */ n) => (refs.box = n)} style={{ width: 100, height: 50, padding: 10, background: '#ccc' }} onDragLeave={log('box')}>
          <Show when={() => $read(kept)}>
            <View ref={(/** @type {any} */ n) => (refs.inner = n)} style={{ width: 20, height: 20, background: '#ddd' }} onDragOver={() => $write(kept, false)} />
          </Show>
        </View>
      </View>
      );
    }, doc);
    doc.present();
    const [cx, cy] = box(refs.child);
    doc.dragOver(cx + 5, cy + 5);
    assert.deepEqual(heard.splice(0), ['zone dragenter bubbled'], 'its dragover hides the child');
    doc.dragLeave();
    assert.deepEqual(heard.splice(0), ['zone dragleave own', 'outer dragleave bubbled'], 'the leave reaches the ancestor');
    $write(shown, true);
    doc.dragOver(cx + 5, cy + 5);
    heard.length = 0;
    doc.dragOver(cx + 6, cy + 5);
    assert.deepEqual(heard.splice(0), [], 'onto the ancestor that took the hidden child\'s place: still under the drag');
    const [ix, iy] = box(refs.inner);
    doc.dragOver(ix + 5, iy + 5);
    assert.deepEqual(heard.splice(0), ['zone dragleave own', 'outer dragleave bubbled'], 'a change of target: the leave too');
    assert.equal(refs.inner.parent, null, 'its dragover removed the inner item');
    doc.dragLeave();
    assert.deepEqual(heard.splice(0), ['box dragleave own', 'outer dragleave bubbled'], 'a removed item\'s leave reaches its old parent');
    doc.close();
  });

  it('sends focusout and focusin, bubbling with relatedTarget, after blur and focus, as the DOM', () => {
    const doc = make();
    /** @type {string[]} */
    const heard = [];
    const name = (/** @type {any} */ n) => (n === null || n === undefined ? 'none' : n === refs.a ? 'a' : n === refs.b ? 'b' : 'other');
    const log = (/** @type {string} */ who) => (/** @type {any} */ e) => heard.push(`${who} ${e.type ?? 'plain'} ${name(e.target)} ${name(e.relatedTarget)}`);
    /** @type {any} */
    const refs = {};
    render(() => (
      <View onFocusIn={log('outer')} onFocusOut={log('outer')}>
        <View onFocusIn={log('wrap')} onFocusOut={log('wrap')}>
          <Action ref={(/** @type {any} */ n) => (refs.a = n)} text="a" onFocus={() => heard.push('a focus')} onBlur={() => heard.push('a blur')} />
        </View>
        <Action ref={(/** @type {any} */ n) => (refs.b = n)} text="b" onFocusIn={(/** @type {any} */ e) => e.stopPropagation()} />
      </View>
    ), doc);
    refs.a.focus();
    assert.deepEqual(heard.splice(0), ['a focus', 'wrap focusin a none', 'outer focusin a none']);
    refs.b.focus();
    assert.deepEqual(heard.splice(0), ['a blur', 'wrap focusout a b', 'outer focusout a b'], 'b stops its own focusin');
    doc.key('Tab', true);
    assert.equal(doc.focused, refs.a);
    assert.deepEqual(heard.splice(0), ['outer focusout b a', 'a focus', 'wrap focusin a b', 'outer focusin a b'], 'Tab moves it the same way');
    refs.a.blur();
    assert.deepEqual(heard.splice(0), ['a blur', 'wrap focusout a none', 'outer focusout a none']);
    doc.close();
  });

  it("moves the focus as Chrome does when a focus handler acts (fixtures/focus.json)", () => {
    const oracle = JSON.parse(readFileSync(new URL('./fixtures/focus.json', import.meta.url), 'utf8'));
    /** The cases heard otherwise than in Chrome, by name: why. */
    const removed = "a removed item's handlers go with it (ren-core drops them first): it hears no blur, its ancestors still hear focusout";
    const KNOWN = /** @type {Record<string, string>} */ ({
      'B focus removes B': removed,
      'B removed after': removed,
      'B focus disables B': 'Chrome gives a disabled button\'s focus up at its next frame, after focusin; a Document at once',
    });
    for (const c of oracle.cases) {
      const doc = make();
      /** @type {string[]} */
      const heard = [];
      /** @type {any} */
      const refs = {};
      /** @type {Record<string, any>} */
      const signals = {};
      /** @type {any[]} */
      let steps = [];
      const name = (/** @type {any} */ n) => Object.keys(refs).find(k => refs[k] === n) ?? 'null';
      /** @param {string} what */
      const act = what => {
        const [verb, id] = what.split(':');
        if (verb === 'focus') refs[id].focus();
        if (verb === 'blur') refs[id].blur();
        if (verb === 'disable') $write(signals[`off${id}`], true);
        if (verb === 'remove') $write(signals[`gone${id}`], true);
      };
      /** @param {string} who @param {string} type */
      const on = (who, type) => (/** @type {any} */ e) => {
        heard.push(`${who} ${type} ${name(e.target)} ${name(e.relatedTarget)}`);
        const step = steps[0];
        if (step !== undefined && step.on === type && step.by === who) {
          steps.shift();
          act(step.act);
        }
      };
      /** @param {string} id */
      const action = id => (
        <Show when={() => !$read(signals[`gone${id}`])}>
          <Action ref={(/** @type {any} */ n) => n && (refs[id] = n)} text={id} disabled={() => $read(signals[`off${id}`])} onFocus={on(id, 'focus')} onBlur={on(id, 'blur')} />
        </Show>
      );
      render(() => {
        for (const id of 'ABC') {
          signals[`off${id}`] = $signal($active(), false);
          signals[`gone${id}`] = $signal($active(), false);
        }
        return (
          <View ref={(/** @type {any} */ n) => (refs.outer = n)} onFocusIn={on('outer', 'focusin')} onFocusOut={on('outer', 'focusout')}>
            {action('A')}
            {action('B')}
            {action('C')}
          </View>
        );
      }, doc);
      refs.A.focus();
      heard.length = 0;
      steps = c.on === null ? [] : [c, ...(c.chain ? [c.chain] : [])];
      refs.B.focus();
      if (c.post) act(c.post);
      doc.present();
      // What Chrome hears by its next frame too, and where the focus is then.
      const same = JSON.stringify(heard) === JSON.stringify([...c.log, ...c.later]) && name(doc.focused) === (c.after ?? 'null');
      if (c.name in KNOWN) assert.ok(!same, `heard as Chrome now: take ${c.name} out of KNOWN (${KNOWN[c.name]})`);
      else {
        assert.deepEqual(heard, [...c.log, ...c.later], c.name);
        assert.equal(name(doc.focused), c.after ?? 'null', `${c.name}: focused`);
      }
      doc.close();
    }
  });

  it("reads an item's accessible name as its label: the label given, else for an Action or a role named by its content the text it holds", () => {
    const doc = make();
    /** @type {any} */
    const refs = {};
    /** @param {string} id */
    const ref = id => (/** @type {any} */ n) => (refs[id] = n);
    render(() => (
      <View>
        <Action ref={ref('caption')} text="Save" />
        <Action ref={ref('labelled')} label="Close" text="×" />
        <Action ref={ref('holding')}>
          <View>
            <Label>{'List   view'}</Label>
            <Label hidden>never</Label>
          </View>
          <Label>{' (3)'}</Label>
        </Action>
        <Action ref={ref('empty')} label="">
          <Label>Board</Label>
        </Action>
        <View ref={ref('radio')} role="radio">
          <Label>Time</Label>
        </View>
        <View ref={ref('group')} role="group">
          <Label>Not a name</Label>
        </View>
        <View ref={ref('plain')}>
          <Label>Plain</Label>
        </View>
        <Edit ref={ref('edit')} value="typed" />
        <Edit ref={ref('placeholder')} label="Search" value="" />
      </View>
    ), doc);
    const names = Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, v.label]));
    assert.deepEqual(names, {
      caption: 'Save',
      labelled: 'Close',
      holding: 'List view (3)',
      empty: 'Board',
      radio: 'Time',
      group: null,
      plain: null,
      edit: null,
      placeholder: 'Search',
    });
    doc.close();
  });

  it("keeps the focus where it is when code focuses an item that cannot take it, as Chrome's focus() of a div", () => {
    const doc = make();
    /** @type {string[]} */
    const heard = [];
    /** @type {any} */
    const refs = {};
    render(() => (
      <View ref={(/** @type {any} */ n) => (refs.view = n)}>
        <Action ref={(/** @type {any} */ n) => (refs.a = n)} text="a" onBlur={() => heard.push('a blur')} />
        <Label ref={(/** @type {any} */ n) => (refs.label = n)}>x</Label>
        <Image ref={(/** @type {any} */ n) => (refs.image = n)} source="" />
      </View>
    ), doc);
    refs.a.focus();
    for (const what of ['view', 'label', 'image']) {
      refs[what].focus();
      assert.ok(doc.focused === refs.a, `${what}.focus(): the Action keeps the focus`);
    }
    assert.deepEqual(heard, [], 'and hears no blur');
    doc.close();
  });

  it('sends blur and a bubbling focusout when the focused item is hidden, removed or disabled', () => {
    const doc = make();
    /** @type {string[]} */
    const heard = [];
    const log = (/** @type {string} */ who) => (/** @type {any} */ e) => heard.push(`${who} ${e.type ?? 'blur'} ${e.relatedTarget === null ? 'none' : 'some'}`);
    /** @type {any} */
    let shown = null;
    /** @type {any} */
    let kept = null;
    /** @type {any} */
    let enabled = null;
    /** @type {any} */
    const refs = {};
    render(() => {
      shown = $signal($active(), true);
      kept = $signal($active(), true);
      enabled = $signal($active(), true);
      return (
        <View onFocusOut={log('outer')}>
          <View onFocusOut={log('wrap')}>
            <Action ref={(/** @type {any} */ n) => (refs.a = n)} text="a" hidden={() => !$read(shown)} onBlur={() => heard.push('a blur')} />
            <Show when={() => $read(kept)}>
              <Action ref={(/** @type {any} */ n) => (refs.b = n)} text="b" />
            </Show>
            <Edit ref={(/** @type {any} */ n) => (refs.c = n)} value="c" disabled={() => !$read(enabled)} onBlur={() => heard.push('c blur')} />
          </View>
        </View>
      );
    }, doc);
    refs.a.focus();
    $write(shown, false);
    doc.present();
    assert.equal(doc.focused, null);
    assert.deepEqual(heard.splice(0), ['a blur', 'wrap focusout none', 'outer focusout none'], 'hidden');
    refs.b.focus();
    $write(kept, false);
    doc.present();
    assert.equal(doc.focused, null);
    assert.deepEqual(heard.splice(0), ['wrap focusout none', 'outer focusout none'], 'removed: its old ancestors hear it');
    refs.c.focus();
    $write(enabled, false);
    doc.present();
    assert.equal(doc.focused, null);
    assert.deepEqual(heard.splice(0), ['c blur', 'wrap focusout none', 'outer focusout none'], 'disabled');
    doc.present();
    assert.deepEqual(heard, [], 'once');
    doc.close();
  });

  it('keeps Tab inside a trap, and tells the focused item through getRootNode', () => {
    const doc = make();
    /** @type {any} */
    const refs = {};
    render(() => (
      <View>
        <Action ref={(/** @type {any} */ n) => (refs.out = n)} text="out" />
        <View trap>
          <Action ref={(/** @type {any} */ n) => (refs.a = n)} text="a" />
          <Action ref={(/** @type {any} */ n) => (refs.b = n)} text="b" />
        </View>
      </View>
    ), doc);
    refs.a.focus();
    doc.key('Tab');
    assert.equal(doc.focused, refs.b);
    doc.key('Tab');
    assert.equal(doc.focused, refs.a, 'the last to the first');
    doc.key('Tab', true);
    assert.equal(doc.focused, refs.b, 'and back');
    assert.equal(refs.out.getRootNode().activeElement, refs.b);
    refs.out.focus();
    doc.key('Tab');
    assert.equal(doc.focused, refs.a, 'outside it, Tab goes on in document order');
    doc.close();
  });

  it('takes the focus back into a trap when the focused item inside it is removed', () => {
    const doc = make();
    /** @type {any} */
    const refs = {};
    /** @type {string[]} */
    const keys = [];
    render(() => {
      const shown = $signal($active(), 'button');
      const empty = $signal($active(), false);
      refs.shown = shown;
      refs.empty = empty;
      return (
        <View>
          <Action text="out" />
          <View trap onKey={(/** @type {any} */ e) => keys.push(e.key)}>
            {() => ($read(empty) ? null : <Action ref={(/** @type {any} */ n) => (refs.first = n)} text="first" />)}
            {() => ($read(shown) === 'button' ? <Action ref={(/** @type {any} */ n) => (refs.swap = n)} text="swap" /> : <Label text="swapped" />)}
          </View>
          <View trap tabIndex={-1} ref={(/** @type {any} */ n) => (refs.bare = n)}>
            {() => ($read(shown) === 'button' ? <Action ref={(/** @type {any} */ n) => (refs.only = n)} text="only" /> : null)}
          </View>
        </View>
      );
    }, doc);
    doc.present();
    refs.swap.focus();
    $write(refs.shown, 'label');
    doc.present();
    assert.ok(doc.focused === refs.first, "the trap's first focusable");
    doc.key('Escape');
    assert.deepEqual(keys, ['Escape'], 'its keys still reach the trap');
    $write(refs.shown, 'button');
    doc.present();
    refs.only.focus();
    $write(refs.shown, 'label');
    doc.present();
    assert.ok(doc.focused === refs.bare, 'none inside: the trap itself, which takes the focus');
    doc.close();
  });

  it("focuses the first or last focusable inside an item, as ren-core's $focus asks", () => {
    const doc = make();
    /** @type {any} */
    const refs = {};
    render(() => (
      <View>
        <Action text="out" />
        <View trap ref={(/** @type {any} */ n) => (refs.trap = n)}>
          <Label text="title" />
          <Edit ref={(/** @type {any} */ n) => (refs.off = n)} label="off" value="" disabled />
          <View hidden>
            <Action text="hidden" />
          </View>
          <Edit ref={(/** @type {any} */ n) => (refs.name = n)} label="name" value="" />
          <Action ref={(/** @type {any} */ n) => (refs.save = n)} text="save" />
        </View>
        <View ref={(/** @type {any} */ n) => (refs.empty = n)}>
          <Label text="nothing to focus" />
        </View>
      </View>
    ), doc);
    doc.present();
    assert.equal($focus(refs.trap), true);
    assert.equal(doc.focused, refs.name, 'the first shown and enabled');
    assert.equal(refs.trap.focusLast(), true);
    assert.equal(doc.focused, refs.save);
    assert.equal($focus(refs.empty), false);
    assert.equal(doc.focused, refs.save, 'the focus stays');
    doc.close();
  });

  it('bubbles a press through the ancestors, as a DOM click, until one stops it', () => {
    const doc = make();
    /** @type {string[]} */
    const heard = [];
    let stop = false;
    /** @type {any} */
    let action = null;
    render(() => (
      <View style={{ align: 'start' }} onPress={(/** @type {any} */ e) => heard.push(`outer ${e.target === action}`)}>
        <View onPress={() => heard.push('inner')}>
          <Action
            ref={(/** @type {any} */ n) => (action = n)}
            text="go"
            onPress={(/** @type {any} */ e) => {
              heard.push('action');
              if (stop) e.stopPropagation();
            }}
          />
        </View>
      </View>
    ), doc);
    const [x, y] = box(action);
    doc.press(x + 4, y + 4);
    doc.release(x + 4, y + 4);
    assert.deepEqual(heard, ['action', 'inner', 'outer true']);
    heard.length = 0;
    doc.key('Enter');
    assert.deepEqual(heard, ['action', 'inner', 'outer true'], 'Enter on the focused Action too');
    heard.length = 0;
    stop = true;
    doc.press(x + 4, y + 4);
    assert.deepEqual(heard, ['action']);
    doc.close();
  });


  it('lays its children out and paints them inside it, centered as a button does', () => {
    const doc = make();
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ align: 'start' }}>
        <Action ref={(/** @type {any} */ n) => (refs.action = n)} onPress={() => {}}>
          <Label ref={(/** @type {any} */ n) => (refs.label = n)} text="inside action" style={{ fontSize: 10 }} />
        </Action>
      </View>
    ), doc);
    const drawn = texts(doc);
    assert.deepEqual(drawn.map(c => c[1]), ['inside action']);
    const [ax, ay, aw, ah] = box(refs.action);
    const [lx, ly, lw, lh] = box(refs.label);
    assert.ok(lx >= ax && ly >= ay && lx + lw <= ax + aw && ly + lh <= ay + ah, 'inside the Action');
    assert.equal(ah, doc.theme.field, "a field high, as a text Action");
    assert.equal(ly - ay, (ah - lh) / 2, 'centered in its height');
    assert.equal(aw, 13 * 5 + 2 * doc.theme.inset, "as wide as what it holds, with the Action's padding");
    assert.equal(drawn[0][5], `#${(doc.theme.paper >>> 0).toString(16).padStart(8, '0')}`, "in the Action's text color");
    doc.close();
  });

  it('applies the portable style to what it holds: direction, gap, padding, align', () => {
    const doc = make();
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ align: 'start' }}>
        <Action ref={(/** @type {any} */ n) => (refs.action = n)} style={{ direction: 'row', gap: 6, padding: 4, align: 'center' }}>
          <Label ref={(/** @type {any} */ n) => (refs.a = n)} text="ab" style={{ fontSize: 10 }} />
          <Label ref={(/** @type {any} */ n) => (refs.b = n)} text="cdef" style={{ fontSize: 20 }} />
        </Action>
      </View>
    ), doc);
    const [ax, ay, , ah] = box(refs.action);
    const [bx, by, bw, bh] = box(refs.b);
    const [cx, cy, , ch] = box(refs.a);
    assert.equal(bx - ax, 4 + 10 + 6, 'in a row, after the first and the gap');
    assert.equal(cx - ax, 4);
    assert.equal(bw, 40);
    assert.equal(ah, Math.max(doc.theme.field, bh + 8));
    assert.equal(cy - ay + ch / 2, by - ay + bh / 2, 'aligned on the center');
    doc.close();
  });

  it('is one target: a press on its content presses it, focuses it, and its states and keys are a text Action\'s', () => {
    const doc = make();
    let presses = 0;
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ align: 'start' }}>
        <Action ref={(/** @type {any} */ n) => (refs.action = n)} onPress={() => presses++} style={{ background: '#000001', hover: { background: '#000002' }, press: { background: '#000003' } }}>
          <Label ref={(/** @type {any} */ n) => (refs.label = n)} text="inside action" />
        </Action>
      </View>
    ), doc);
    const [lx, ly, lw, lh] = box(refs.label);
    const fills = () => doc.commands().filter(c => c[0] === 'rect' || c[0] === 'round').map(c => c[5]);
    doc.move(lx + lw / 2, ly + lh / 2);
    doc.present();
    assert.ok(fills().includes('#ff000002'), 'hovered over its content');
    assert.equal(doc.cursor, 'default');
    doc.press(lx + lw / 2, ly + lh / 2);
    assert.equal(presses, 1, 'the press on its Label presses the Action');
    assert.equal(doc.focused, refs.action);
    doc.release(lx + lw / 2, ly + lh / 2);
    doc.key('Enter');
    doc.key(' ');
    assert.equal(presses, 3, 'Enter and Space press it');
    doc.focus(null);
    doc.key('Tab');
    doc.present();
    assert.equal(doc.focused, refs.action, 'it takes keyboard focus');
    const [ax, ay, aw, ah] = box(refs.action);
    // The paint snaps the box to device pixels.
    const at = (/** @type {any[]} */ c) => c[1] === ax - 2 && c[2] === ay - 2 && c[3] === Math.round(ax + aw) + 2 && c[4] === ay + ah + 2;
    const ring = doc.commands().find(c => c[0] === 'border' && at(c));
    assert.ok(ring, 'with its focus ring');
    assert.equal(ring[7], 2, 'a 2 wide stroke outside the box, as the DOM\'s outline');
    assert.ok(!doc.commands().some(c => c[0] === 'round' && at(c)), 'no fill behind the box');
    assert.equal(doc.textAt(lx + 2, ly + 2, false), null, 'its text is not selectable, as a button\'s');
    doc.close();
  });

  it('keeps a text Action a leaf, and names an Action by what it holds in the mirror', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = make();
    render(() => (
      <View>
        <Action text="Go" />
        <Action><Label text="inside action" /></Action>
        <Action label="Close"><Label text="x" /></Action>
      </View>
    ), doc);
    const stop = attach(doc, canvas);
    const buttons = [...window.document.querySelectorAll('[data-ren-aria] button')];
    assert.deepEqual(buttons.map(b => b.textContent), ['Go', 'inside action', 'x']);
    assert.equal(buttons[2].getAttribute('aria-label'), 'Close', 'a label names it first');
    assert.equal(buttons[1].children.length, 0, 'its content is its name, not elements');
    assert.deepEqual(texts(doc).map(c => c[1]), ['Go', 'inside action', 'x']);
    stop();
    doc.close();
  });
  it('renames an Action in the mirror when content nested in a View of it changes', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = make();
    /** @type {any} */
    let on = null;
    /** @type {any} */
    let hide = null;
    render(() => {
      on = $signal($active(), false);
      hide = $signal($active(), false);
      return (
        <View>
          <Action>
            <View hidden={() => $read(hide)}><Label text="a" /></View>
            <View><Show when={() => $read(on)}><Label text="b" /></Show></View>
          </Action>
        </View>
      );
    }, doc);
    const stop = attach(doc, canvas);
    const name = () => /** @type {any} */ (window.document.querySelector('[data-ren-aria] button')).textContent;
    assert.equal(name(), 'a');
    $write(on, true);
    doc.present();
    assert.equal(name(), 'a b', 'a Label shown inside a nested View renames it');
    $write(hide, true);
    doc.present();
    assert.equal(name(), 'b', 'a nested View hidden renames it');
    $write(on, false);
    doc.present();
    assert.equal(name(), '', 'a Label removed from a nested View renames it');
    stop();
    doc.close();
  });
  it('mirrors an Action\'s selected as aria-pressed only without a role', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = make();
    render(() => (
      <View>
        <Action text="plain" selected />
        <Action text="tab" role="tab" selected />
        <Action text="switch" selected role="switch" />
      </View>
    ), doc);
    const stop = attach(doc, canvas);
    const [plain, tab, sw] = /** @type {any[]} */ ([...window.document.querySelectorAll('[data-ren-aria] button')]);
    assert.equal(plain.getAttribute('aria-pressed'), 'true');
    assert.equal(tab.getAttribute('aria-pressed'), null, 'a tab is not a toggle button');
    assert.equal(sw.getAttribute('aria-pressed'), null, 'nor a switch');
    stop();
    doc.close();
  });
  it('mirrors selected={false} as aria-pressed="false", a toggle that is off', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = make();
    /** @type {any} */
    let on = null;
    render(() => {
      on = $signal($active(), true);
      return (
        <View>
          <Action text="off" selected={false} />
          <Action text="flip" selected={() => $read(on)} />
          <Action text="plain" />
          <Action text="null" selected={null} />
        </View>
      );
    }, doc);
    const stop = attach(doc, canvas);
    const [off, flip, plain] = /** @type {any[]} */ ([...window.document.querySelectorAll('[data-ren-aria] button')]);
    assert.equal(off.getAttribute('aria-pressed'), 'false', 'a toggle that is off, as ren-dom writes it');
    assert.equal(flip.getAttribute('aria-pressed'), 'true');
    $write(on, false);
    doc.present();
    assert.equal(flip.getAttribute('aria-pressed'), 'false', 'flipped off, still a toggle');
    assert.equal(plain.getAttribute('aria-pressed'), null, 'not a toggle');
    const nil = /** @type {any} */ ([...window.document.querySelectorAll('[data-ren-aria] button')][3]);
    assert.equal(nil.getAttribute('aria-pressed'), null, 'selected={null} is not a toggle either');
    stop();
    doc.close();
  });

  it('mirrors an Image with alt="" as a decorative image: presentation, no name', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    const doc = make();
    render(() => <View><Image source="a.png" alt="" /><Image source="b.png" alt="logo" /></View>, doc);
    const stop = attach(doc, canvas);
    const [decorative, logo] = /** @type {any[]} */ ([...window.document.querySelectorAll('[data-ren-aria] [role]')]);
    assert.deepEqual([decorative.getAttribute('role'), decorative.getAttribute('aria-label')], ['presentation', null], 'alt="" is decoration, as ren-dom\'s img');
    assert.deepEqual([logo.getAttribute('role'), logo.getAttribute('aria-label')], ['img', 'logo']);
    stop();
    doc.close();
  });
});
