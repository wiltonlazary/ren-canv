// Shaping: text whose script or marks a shaper sets otherwise than by the
// typeface's advances (shape.js `complex`) is measured, drawn, hit and
// selected as its shaped glyphs (HarfBuzz's by default, loaded on demand
// in node): Arabic letters joined and lam-alef as one glyph, marks placed on
// their bases, Devanagari in a fallback typeface, carets by grapheme
// cluster (a ligature's advance shared among those it holds); Latin keeps
// the advances, kerning and ligatures off as the DOM's text is set. The
// shaper is replaceable (`useShaper`), and a layout worker lays shaped text
// out as the thread does.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { View, Label, Edit } from 'ren-core';
import { Document, Faces, Sfnt, render, loadLayout, loadShaper, useShaper, remoteLayout, serveLayout } from 'ren-canv';
import { RTL, SLOT } from 'ren-canv/backend';
import { shaper, complex, itemize } from '../src/shape.js';
import { Face, Runs } from '../src/text.js';
import { closeAfter } from './fixtures/after.js';

await loadLayout();
await loadShaper();

const dejavu = readFileSync(new URL('./fixtures/dejavu.ttf', import.meta.url));
const devanagari = readFileSync(new URL('./fixtures/noto-devanagari.ttf', import.meta.url));
const sfnt = new Sfnt(dejavu);
/** The width of text by the typeface's advances alone, at 16 px. @param {Sfnt} s @param {string} text */
const advances = (s, text) => ([...text].reduce((w, c) => w + s.advance(/** @type {number} */ (c.codePointAt(0))), 0) * 16) / s.units;
const texts = (/** @type {Document} */ doc) => doc.commands().filter(c => c[0] === 'text');

describe('ren canv shaping', () => {
  it('joins Arabic letters: their joined forms, lam-alef as one glyph, at the joined width', () => {
    const text = 'سلام';
    const shaped = /** @type {import('../src/shape.js').Shaped} */ (sfnt.shaped(text, true));
    assert.ok(shaped !== null);
    assert.equal(shaped.count, 3, 'seen, lam-alef, meem');
    const isolated = [...text].map(c => sfnt.glyph(/** @type {number} */ (c.codePointAt(0))));
    // From the left: meem (alone after alef, which joins nothing after it), the lam-alef ligature, initial seen.
    assert.equal(shaped.ids[0], isolated[3], 'meem isolated');
    assert.notEqual(shaped.ids[2], isolated[0], 'seen in its initial form');
    const house = /** @type {import('../src/shape.js').Shaped} */ (sfnt.shaped('بيت', true));
    const alone = [...'بيت'].map(c => sfnt.glyph(/** @type {number} */ (c.codePointAt(0))));
    assert.deepEqual([...house.ids].map((id, i) => id !== alone[2 - i]), [true, true, true], 'final teh, medial yeh, initial beh');
    assert.ok(!isolated.includes(shaped.ids[1]), 'lam and alef as one ligature');
    assert.equal(sfnt.width(text, 16), (shaped.advance * 16) / sfnt.units);
    assert.notEqual(sfnt.width(text, 16), advances(sfnt, text), 'not the isolated letters\' advances');
    assert.equal(sfnt.shaped('لا', true)?.count, 1, 'lam-alef alone: one glyph');
  });

  it('leaves Latin to the advances, with no kerning or optional ligature, as the DOM sets it', () => {
    for (const text of ['office', 'AV Wa', 'Ünïcødé ÿ', 'Ελληνικά Кириллица', 'שלום'])
      assert.equal(complex(text), false, `${text} is not shaped`);
    assert.equal(sfnt.shaped('office'), null);
    assert.equal(sfnt.width('office AV', 16), advances(sfnt, 'office AV'), 'ffi and AV at their advances');
    assert.equal(complex('é'), true, 'a mark is');
    assert.equal(complex('a­b'), true, 'a soft hyphen is: hidden');
    assert.equal(sfnt.width('a­b', 16), advances(sfnt, 'ab'), 'the soft hyphen takes no room');
  });

  it('places marks on their bases, and keeps a caret off the inside of a cluster', () => {
    const q = /** @type {import('../src/shape.js').Shaped} */ (sfnt.shaped('q́'));
    const base = sfnt.advance(0x71);
    assert.equal(q.count, 2);
    assert.ok(q.xs[1] < base, `the acute over the q (${q.xs[1]} < ${base})`);
    assert.deepEqual([...q.carets], [0, 0, base], 'no caret between the q and its mark');
    const kasra = /** @type {import('../src/shape.js').Shaped} */ (sfnt.shaped('بِ', true));
    assert.ok([...kasra.ys].some(y => y < 0), 'the kasra below the beh');
    assert.equal(sfnt.width('בָּ', 16), advances(sfnt, 'ב'), 'Hebrew points take no room');
  });

  it('runs text by script, neutrals with the run before them', () => {
    assert.deepEqual(itemize('abc سلام def'), [0, 4, 4, 9, 9, 12]);
    assert.deepEqual(itemize('नमस्ते, Hi!'), [0, 8, 8, 11]);
    assert.deepEqual(itemize('123 سلام'), [0, 8], 'leading neutrals join the first run');
  });

  it('draws, hits and selects Arabic by its clusters: a ligature shared among its letters', () => {
    const fonts = new Faces({ font: dejavu });
    const doc = new Document(fonts, { width: 300, height: 100 });
    /** @type {any} */
    let label = null;
    render(() => (
      <View style={{ align: 'start' }}>
        <Label ref={(/** @type {any} */ n) => (label = n)} text={'سلام'} style={{ fontSize: 16 }} />
      </View>
    ), doc);
    doc.present();
    const width = fonts.width('سلام', 16);
    const drawn = texts(doc);
    assert.equal(drawn.length, 1);
    assert.deepEqual([drawn[0][1], drawn[0][2], drawn[0][6]], ['سلام', width, RTL], 'one right-to-left piece, x its right edge');
    assert.ok(Math.abs(label.getBoundingClientRect().width - width) < 1 / 64, 'laid out at the joined width');
    // The carets: seen at the right, then the ligature's two halves, then meem.
    const carets = /** @type {Float64Array} */ (fonts.offsets('سلام', 16));
    const lig = carets[3] - carets[1];
    assert.ok(Math.abs(carets[2] - carets[1] - lig / 2) < 1e-9, 'lam and alef each half the ligature');
    const top = label.getBoundingClientRect().top + 8;
    assert.equal(label.offsetAt(width - carets[2] + 1, top), 2, 'a point by the middle of the ligature: between lam and alef');
    doc.selectText(label, 1, label, 2);
    doc.present();
    const rects = doc.commands().filter(c => c[0] === 'rect');
    const sel = rects.find(c => Math.abs(c[3] - c[1] - lig / 2) < 0.01);
    assert.ok(sel !== undefined, `lam selected as half the ligature: ${JSON.stringify(rects)}`);
    assert.ok(Math.abs(sel[3] - (width - carets[1])) < 1e-6, 'from the right of seen');
    doc.close();
  });

  it('gives styled runs the carets of each run shaped on its own', () => {
    const fonts = new Faces({ font: dejavu });
    const whole = /** @type {Float64Array} */ (new Face(fonts, 16, 0).offsets('سلام', 0));
    const one = /** @type {Float64Array} */ (new Runs(fonts, [{ start: 0, end: 4, size: 16, face: 0 }]).offsets('سلام', 0));
    assert.deepEqual([...one], [...whole], 'one run: the text\'s carets');
    const two = /** @type {Float64Array} */ (new Runs(fonts, [{ start: 0, end: 2, size: 16, face: 0 }, { start: 2, end: 4, size: 20, face: 0 }]).offsets('سلام', 0));
    const first = /** @type {Float64Array} */ (fonts.offsets('سل', 16));
    const second = /** @type {Float64Array} */ (fonts.offsets('ام', 20));
    assert.deepEqual([...two], [first[0], first[1], first[2] + second[0], first[2] + second[1], first[2] + second[2]]);
    assert.equal(new Runs(fonts, [{ start: 0, end: 5, size: 16, face: 0 }]).offsets('hello', 0), null, 'Latin: none');
  });

  it("puts an Edit's caret in Arabic at its cluster's edge", () => {
    const fonts = new Faces({ font: dejavu });
    const doc = new Document(fonts, { width: 300, height: 100 });
    /** @type {any} */
    let edit = null;
    render(() => <Edit ref={(/** @type {any} */ n) => (edit = n)} value={'سلام'} style={{ fontSize: 16, padding: 0, border: 0, width: 200 }} />, doc);
    doc.present();
    edit.focus();
    const carets = /** @type {Float64Array} */ (fonts.offsets('سلام', 16));
    const width = carets[4];
    for (const k of [0, 1, 2, 3]) {
      edit.setSelectionRange(k, k);
      doc.present();
      const c = /** @type {any[]} */ (doc.commands().find(k => k[0] === 'rect' && k[3] - k[1] === 2));
      assert.ok(Math.abs(c[1] + 1 - (width - carets[k])) <= 1, `the caret at ${k} by ${width - carets[k]}, drawn at ${c[1]}`);
    }
    doc.close();
  });

  it('shapes a fallback typeface\'s piece in it: Devanagari after Latin', () => {
    const fonts = new Faces({ font: dejavu, fallback: [devanagari] });
    const doc = new Document(fonts, { width: 400, height: 100 });
    render(() => <Label text={'Hi नमस्ते'} style={{ fontSize: 16 }} />, doc);
    doc.present();
    const drawn = texts(doc).map(c => [c[1], c[2], c[6]]);
    const noto = new Sfnt(devanagari);
    const hi = sfnt.width('Hi ', 16);
    assert.deepEqual(drawn, [['Hi ', 0, 0], ['नमस्ते', hi, 1 << SLOT]]);
    const shaped = /** @type {import('../src/shape.js').Shaped} */ (noto.shaped('नमस्ते'));
    assert.ok(shaped.count < 'नमस्ते'.length, 'the conjunct and the vowel signs combined');
    assert.equal(fonts.width('Hi नमस्ते', 16), hi + noto.width('नमस्ते', 16));
    assert.notEqual(noto.width('नमस्ते', 16), advances(noto, 'नमस्ते'));
    doc.close();
  });

  it('is replaceable: useShaper sets another shaper, or none (the advances)', () => {
    const own = shaper();
    /** @type {string[]} */
    const asked = [];
    try {
      useShaper({
        face: () => 7,
        shape: (face, text, start, end, rtl, features) => {
          asked.push(`${face} ${text.slice(start, end)} ${rtl} ${features.liga}`);
          const n = end - start;
          return { count: n, ids: new Uint32Array(n).fill(1), advances: new Int32Array(n).fill(1000), dx: new Int32Array(n), dy: new Int32Array(n), clusters: Uint32Array.from({ length: n }, (_, i) => start + i) };
        },
      });
      const s = new Sfnt(dejavu);
      assert.equal(s.width('سلام', 16), (4 * 1000 * 16) / s.units);
      assert.deepEqual(asked, ['7 سلام true 0']);
      useShaper(null);
      assert.equal(s.width('سلام', 16), advances(s, 'سلام'), 'no shaper: the advances');
    } finally {
      useShaper(own);
    }
    assert.equal(sfnt.width('سلام', 16), ((/** @type {any} */ (sfnt.shaped('سلام', true))).advance * 16) / sfnt.units);
  });

  it('lays shaped text out in a layout worker as in the thread', { timeout: 30000 }, async t => {
    const channel = new MessageChannel();
    const stop = serveLayout(channel.port2);
    const layout = remoteLayout(channel.port1);
    const fonts = new Faces({ font: dejavu, fallback: [devanagari] });
    const local = new Document(fonts, { width: 300, height: 200 });
    const remote = new Document(fonts, { width: 300, height: 200, layout });
    closeAfter(t, () => {
      local.close();
      remote.close();
      layout.close();
      stop();
      channel.port1.close();
    });
    const view = () => (
      <View style={{ fontSize: 16, align: 'start', gap: 4 }}>
        <Label text={'سلام عليكم يا صديقي'} />
        <Label text={'नमस्ते दुनिया'} />
        <View style={{ width: 90 }}>
          <Label wrap text={'بِسْمِ الرَّحْمٰنِ الرَّحِيمِ'} />
        </View>
      </View>
    );
    render(view, local);
    render(view, remote);
    while (remote.boxes.engine.busy || remote.damage) await new Promise(resolve => (remote.framed = resolve));
    remote.framed = null;
    assert.deepEqual(remote.commands(), local.commands(), 'the same frame');
    const first = /** @type {any[]} */ (texts(local).find(c => c[1] === 'سلام عليكم يا صديقي'));
    assert.equal(first[2], fonts.width('سلام عليكم يا صديقي', 16), 'at its shaped width');
  });
});
