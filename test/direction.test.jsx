// The base direction (`dir`, HTML's: 'ltr', 'rtl', 'auto', inherited) on a
// canvas: each row of text a paragraph in it, `textAlign` start and end on
// its sides, an Edit's caret, keys and hits right to left, a Scroll that
// scrolls from its right with its bar on its left, the layout mirrored (the
// boxes themselves are checked against Chrome's in test/oracle.test.jsx),
// and `dir` across a worker session and a layout worker. Text at fontSize
// 10 is 5 wide per character, 20 high per line.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { $root, $signal, $read, $write } from 'rrx-core';
import { $active, View, Label, Edit, Scroll } from 'ren-core';
import { serve } from 'ren-core/worker';
import { connect } from 'ren-core/remote';
import { Document, render, loadLayout, remoteLayout, serveLayout } from 'ren-canv';
import { RTL } from 'ren-canv/backend';
import { closeAfter } from './fixtures/after.js';

await loadLayout();

const mono = {
  width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2,
  metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
  close() {},
};
const T = { fontSize: 10, lineHeight: 2 };

/** The texts a frame draws: [text, x, face]. @param {Document} doc */
const texts = doc => doc.commands().filter(c => c[0] === 'text').map(c => [c[1], c[2], c[6]]);

/** A Document 300 wide with `view`, presented. @param {() => any} view */
function page(view) {
  const doc = new Document(mono, { width: 300, height: 300 });
  render(view, doc);
  doc.present();
  return doc;
}

describe('ren canv base direction', () => {
  it('sets each row of right-to-left text as a right-to-left paragraph, at its start: the right', () => {
    const doc = page(() => (
      <View dir="rtl" style={{ width: 300, ...T }}>
        <Label text="abc!" />
        <Label text={'אב 12'} />
      </View>
    ));
    // abc! (20 wide): the ! runs right to left, at the row's left; abc left to right after it, at the right.
    // אב 12 (25 wide): 12 left to right at the left, the Hebrew and its space from the right edge.
    assert.deepEqual(texts(doc), [['!', 285, RTL], ['abc', 285, 0], ['12', 275, 0], ['אב ', 300, RTL]]);
    doc.close();
  });

  it("aligns start and end by the item's own direction, inherited as the style gives it", () => {
    const doc = page(() => (
      <View style={{ width: 300, textAlign: 'end', ...T }}>
        <Label dir="rtl" text="abc" />
        <Label text="abc" />
        <View dir="rtl" style={{ textAlign: 'start' }}>
          <Label text="abc" />
          <Label dir="ltr" text="abc" />
          <Label text="abc" style={{ textAlign: 'center' }} />
        </View>
      </View>
    ));
    assert.deepEqual(texts(doc).map(t => t[1]), [0, 285, 285, 0, 142.5], 'end: left right to left, right left to right; start: right right to left, left left to right');
    doc.close();
  });

  it("takes 'auto' from the first strong character of its text, or its children's, left to right without one", () => {
    /** @type {Record<string, any>} */
    const refs = {};
    const doc = page(() => (
      <View style={{ width: 300, ...T }}>
        <Label ref={n => (refs.hebrew = n)} dir="auto" text={'12 אבג'} />
        <Label ref={n => (refs.latin = n)} dir="auto" text="12 abc" />
        <Label ref={n => (refs.none = n)} dir="auto" text="123" />
        <View dir="rtl">
          <Label ref={n => (refs.neutral = n)} dir="auto" text="!!" />
        </View>
        <View ref={n => (refs.view = n)} dir="auto">
          <Label dir="ltr" text="abc" />
          <Edit value="abc" />
          <Label ref={n => (refs.inner = n)} text={'שלום'} />
        </View>
      </View>
    ));
    const dirOf = (/** @type {string} */ name) => refs[name].r.dir;
    assert.equal(dirOf('hebrew'), 1);
    assert.equal(dirOf('latin'), 0);
    assert.equal(dirOf('none'), 0, 'no strong character: left to right');
    assert.equal(dirOf('neutral'), 0, 'not its parent\'s, as Chrome resolves it');
    assert.equal(dirOf('view'), 1, 'past a child with a dir of its own and an Edit\'s value');
    assert.equal(dirOf('inner'), 1, 'inherited');
    doc.close();
  });

  it("follows an 'auto' Edit's value as it is typed", () => {
    /** @type {any} */
    let edit = null;
    const doc = page(() => <Edit ref={n => (edit = n)} dir="auto" style={{ ...T, padding: 0, border: 0, width: 200 }} />);
    edit.focus();
    doc.present();
    assert.equal(edit.r.dir, 0);
    doc.type('א');
    doc.present();
    assert.equal(edit.r.dir, 1, 'its first strong character is right to left');
    doc.key('Backspace');
    doc.type('a');
    doc.present();
    assert.equal(edit.r.dir, 0);
    doc.close();
  });

  it("puts a right-to-left Edit's text at its right, its caret moving right to left with the arrow keys", () => {
    /** @type {any} */
    let edit = null;
    const doc = page(() => <Edit ref={n => (edit = n)} dir="rtl" style={{ ...T, padding: 0, border: 0, width: 200 }} />);
    edit.focus();
    /** The caret: the 2 wide rect, [left, right]. */
    const caret = () => {
      doc.present();
      const c = /** @type {any[]} */ (doc.commands().find(k => k[0] === 'rect' && k[3] - k[1] === 2));
      return [c[1], c[3]];
    };
    assert.deepEqual(caret(), [198, 200], 'empty: at its right edge, inside the box');
    doc.type('אב');
    assert.deepEqual(texts(doc), [['אב', 200, RTL]], 'at the right');
    assert.deepEqual(caret(), [188, 190], 'after ב: its left edge');
    doc.key('ArrowRight');
    assert.equal(edit.selectionStart, 1, 'the right arrow goes back');
    assert.deepEqual(caret(), [193, 195]);
    doc.key('ArrowLeft');
    assert.equal(edit.selectionStart, 2, 'the left arrow goes on');
    doc.key('ArrowRight', true);
    doc.key('ArrowRight', true);
    assert.deepEqual([edit.selectionStart, edit.selectionEnd], [0, 2], 'Shift with the right arrow selects back');
    doc.key('ArrowLeft');
    assert.deepEqual([edit.selectionStart, edit.selectionEnd], [2, 2], 'the left arrow collapses it at its end');
    // A press finds the offset drawn there: the right of א (x 195..200) is before it.
    doc.press(199, 10);
    doc.release(199, 10);
    assert.equal(edit.selectionStart, 0);
    doc.press(191, 10);
    doc.release(191, 10);
    assert.equal(edit.selectionStart, 2, 'past ב, at its left');
    doc.close();
  });

  it('scrolls a right-to-left one-line Edit to show its caret from the right', () => {
    /** @type {any} */
    let edit = null;
    const doc = page(() => <Edit ref={n => (edit = n)} dir="rtl" value={'אבגדהוזחטי'} style={{ ...T, padding: 0, border: 0, width: 30 }} />);
    // 50 wide in 30: at its start edge, its first characters show at the right, the rest past its left.
    doc.present();
    assert.deepEqual(texts(doc), [['אבגדהוזחטי', 30, RTL]]);
    edit.focus();
    edit.setSelectionRange(10, 10);
    doc.present();
    // The caret at the value's end, past the left edge: scrolled right until it shows, 2 inside the box.
    assert.deepEqual(texts(doc), [['אבגדהוזחטי', 52, RTL]]);
    doc.close();
  });

  it('aligns the rows of a right-to-left multi-line Edit at the right, its caret and hits with them', () => {
    /** @type {any} */
    let edit = null;
    const doc = page(() => <Edit ref={n => (edit = n)} dir="rtl" lines={3} value={'abc\nאבגד'} style={{ ...T, padding: 0, border: 0, width: 100 }} />);
    edit.focus();
    edit.setSelectionRange(1, 1);
    doc.present();
    assert.deepEqual(texts(doc), [['abc', 85, 0], ['אבגד', 100, RTL]]);
    const c = /** @type {any[]} */ (doc.commands().find(k => k[0] === 'rect' && k[3] - k[1] === 2));
    assert.deepEqual([c[1], c[3]], [88, 90], 'after a: left to right in the row, its left side');
    doc.press(96, 30);
    doc.release(96, 30);
    assert.equal(edit.selectionStart, 5, 'in the second row, after א');
    doc.close();
  });

  it('scrolls a right-to-left Scroll from its right, scrollLeft below 0, its bar on its left', () => {
    /** @type {Record<string, any>} */
    const refs = {};
    const doc = page(() => (
      <View style={T}>
        <Scroll ref={n => (refs.across = n)} dir="rtl" axis="x" style={{ width: 100, height: 40, direction: 'row' }}>
          <View ref={n => (refs.first = n)} style={{ width: 80, height: 10, shrink: 0 }} />
          <View style={{ width: 70, height: 10, shrink: 0 }} />
        </Scroll>
        <Scroll ref={n => (refs.down = n)} dir="rtl" style={{ width: 100, height: 40 }}>
          <View style={{ height: 100, shrink: 0 }} />
        </Scroll>
      </View>
    ));
    const { across, first, down } = refs;
    assert.equal(first.getBoundingClientRect().x, 20, 'its first child at its right');
    assert.equal(across.scrollLeft, 0);
    across.scrollLeft = -30;
    doc.present();
    assert.equal(across.scrollLeft, -30);
    assert.equal(first.getBoundingClientRect().x, 50, 'scrolled toward its end: the content moves right');
    across.scrollLeft = 10;
    assert.equal(across.scrollLeft, 0, 'clamped at its start');
    across.scrollLeft = -999;
    assert.equal(across.scrollLeft, -50, 'and at its end');
    doc.wheel(50, 20, 0, undefined, 20);
    assert.equal(across.scrollLeft, -30, 'a move to the right goes back toward its start');
    doc.present();
    // The bar down sits on the left of its padding box: a rect from its left edge, as wide as the bar.
    const bar = down.r.bar;
    assert.ok(bar > 0);
    const top = down.getBoundingClientRect().y;
    const track = doc.commands().find(k => k[0] === 'rect' && k[2] === top && k[3] - k[1] === bar);
    assert.ok(track !== undefined && track[1] === 0, `the bar's track on the left: ${JSON.stringify(track)}`);
    doc.close();
  });

  it('carries dir across a worker session: the same layout and frame as rendered directly', { timeout: 30000 }, async t => {
    const view = () => {
      const dir = $signal($active(), /** @type {'ltr' | 'rtl'} */ ('rtl'));
      flip = () => $write(dir, 'ltr');
      return (
        <View dir={() => $read(dir)} style={{ width: 300, direction: 'row', ...T }}>
          <Label text={'שלום abc'} />
          <View style={{ width: 40, height: 10 }} />
        </View>
      );
    };
    /** @type {() => void} */
    let flip = () => {};
    const direct = page(view);
    const flipDirect = flip;
    const remote = new Document(mono, { width: 300, height: 300 });
    const { port1, port2 } = new MessageChannel();
    const connection = connect(port2, remote, remote.root, { schedule: 'now' });
    const session = serve(view, { port: port1, root: $root('app') });
    closeAfter(t, () => {
      connection.close();
      session.close();
      port1.close();
      port2.close();
      direct.close();
      remote.close();
    });
    await connection.idle();
    remote.present();
    assert.equal(remote.root.first?.r.dir, 1);
    assert.deepEqual(remote.commands(), direct.commands());
    const rtl = direct.commands();
    flipDirect();
    flip();
    direct.present();
    await connection.idle();
    remote.present();
    assert.deepEqual(remote.commands(), direct.commands());
    assert.notDeepEqual(direct.commands(), rtl, 'left to right again');
  });

  it('mirrors a right-to-left layout in a layout worker as in this thread', { timeout: 30000 }, async t => {
    const channel = new MessageChannel();
    const stop = serveLayout(channel.port2);
    const layout = remoteLayout(channel.port1);
    const view = () => (
      <View dir="rtl" style={{ width: 300, direction: 'row', padding: [0, 5, 0, 20], ...T }}>
        <View style={{ width: 40, height: 10, margin: [0, 7, 0, 0] }} />
        <View style={{ display: 'grid', columns: '30px 1fr', width: 100 }}>
          <View style={{ height: 10 }} />
          <Label text="abc" />
        </View>
      </View>
    );
    const local = new Document(mono, { width: 300, height: 200 });
    const remote = new Document(mono, { width: 300, height: 200, layout });
    closeAfter(t, () => {
      local.close();
      remote.close();
      layout.close();
      stop();
      channel.port1.close();
    });
    render(view, local);
    render(view, remote);
    local.present();
    while (remote.boxes.engine.busy || remote.damage) await new Promise(resolve => (remote.framed = resolve));
    assert.deepEqual(remote.commands(), local.commands());
    /** @type {any} */
    const row = local.root.first;
    const [box, grid] = [row.first, row.first.next];
    assert.deepEqual([box.getBoundingClientRect().x, grid.getBoundingClientRect().x, grid.first.getBoundingClientRect().x], [248, 148, 218], 'from the right: the margin on its right, the grid\'s first column at its right');
  });
});
