// The body of test/nonfinite.test.js, run in a worker thread so a frame
// that loops can be ended from outside: each case gives one numeric prop or
// portable style field a value that is no finite length (NaN, ±Infinity,
// 1e39, past what Taffy's f32 holds, or a 40-digit percent) on a Document
// that draws, among rounded siblings (whose damage the painter compares),
// laid out in this thread or, with `workerData.remote`, through a layout
// served on a port (`serveLayout`, `remoteLayout`: the boxes come back as
// a worker's records, placed by `apply`).
// Before each case it posts the case to the parent, which ends the thread
// when one takes too long; after it, what broke, if anything: a command
// number that is not finite, or a throw.

import { parentPort, workerData } from 'node:worker_threads';
import { $root, $signal, $read, $write } from 'rrx-core';
import { View, Label, Edit, Action, Scroll } from 'ren-core';
import { jsx } from 'ren-core/jsx-runtime';
import { Document, render, loadLayout, remoteLayout, serveLayout } from 'ren-canv';

await loadLayout();

const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };

/** A Document that draws, so each frame is compared with the last for its damage. */
class Probe extends Document {
  get drawing() {
    return true;
  }
  draw() {}
}

/** The values that are no finite length. */
const VALUES = /** @type {[string, any][]} */ ([
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['1e39', 1e39],
  ['1e308', 1e308],
]);
/** A percent past any float's range once read. */
const PERCENT = '1'.repeat(40) + '%';

/** Style fields that take a number, and those that also take a percent. */
const NUMBERS = ['gap', 'columnGap', 'rowGap', 'padding', 'margin', 'aspectRatio', 'zIndex', 'grow', 'shrink', 'opacity', 'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'radius', 'rotate', 'skewX', 'skewY', 'scale', 'column', 'row'];
const LENGTHS = ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'top', 'right', 'bottom', 'left', 'inset'];
/** Text fields, on a Label. */
const TEXT = ['fontSize', 'fontWeight', 'lineHeight'];
/** Primitive props that take a number. */
const PROPS = /** @type {[string, string][]} */ ([
  ['View', 'gap'],
  ['View', 'pad'],
  ['View', 'width'],
  ['View', 'height'],
  ['View', 'min'],
  ['Label', 'size'],
  ['Label', 'lines'],
  ['Edit', 'lines'],
  ['Edit', 'autosize'],
  ['Edit', 'size'],
]);

/**
 * Every case: `[name, kind, props given the bad value]`.
 * @type {[string, string, () => Record<string, any>][]}
 */
const cases = [];
for (const [label, bad] of VALUES) {
  for (const key of [...NUMBERS, ...LENGTHS]) cases.push([`View style.${key} ${label}`, 'View', () => ({ style: { [key]: bad } })]);
  for (const key of TEXT) cases.push([`Label style.${key} ${label}`, 'Label', () => ({ style: { [key]: bad } })]);
  cases.push([`View style.scale [${label}, 1] `, 'View', () => ({ style: { scale: [bad, 1] } })]);
  cases.push([`View style.translate [${label}, 0]`, 'View', () => ({ style: { translate: [bad, 0] } })]);
  cases.push([`View style.transformOrigin [${label}, 0]`, 'View', () => ({ style: { transformOrigin: [bad, 0], rotate: 30 } })]);
  cases.push([`View style.shadow ${label}`, 'View', () => ({ style: { shadow: { x: bad, y: bad, blur: bad, color: '#ff000000' } } })]);
  cases.push([`View style.radius [${label}, 0, 0, 0]`, 'View', () => ({ style: { radius: [bad, 0, 0, 0] } })]);
  cases.push([`View style.background linear ${label}`, 'View', () => ({ style: { background: { linear: bad, stops: [[0, '#ff0000'], [1, '#0000ff']] } } })]);
  cases.push([`View style.background stop ${label}`, 'View', () => ({ style: { background: { linear: 90, stops: [[bad, '#ff0000'], [1, '#0000ff']] } } })]);
  for (const [kind, prop] of PROPS) cases.push([`${kind} ${prop} ${label}`, kind, () => ({ [prop]: bad })]);
}
for (const key of LENGTHS) cases.push([`View style.${key} ${PERCENT.length}-digit percent`, 'View', () => ({ style: { [key]: PERCENT } })]);
cases.push([`View style.translate [percent, 0]`, 'View', () => ({ style: { translate: [PERCENT, 0] } })]);
cases.push([`View style.transformOrigin [percent, 0]`, 'View', () => ({ style: { transformOrigin: [PERCENT, 0], rotate: 30 } })]);

/** @type {Record<string, any>} */
const KINDS = { View, Label, Edit, Action, Scroll };

/** Whether a command holds a number that is not finite. @param {any[]} command */
const broken = command => command.some(v => typeof v === 'number' && !Number.isFinite(v));

const remote = workerData?.remote === true;
/** The layout served on a port, for the remote run. */
const channel = remote ? new MessageChannel() : null;
const stopServing = channel !== null ? serveLayout(/** @type {any} */ (channel.port2)) : null;

/** Presents a frame; laid out remotely, waits until its answer is painted. @param {Document} doc */
async function frame(doc) {
  doc.present();
  while (doc.boxes.engine.busy || doc.damage) {
    if (!doc.boxes.engine.busy) throw new Error('damage with no layout in flight');
    await new Promise(resolve => (doc.framed = resolve));
  }
  doc.framed = null;
}

/** @param {[string, string, () => Record<string, any>]} entry */
async function run([name, kind, bad]) {
  const layout = channel !== null ? remoteLayout(/** @type {any} */ (channel.port1)) : undefined;
  const doc = new Probe(mono, { width: 300, height: 200, layout });
  try {
    const root = $root('nonfinite');
    const on = $signal(root, false);
    const tick = $signal(root, 0);
    const given = bad();
    const good = { ...(kind === 'Label' ? { text: 'hello world' } : kind === 'Edit' ? { value: 'a\nb' } : {}), style: { background: '#ff0000', height: 20, radius: 4 } };
    /** @type {Record<string, any>} */
    const props = {};
    for (const key of new Set([...Object.keys(good), ...Object.keys(given)]))
      props[key] = () => {
        const value = $read(on) ? bad() : {};
        if (key === 'style') return { ...good.style, ...value.style };
        return key in value ? value[key] : /** @type {any} */ (good)[key];
      };
    render(
      () =>
        jsx(View, {
          style: { width: 300, height: 200 },
          children: [
            jsx(Label, { text: 'before', style: { radius: 3, background: '#00ff00' } }),
            jsx(View, { style: { radius: 2 }, children: jsx(KINDS[kind], props) }),
            jsx(Label, { text: () => `after ${$read(tick)}`, style: { background: '#0000ff', radius: 3 } }),
          ],
        }),
      doc,
      { root },
    );
    await frame(doc);
    $write(on, true);
    await frame(doc);
    const out = [];
    const first = doc.commands().filter(broken);
    if (first.length > 0) out.push(`${name}: ${JSON.stringify(first[0], (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))}`);
    for (let k = 1; k <= 3; k++) {
      $write(tick, k);
      await frame(doc);
    }
    $write(on, false);
    await frame(doc);
    const back = doc.commands().filter(broken);
    if (back.length > 0) out.push(`${name}, set back: ${JSON.stringify(back[0], (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))}`);
    return out;
  } catch (error) {
    return [`${name}: threw ${/** @type {Error} */ (error).message}`];
  } finally {
    doc.close();
    layout?.close();
  }
}

const from = /** @type {number} */ (workerData?.from ?? 0);
for (let i = from; i < cases.length; i++) {
  /** @type {any} */ (parentPort).postMessage({ index: i, name: cases[i][0] });
  const failures = await run(cases[i]);
  if (failures.length > 0) /** @type {any} */ (parentPort).postMessage({ failures });
}
stopServing?.();
channel?.port1.close();
/** @type {any} */ (parentPort).postMessage({ done: true, count: cases.length });
