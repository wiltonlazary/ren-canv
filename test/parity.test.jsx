// Direct and worker mode hear the same events on a Document. One script of
// input (presses, focus moves, keys, wheel scrolls, pointer moves) drives a
// Document rendered directly and one a worker session renders through
// ren-core's connection, and the handler logs must match: exactly, except that
// a burst of superseding events (moves, scrolls) may drop the older ones, so
// its log is a subsequence of the direct log that ends with the same entry.
// The direct mode's own order (blur before focus, $scrolls before onScroll,
// blur when the focused item goes) and its targets and relatedTargets, which
// a worker's events do not carry, are checked once against the README.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { $root, $signal, $read, $write } from 'rrx-core';
import { View, Label, Action, Scroll, $keys, $scrolls, $active } from 'ren-core';
import { serve } from 'ren-core/worker';
import { connect } from 'ren-core/remote';
import { Document, render, loadLayout } from 'ren-canv';
import { closeAfter } from './fixtures/after.js';

await loadLayout();

const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };

/**
 * One mode's logs: who heard what, the same in both modes; and the targets
 * and relatedTargets the handlers saw (`trace`), by the items' tags (`tags`).
 * `hide` hides R.
 * @typedef {{ log: string[], trace: string[], tags: Map<any, string>, hide: () => void }} Logs
 */

/** @returns {Logs} */
const logs = () => ({ log: [], trace: [], tags: new Map(), hide() {} });

/** An item's tag in a trace: null, '-' (none given), or the tag of its ref. @param {Logs} logs @param {any} item */
const tagOf = (logs, item) => (item === null ? 'null' : item === undefined ? '-' : logs.tags.get(item) ?? '?');

/**
 * A handler that logs who heard what, and stops the event where the script
 * says: A stops presses, focus, blur and Escape, and moves with Shift; the
 * View stops moves with Alt; the Scroll stops its scrolls.
 * @param {Logs} logs @param {string} tag @param {string} name
 */
const handler = (logs, tag, name) => (/** @type {any} */ e) => {
  const mods = `${e.shiftKey ? 'S' : ''}${e.ctrlKey ? 'C' : ''}${e.altKey ? 'A' : ''}${e.metaKey ? 'M' : ''}`;
  logs.log.push(`${tag} ${name} x=${e.x ?? 0} y=${e.y ?? 0} b=${e.button ?? -1} ${mods} ${e.key ?? ''}`);
  logs.trace.push(`${tag} ${name} ${tagOf(logs, e.target)} ${tagOf(logs, e.relatedTarget)}`);
  const stop =
    (tag === 'A' && (name === 'press' || name === 'focus' || name === 'blur' || (name === 'key' && e.key === 'Escape') || (name === 'pointermove' && e.shiftKey))) ||
    (tag === 'outer' && name === 'pointermove' && e.altKey) ||
    (tag === 'scroll' && name === 'scroll');
  if (stop) e.stopPropagation();
};

/** @param {Logs} logs */
const App = logs => () => {
  const shown = $signal($active(), true);
  logs.hide = () => $write(shown, false);
  $keys(handler(logs, 'root', 'keys'));
  $scrolls(handler(logs, 'root', 'scrolls'));
  /** @param {string} tag */
  const on = tag => ({
    ref: (/** @type {any} */ item) => void logs.tags.set(item, tag),
    onPress: handler(logs, tag, 'press'),
    onPointerMove: handler(logs, tag, 'pointermove'),
    onFocus: handler(logs, tag, 'focus'),
    onBlur: handler(logs, tag, 'blur'),
    onFocusIn: handler(logs, tag, 'focusin'),
    onFocusOut: handler(logs, tag, 'focusout'),
    onKey: handler(logs, tag, 'key'),
  });
  // The View is taller than its items: below them a point is over it alone.
  return (
    <View style={{ width: 200, height: 120, fontSize: 10, lineHeight: 2 }} {...on('outer')}>
      <Action text="A" style={{ height: 20 }} {...on('A')} />
      <Action text="B" style={{ height: 20 }} {...on('B')} />
      <Scroll ref={(/** @type {any} */ item) => void logs.tags.set(item, 'scroll')} style={{ height: 40 }} onScroll={handler(logs, 'scroll', 'scroll')}>
        {Array.from({ length: 10 }, (_, i) => <Label text={`row ${i}`} />)}
      </Scroll>
      <Action text="R" style={{ height: 20 }} hidden={() => !$read(shown)} {...on('R')} />
    </View>
  );
};

/** A, B, the Scroll and R, and each one's center on the page. @param {Document} doc */
function places(doc) {
  const outer = /** @type {any} */ (doc.root.first);
  const items = [outer.first, outer.first.next, outer.first.next.next, outer.first.next.next.next];
  return items.map(item => {
    let x = item.w / 2;
    let y = item.h / 2;
    for (let n = item; n !== null; n = n.parent) {
      doc.boxes.fix(n);
      x += n.x;
      y += n.y;
    }
    return { item, x, y };
  });
}

/**
 * The script: bursts (the worker's messages) of input on a Document; a step
 * may also act on its mode's view (`logs.hide`).
 * @type {((doc: Document, at: ReturnType<typeof places>, logs: Logs) => void)[][]}
 */
const SCRIPT = [
  // Presses bubble; A stops its own.
  [(doc, [a]) => void doc.press(a.x, a.y), (doc, [, b]) => void doc.press(b.x, b.y), doc => doc.release(0, 0)],
  // Focus and blur, with stops in A's handlers: every later one is heard.
  [(doc, [a]) => doc.focus(a.item), (doc, [, b]) => doc.focus(b.item), (doc, [a]) => doc.focus(a.item)],
  [(doc, [, b]) => doc.focus(b.item)],
  [doc => doc.focus(null)],
  // Keys: the focused item and its ancestors, then the root's $keys.
  [(doc, [a]) => doc.focus(a.item), doc => void doc.key('Escape'), doc => void doc.key('x', false, { ctrlKey: true }), doc => void doc.key('y', true)],
  // Scrolls: $scrolls first; the Scroll's stop cannot reach it.
  [(doc, [, , s]) => void doc.wheel(s.x, s.y, 20)],
  [(doc, [, , s]) => void doc.wheel(s.x, s.y, 20)],
  // Moves: over the View alone (below its items), then into A with Shift (A stops it), in one burst.
  [doc => void doc.move(150, 110), (doc, [a]) => void doc.move(a.x, a.y, { shiftKey: true })],
  [(doc, [a]) => void doc.move(a.x, a.y), (doc, [a]) => void doc.move(a.x + 1, a.y, { shiftKey: true }), (doc, [, b]) => void doc.move(b.x, b.y, { altKey: true, button: 2 })],
  // The latest move's modifiers and button win.
  [(doc, [, b]) => void doc.move(b.x, b.y, { button: 0 }), (doc, [, b]) => void doc.move(b.x + 1, b.y + 1, { ctrlKey: true, metaKey: true, button: 1 })],
  // Many dispatches in one burst.
  Array.from({ length: 120 }, (_, n) => (/** @type {Document} */ doc, /** @type {any} */ [a, b]) => void (n % 2 === 0 ? doc.press(a.x, a.y) : doc.press(b.x, b.y))),
  // The focused item is hidden: it hears blur, then focusout bubbles, relatedTarget null.
  [(doc, [, , , r]) => doc.focus(r.item)],
  [(_doc, _at, logs) => logs.hide()],
];

/** Whether a burst has superseding events. */
const SUPERSEDES = [false, false, false, false, false, true, true, true, true, true, false, false, false];

/**
 * The direct mode's targets and relatedTargets, by burst, as the README
 * orders them: the old item's blur before the new one's focus, each naming
 * the other; $scrolls before the Scroll's own scroll; blur when the focused
 * item goes.
 * @type {Record<number, string[]>}
 */
const TRACE = {
  // B (focused by the presses) to A, to B, to A.
  1: [
    ...['B blur B A', 'B focusout B A', 'outer focusout B A', 'A focus A B', 'A focusin A B', 'outer focusin A B'],
    ...['A blur A B', 'A focusout A B', 'outer focusout A B', 'B focus B A', 'B focusin B A', 'outer focusin B A'],
    ...['B blur B A', 'B focusout B A', 'outer focusout B A', 'A focus A B', 'A focusin A B', 'outer focusin A B'],
  ],
  2: ['A blur A B', 'A focusout A B', 'outer focusout A B', 'B focus B A', 'B focusin B A', 'outer focusin B A'],
  3: ['B blur B null', 'B focusout B null', 'outer focusout B null'],
  5: ['root scrolls scroll -', 'scroll scroll scroll -'],
  11: ['B blur B R', 'B focusout B R', 'outer focusout B R', 'R focus R B', 'R focusin R B', 'outer focusin R B'],
  12: ['R blur R null', 'R focusout R null', 'outer focusout R null'],
};

/** Whether `part` is `whole` with entries left out, in order. @param {string[]} part @param {string[]} whole */
const within = (part, whole) => {
  let i = 0;
  for (const entry of part) {
    while (i < whole.length && whole[i] !== entry) i++;
    if (i++ >= whole.length) return false;
  }
  return true;
};

describe('ren-canv event parity', () => {
  it('hears the same events in worker mode as in direct mode', { timeout: 30000 }, async t => {
    const dl = logs();
    const wl = logs();
    const direct = new Document(mono, { width: 200, height: 200 });
    const dispose = render(App(dl), direct);
    const remote = new Document(mono, { width: 200, height: 200 });
    const { port1, port2 } = new MessageChannel();
    const connection = connect(port2, remote, remote.root, { schedule: 'now' });
    const session = serve(App(wl), { port: port1, root: $root('app') });
    closeAfter(t, () => {
      connection.close();
      session.close();
      port1.close();
      port2.close();
      dispose();
      direct.close();
      remote.close();
    });
    await connection.idle();
    direct.present();
    remote.present();
    const directAt = places(direct);
    const remoteAt = places(remote);
    assert.deepEqual(remoteAt.map(p => [p.x, p.y]), directAt.map(p => [p.x, p.y]), 'one layout');
    for (let b = 0; b < SCRIPT.length; b++) {
      for (const step of SCRIPT[b]) step(direct, directAt, dl);
      direct.present();
      for (const step of SCRIPT[b]) step(remote, remoteAt, wl);
      // A step on the worker's view: its update applies, then the events it causes come back.
      await connection.idle();
      await connection.idle();
      const expected = dl.log.splice(0);
      const heard = wl.log.splice(0);
      const trace = dl.trace.splice(0);
      wl.trace.length = 0;
      if (TRACE[b] !== undefined) assert.deepEqual(trace, TRACE[b], `burst ${b}: the direct mode's order and targets`);
      assert.ok(expected.length > 0, `burst ${b} is heard`);
      if (!SUPERSEDES[b]) assert.deepEqual(heard, expected, `burst ${b}`);
      else {
        assert.ok(within(heard, expected), `burst ${b}: ${JSON.stringify(heard)} within ${JSON.stringify(expected)}`);
        assert.equal(heard.at(-1), expected.at(-1), `burst ${b} ends with the latest`);
      }
    }
  });
});
