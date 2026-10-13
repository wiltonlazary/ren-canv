// The accessibility mirror reads as the DOM ren-dom writes: the caller's
// meaning marks (ren-core's Meaning props) on each mirrored element, a
// container named by its `label`, and an element for a Shape marked with a
// role, so a radio group reads as a radiogroup of radios, tabs as a tablist
// of tabs, and decoration is left out.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyWindow } from 'happy-dom';
import { View, Label, Action, Shape } from 'ren-core';
import { $root, $signal, $read, $write } from 'rrx-core';
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

/** Every character is half its size wide. */
const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };

/** A Document attached to a canvas in a page, and its mirror's box. */
function setup() {
  const window = new Window();
  const canvas = window.document.createElement('canvas');
  window.document.body.appendChild(canvas);
  const doc = new Document(mono, { width: 300, height: 300 });
  return { doc, canvas, mirror: () => /** @type {any} */ (window.document.querySelector('[data-ren-aria]')) };
}

/** An element's role, name and states, as assistive technology reads them. @param {any} el */
const read = el => {
  /** @type {Record<string, string>} */
  const out = {};
  for (const a of el.attributes) if (a.name === 'role' || a.name.startsWith('aria-')) out[a.name] = a.value;
  return out;
};

describe('ren canv accessibility mirror: meaning marks', () => {
  it('reads a radio group as a radiogroup of radios, their checked state following', () => {
    const { doc, canvas, mirror } = setup();
    const root = $root('app');
    const size = $signal(root, 'm');
    render(() => (
      <View role="radiogroup" label="Size">
        {['s', 'm'].map(v => (
          <Action role="radio" aria-checked={() => String($read(size) === v)} selected={() => $read(size) === v} text={v} onPress={() => $write(size, v)} />
        ))}
      </View>
    ), doc, { root });
    const stop = attach(doc, canvas);
    const group = mirror().querySelector('[role=radiogroup]');
    assert.deepEqual(read(group), { role: 'radiogroup', 'aria-label': 'Size' }, 'the group named by its label');
    assert.deepEqual([...group.querySelectorAll('button')].map(read), [
      { role: 'radio', 'aria-checked': 'false' },
      { role: 'radio', 'aria-checked': 'true' },
    ], 'radios, checked as said; no aria-pressed beside a role');
    $write(size, 's');
    doc.present();
    assert.deepEqual([...group.querySelectorAll('button')].map(b => read(b)['aria-checked']), ['true', 'false']);
    stop();
    doc.close();
  });

  it("writes an item's dir on its element, and takes it away when unset, as the DOM's attribute", () => {
    const { doc, canvas, mirror } = setup();
    const root = $root('app');
    const dir = $signal(root, /** @type {string | null} */ ('rtl'));
    render(() => (
      <View role="region" label="Area" dir={() => /** @type {any} */ ($read(dir))}>
        <Label text="x" />
      </View>
    ), doc, { root });
    const stop = attach(doc, canvas);
    const region = mirror().querySelector('[role=region]');
    assert.equal(region.getAttribute('dir'), 'rtl');
    assert.equal(mirror().querySelectorAll('[dir]').length, 1, 'inherited below it, not written');
    $write(dir, null);
    doc.present();
    assert.equal(region.hasAttribute('dir'), false);
    stop();
    doc.close();
  });

  it('reads tabs as a tablist of tabs, the selected one marked', () => {
    const { doc, canvas, mirror } = setup();
    render(() => (
      <View role="tablist" aria-label="Sections" style={{ direction: 'row' }}>
        <Action role="tab" aria-selected text="One" aria-controls="one" />
        <Action role="tab" aria-selected={false} text="Two" label="2" aria-label="Second" />
      </View>
    ), doc);
    const stop = attach(doc, canvas);
    const list = mirror().querySelector('[role=tablist]');
    assert.deepEqual(read(list), { role: 'tablist', 'aria-label': 'Sections' });
    assert.deepEqual([...list.children].map(read), [
      { role: 'tab', 'aria-selected': 'true', 'aria-controls': 'one' },
      { role: 'tab', 'aria-selected': 'false', 'aria-label': 'Second' },
    ], 'an aria-label given wins over the label');
    stop();
    doc.close();
  });

  it('hides decoration, takes away a mark no longer given, and gives a marked Shape an element', () => {
    const { doc, canvas, mirror } = setup();
    const root = $root('app');
    const decor = $signal(root, true);
    const busy = $signal(root, false);
    render(() => (
      <View itemscope itemtype="Product">
        <Label aria-hidden={() => ($read(decor) ? 'true' : undefined)} text="★" />
        <Label itemprop="name" text="Lamp" />
        <Shape role={() => ($read(busy) ? 'status' : undefined)} label="Loading" shapes={[{ kind: 'oval', x: 0, y: 0, right: 10, bottom: 10, color: '#000' }]} style={{ width: 10, height: 10 }} />
      </View>
    ), doc, { root });
    const stop = attach(doc, canvas);
    const box = mirror();
    const [star, name] = [...box.querySelectorAll('p')];
    assert.equal(star.getAttribute('aria-hidden'), 'true', 'decoration out of the accessibility tree');
    assert.equal(name.getAttribute('itemprop'), 'name');
    const product = box.querySelector('[itemscope]');
    assert.equal(product.getAttribute('itemtype'), 'Product');
    assert.equal(product.getAttribute('itemscope'), '');
    assert.equal(box.querySelector('[role=status]'), null, 'an unmarked Shape has no element');
    $write(decor, false);
    $write(busy, true);
    doc.present();
    assert.equal(star.hasAttribute('aria-hidden'), false, 'the mark goes when it is no longer given');
    const status = box.querySelector('[role=status]');
    assert.ok(status !== null, 'a Shape marked with a role: an element');
    assert.equal(status.getAttribute('aria-label'), 'Loading');
    assert.equal(status.parentNode, product, 'in its place');
    stop();
    doc.close();
  });
});
