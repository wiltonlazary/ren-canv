// Fonts from a font file itself (TrueType or OpenType, `sfnt`): advance
// widths from its `hmtx` table through its `cmap`, ascent and descent from
// `hhea`, scaled by `head`'s units per em. The advances are plain
// JavaScript: the same numbers in node (tests) and in a browser, where a 2D
// canvas draws the same face with kerning and the optional ligatures off,
// so what is drawn matches what was measured.
// Characters the font has no glyph for measure as its missing glyph. Text
// a shaper sets otherwise (shape.js: joined scripts, clusters, marks) is
// measured as its shaped glyphs.

import { down64 } from './units.js';
import { complex, shaper, shapeText } from './shape.js';
import { demand } from './harfbuzz.js';
import { rtl } from './bidi.js';

/** @typedef {import('./shape.js').Shaped} Shaped */

/** Cached widths per size are dropped past this many strings. */
const LIMIT = 4096;

/**
 * The sizes measures are cached at. The caches' contract: widths and
 * heights are kept by the size text is set at (`sized`, a 64th), so sizes
 * that set the same share an entry; past SIZES sizes, the least recently
 * measured goes (a pure cache: nothing holds an entry past a call, and a
 * size measured again is measured anew). A size animated through many
 * values so holds at most SIZES of each.
 */
const SIZES = 64;

/**
 * The entry of `key` in `map`, made when missing, moved last (the most
 * recently used); past SIZES entries, the first (the least recently used)
 * goes. Flow's CanvasFonts bounds its widths by size the same way.
 * @template K, T @param {Map<K, T>} map @param {K} key @param {() => T} make
 */
export const recent = (map, key, make) => {
  let value = map.get(key);
  if (value !== undefined) map.delete(key);
  else {
    if (map.size >= SIZES) map.delete(/** @type {K} */ (map.keys().next().value));
    value = make();
  }
  map.set(key, value);
  return value;
};

/** The Fonts of a font file (ren-canv's `Fonts` contract). */
export class Sfnt {
  /** @param {ArrayBuffer | Uint8Array} bytes */
  constructor(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    /** @type {Map<string, number>} */
    const tables = new Map();
    const count = view.getUint16(4);
    for (let i = 0; i < count; i++) {
      const at = 12 + i * 16;
      const tag = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
      tables.set(tag, view.getUint32(at + 8));
    }
    const need = (/** @type {string} */ tag) => {
      const at = tables.get(tag);
      if (at === undefined) throw new Error(`REN canv: the font has no ${tag} table`);
      return at;
    };
    const head = need('head');
    const hhea = need('hhea');
    this.units = view.getUint16(head + 18);
    this.ascender = view.getInt16(hhea + 4);
    this.descender = view.getInt16(hhea + 6);
    const metrics = view.getUint16(hhea + 34);
    // Advances: one per long metric; the glyphs after the last share its advance.
    const hmtx = need('hmtx');
    this.advances = new Uint16Array(metrics);
    for (let i = 0; i < metrics; i++) this.advances[i] = view.getUint16(hmtx + i * 4);
    /** Glyph ids by code point. @type {Map<number, number>} */
    this.glyphs = new Map();
    /** The large cmap groups, resolved on demand: [first code, last code, first glyph]. @type {[number, number, number][] | undefined} */
    this.ranges = undefined;
    this.cmap(view, need('cmap'));
    /** Widths of strings measured at a size, by set size (`sized`), the least recently used first. @type {Map<number, Map<string, number>>} */
    this.sizes = new Map();
    /** The set size last measured and its widths: the common case skips reordering `sizes`. */
    this.last = NaN;
    /** @type {Map<string, number>} */
    this.known = new Map();
    /** Per code point advance in font units, cached. @type {Map<number, number>} */
    this.units1 = new Map();
    /** Ascent and descent by set size, the least recently used first. @type {Map<number, { ascent: number, descent: number }>} */
    this.heights = new Map();
    /** The file's bytes, which a shaper sets glyphs from. */
    this.bytes = data;
    /** The shaper's handle of this typeface (-1: not made yet), and the shaper it is of. */
    this.handle = -1;
    /** @type {import('./shape.js').Shaper | null} */
    this.by = null;
    /** Shaped texts, left to right and right to left (`shaped`). @type {[Map<string, Shaped>, Map<string, Shaped>]} */
    this.shapes = [new Map(), new Map()];
  }

  /**
   * `text` set in this typeface's glyphs by the shaper (shape.js), in
   * font units: null when no shaper changes it (`complex`), or there is
   * none. A right-to-left piece (`rtl`) lays its runs from the right.
   * Cached per text and direction.
   * @param {string} text @param {boolean} [rtl]
   * @returns {Shaped | null}
   */
  shaped(text, rtl = false) {
    if (!complex(text)) return null;
    demand();
    const by = shaper();
    if (by !== this.by) this.rebind();
    if (by === null) return null;
    if (this.handle < 0) this.handle = by.face(this.bytes);
    const cache = this.shapes[rtl ? 1 : 0];
    let found = cache.get(text);
    if (found === undefined) {
      found = shapeText(by, this.handle, text, rtl);
      if (cache.size >= LIMIT) cache.clear();
      cache.set(text, found);
    }
    return found;
  }

  /** Follows the shaper set (`useShaper`): what was measured or shaped by another is measured again. */
  rebind() {
    this.by = shaper();
    this.handle = -1;
    this.shapes[0].clear();
    this.shapes[1].clear();
    this.sizes.clear();
    this.last = NaN;
    this.known = new Map();
  }

  /**
   * The caret at each UTF-16 offset of `text` at `size`, from its start
   * edge (Shaped's `carets`, scaled): null when the text is not shaped,
   * where a caret is the width of the text before it.
   * @param {string} text @param {number} size @param {boolean} [rtl]
   * @returns {Float64Array | null}
   */
  carets(text, size, rtl = false) {
    const shaped = this.shaped(text, rtl);
    if (shaped === null) return null;
    const set = this.sized(size);
    const units = this.units;
    const c = shaped.carets;
    const out = new Float64Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = (c[i] * set) / units;
    return out;
  }

  /** Reads the best Unicode subtable of `cmap`: format 12 (all planes), else 4 (the BMP). @param {DataView} view @param {number} cmap */
  cmap(view, cmap) {
    const n = view.getUint16(cmap + 2);
    let four = -1;
    let twelve = -1;
    for (let i = 0; i < n; i++) {
      const platform = view.getUint16(cmap + 4 + i * 8);
      const encoding = view.getUint16(cmap + 6 + i * 8);
      const at = cmap + view.getUint32(cmap + 8 + i * 8);
      const format = view.getUint16(at);
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      if (!unicode) continue;
      if (format === 12) twelve = at;
      else if (format === 4 && four < 0) four = at;
    }
    const glyphs = this.glyphs;
    if (twelve >= 0) {
      const groups = view.getUint32(twelve + 12);
      for (let g = 0; g < groups; g++) {
        const at = twelve + 16 + g * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        const id = view.getUint32(at + 8);
        // Large ranges are resolved on demand (see `glyph`); keep the groups.
        if (end - start < 4096) for (let c = start; c <= end; c++) glyphs.set(c, id + c - start);
        else (this.ranges ??= []).push([start, end, id]);
      }
      return;
    }
    if (four < 0) throw new Error('REN canv: the font has no Unicode cmap');
    const segs = view.getUint16(four + 6) / 2;
    const ends = four + 14;
    const starts = ends + segs * 2 + 2;
    const deltas = starts + segs * 2;
    const offsets = deltas + segs * 2;
    for (let s = 0; s < segs; s++) {
      const end = view.getUint16(ends + s * 2);
      const start = view.getUint16(starts + s * 2);
      const delta = view.getInt16(deltas + s * 2);
      const offset = view.getUint16(offsets + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let id;
        if (offset === 0) id = (c + delta) & 0xffff;
        else {
          id = view.getUint16(offsets + s * 2 + offset + (c - start) * 2);
          if (id !== 0) id = (id + delta) & 0xffff;
        }
        if (id !== 0) glyphs.set(c, id);
      }
    }
  }

  /** The glyph id of a code point (0, the missing glyph, when the font has none). @param {number} code */
  glyph(code) {
    const id = this.glyphs.get(code);
    if (id !== undefined) return id;
    if (this.ranges !== undefined) for (const [start, end, first] of this.ranges) if (code >= start && code <= end) return first + code - start;
    return 0;
  }

  /** A code point's advance in font units. @param {number} code */
  advance(code) {
    let a = this.units1.get(code);
    if (a === undefined) {
      const id = this.glyph(code);
      const advances = this.advances;
      a = advances[Math.min(id, advances.length - 1)];
      this.units1.set(code, a);
    }
    return a;
  }

  /**
   * The size glyphs are set at for a font size: down to a 64th of a pixel,
   * as FreeType takes a size in 26.6 fixed point and Chrome's text is set
   * (10.4px text is as wide as 10.390625px; a line box keeps the size).
   * @param {number} size
   */
  sized(size) {
    return down64(size);
  }

  /** The advance width of `text` at `size` (set at `sized(size)`). @param {string} text @param {number} size */
  width(text, size) {
    if (text.length === 0) return 0;
    if (shaper() !== this.by) this.rebind();
    const set = this.sized(size);
    let known = this.known;
    if (set !== this.last) {
      known = this.known = recent(this.sizes, set, () => new Map());
      this.last = set;
    }
    const cached = known.get(text);
    if (cached !== undefined) return cached;
    let units = 0;
    let other = false;
    for (const char of text) {
      const cp = /** @type {number} */ (char.codePointAt(0));
      units += this.advance(cp);
      if (cp >= 0x300 || cp === 0xad) other = true;
    }
    // Text a shaper sets otherwise is as wide as its glyphs.
    const shaped = other ? this.shaped(text, rtl(text)) : null;
    if (shaped !== null) units = shaped.advance;
    const width = (units * set) / this.units;
    if (known.size >= LIMIT) known.clear();
    known.set(text, width);
    return width;
  }

  /** The ascent and descent at `size` (set at `sized(size)`), both positive (the font's `hhea`). @param {number} size */
  metrics(size) {
    const set = this.sized(size);
    return recent(this.heights, set, () => ({ ascent: (this.ascender * set) / this.units, descent: (-this.descender * set) / this.units }));
  }

  close() {
    this.sizes.clear();
    this.heights.clear();
    this.last = NaN;
    this.known = new Map();
  }
}
