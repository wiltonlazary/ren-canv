// Typefaces and directions on a canvas: a style's `fontFamily` set in the
// typeface given for it, each cluster a typeface lacks in the first
// fallback that has all of it (Faces), and right-to-left runs drawn in their
// visual places, the caret, the hit tests and the selection following them.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { View, Label, Edit } from 'ren-core';
import { Document, Faces, Sfnt, render, loadLayout } from 'ren-canv';
import { RTL, SLOT } from 'ren-canv/backend';

await loadLayout();

const dejavu = readFileSync(new URL('./fixtures/dejavu.ttf', import.meta.url));

/**
 * A font file with the given glyphs only (each code point's advance in
 * units of 1000 per em) and a missing glyph 500 wide: the tables Sfnt
 * reads (head, hhea, hmtx, a format 12 cmap).
 * @param {[number, number][]} glyphs
 */
function font(glyphs) {
  const count = glyphs.length + 1;
  const head = new DataView(new ArrayBuffer(54));
  head.setUint16(18, 1000);
  const hhea = new DataView(new ArrayBuffer(36));
  hhea.setInt16(4, 900);
  hhea.setInt16(6, -300);
  hhea.setUint16(34, count);
  const hmtx = new DataView(new ArrayBuffer(count * 4));
  hmtx.setUint16(0, 500);
  glyphs.forEach(([, advance], i) => hmtx.setUint16((i + 1) * 4, advance));
  const cmap = new DataView(new ArrayBuffer(28 + glyphs.length * 12));
  cmap.setUint16(2, 1);
  cmap.setUint16(4, 3);
  cmap.setUint16(6, 10);
  cmap.setUint32(8, 12);
  cmap.setUint16(12, 12);
  cmap.setUint32(24, glyphs.length);
  glyphs.forEach(([cp], i) => {
    cmap.setUint32(28 + i * 12, cp);
    cmap.setUint32(32 + i * 12, cp);
    cmap.setUint32(36 + i * 12, i + 1);
  });
  const tables = /** @type {[string, DataView][]} */ ([['cmap', cmap], ['head', head], ['hhea', hhea], ['hmtx', hmtx]]);
  let size = 12 + tables.length * 16;
  const at = tables.map(([, t]) => {
    const offset = size;
    size += (t.byteLength + 3) & ~3;
    return offset;
  });
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x10000);
  view.setUint16(4, tables.length);
  tables.forEach(([tag, t], i) => {
    for (let k = 0; k < 4; k++) out[12 + i * 16 + k] = tag.charCodeAt(k);
    view.setUint32(12 + i * 16 + 8, at[i]);
    view.setUint32(12 + i * 16 + 12, t.byteLength);
    out.set(new Uint8Array(t.buffer), at[i]);
  });
  return out;
}

/** A typeface with 中 (U+4E2D) 1000 wide and x 250 wide. */
const tiny = font([[0x78, 250], [0x4e2d, 1000]]);
const texts = (/** @type {Document} */ doc) => doc.commands().filter(c => c[0] === 'text');

/** Every character is half its size wide. */
const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };
const T = { fontSize: 10, lineHeight: 2 };

describe('ren canv typefaces', () => {
  it('measures each character in the first typeface that has it, and draws each piece in its own', () => {
    const faces = new Faces({ font: dejavu, fallback: [tiny] });
    const regular = new Sfnt(dejavu);
    const small = new Sfnt(tiny);
    assert.equal(faces.faces('abc', 0), null, 'the root typeface has them all');
    assert.deepEqual(faces.faces('a中b', 0), [1, 0, 2, 1 << SLOT, 3, 0], 'the fallback (slot 1) sets what the root lacks');
    assert.deepEqual(faces.faces('a中', 1), [1, 1, 2, 1 | (1 << SLOT)], 'bold carries over');
    assert.equal(faces.width('a中b', 16), regular.width('a', 16) + small.width('中', 16) + regular.width('b', 16));
    const doc = new Document(faces, { width: 300, height: 100 });
    render(() => <Label text={'a中b'} style={{ fontSize: 16 }} />, doc);
    doc.present();
    const drawn = texts(doc).map(c => [c[1], c[2], c[6]]);
    const a = regular.width('a', 16);
    assert.deepEqual(drawn, [['a', 0, 0], ['中', a, 1 << SLOT], ['b', a + 16, 0]]);
    doc.close();
  });

  it('keeps a cluster in the first typeface that has all of it, as Chrome falls back', () => {
    // tiny has x and U+0301 (a mark the root has too) and U+0951 (one it lacks).
    const faces = new Faces({ font: dejavu, fallback: [font([[0x78, 250], [0x301, 0], [0x951, 0], [0x1f1e6, 800]])] });
    assert.deepEqual(faces.faces('ax॑', 0), [1, 0, 3, 1 << SLOT], 'a mark the root lacks takes its base to the fallback');
    assert.deepEqual(faces.faces('a॑', 0), null, 'neither has the whole cluster: the root, its missing glyph');
    assert.deepEqual(faces.faces('中́', 0), null, 'a base the root lacks keeps a mark it has in the root');
    assert.deepEqual(faces.faces('x‍॑', 0), [3, 1 << SLOT], 'a joiner needs no glyph');
    assert.deepEqual(faces.faces('a\u{1f1e6}\u{1f1e6}\u{1f1e6}', 0), [1, 0, 7, 1 << SLOT], 'regional indicators in pairs');
  });

  it("sets a style's fontFamily in the typeface given for it, its children's too, the root one for others", () => {
    const faces = new Faces({ font: dejavu, families: { Tiny: tiny } });
    assert.equal(faces.typeface('"Tiny", sans-serif'), 1);
    assert.equal(faces.typeface('sans-serif, Tiny'), 0, 'a generic family first: the root face');
    assert.equal(faces.typeface('Other'), 0);
    const doc = new Document(faces, { width: 300, height: 100 });
    /** @type {any} */
    let label = null;
    render(() => (
      <View style={{ fontSize: 20, align: 'start' }}>
        <View style={{ fontFamily: "'Tiny', serif" }}>
          <Label ref={(/** @type {any} */ n) => (label = n)} text={'x中'} />
        </View>
        <Label text="x" style={{ fontFamily: 'Unknown, monospace' }} />
      </View>
    ), doc);
    doc.present();
    const drawn = texts(doc).map(c => [c[1], c[6]]);
    assert.deepEqual(drawn, [['x中', 1 << SLOT], ['x', 4]], 'inherited into the Label; a list naming none of them: the monospace face');
    assert.equal(label.getBoundingClientRect().width, ((250 + 1000) * 20) / 1000, 'measured in it');
    doc.close();
  });
});

describe('ren canv right-to-left text', () => {
  // Characters are 5 wide: 'abc ' 0-20, the Hebrew run 20-35, ' def' 35-55.
  const MIXED = 'abc אבג def';

  it('draws a right-to-left run in its visual place, as one piece from its right edge', () => {
    const doc = new Document(mono, { width: 300, height: 100 });
    render(() => <Label text={MIXED} style={T} />, doc);
    doc.present();
    assert.deepEqual(texts(doc).map(c => [c[1], c[2], c[6]]), [['abc ', 0, 0], ['אבג', 35, RTL], [' def', 35, 0]]);
    doc.close();
  });

  it('keeps Latin rows in one piece, digits in a right-to-left run in their own order', () => {
    const doc = new Document(mono, { width: 300, height: 100 });
    render(() => (
      <View style={T}>
        <Label text="plain words" />
        <Label text={'אב 12 ג'} />
      </View>
    ), doc);
    doc.present();
    // Right to left from the Hebrew to the Hebrew (the spaces beside the number with them): ' ג' at the left, then 12 left to right, then 'אב '.
    assert.deepEqual(texts(doc).map(c => [c[1], c[2], c[6]]), [['plain words', 0, 0], [' ג', 10, RTL], ['12', 10, 0], ['אב ', 35, RTL]]);
    doc.close();
  });

  it('maps a point to the offset of the character there, and selects a range as its visual pieces', () => {
    const doc = new Document(mono, { width: 300, height: 100, behavior: 'page' });
    /** @type {any} */
    let label = null;
    render(() => <Label ref={(/** @type {any} */ n) => (label = n)} text={MIXED} style={T} />, doc);
    doc.present();
    assert.equal(label.offsetAt(34, 5), 4, 'at the right edge of the run: its first character, א');
    assert.equal(label.offsetAt(31, 5), 5, 'between א and ב');
    assert.equal(label.offsetAt(21, 5), 7, 'at its left edge: past its last character');
    assert.equal(label.offsetAt(6, 5), 1, 'left to right before it');
    doc.selectText(label, 2, label, 5);
    doc.present();
    const selection = doc.commands().filter(c => c[0] === 'rect' && c[4] - c[2] === 20).map(c => [c[1], c[3]]);
    assert.deepEqual(selection, [[10, 20], [30, 35]], 'c and the space, then א at the right of the run');
    doc.close();
  });

  it("puts an Edit's caret where its offset shows: in a right-to-left run, from the run's right", () => {
    const doc = new Document(mono, { width: 300, height: 100 });
    /** @type {any} */
    let edit = null;
    render(() => <Edit ref={(/** @type {any} */ n) => (edit = n)} value={'abc אבג'} style={{ ...T, padding: 0, border: 0, width: 200 }} />, doc);
    doc.present();
    edit.focus();
    /** The caret's x: the 2 wide rect in the caret color. */
    const caret = () => {
      doc.present();
      const c = /** @type {any[]} */ (doc.commands().find(k => k[0] === 'rect' && k[3] - k[1] === 2));
      return c[1];
    };
    edit.setSelectionRange(5, 5);
    assert.equal(caret(), 30, 'before ב: at the right edge of ב, 5 left of the run\'s right');
    edit.setSelectionRange(4, 4);
    assert.equal(caret(), 35, "before א: the run's right edge");
    edit.setSelectionRange(7, 7);
    assert.equal(caret(), 20, "at the end, after ג: the run's left edge");
    edit.setSelectionRange(2, 2);
    assert.equal(caret(), 10);
    doc.close();
  });
});
