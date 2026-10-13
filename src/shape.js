// Shaping: text set in a typeface's glyphs where its script or its marks
// change them (Arabic letters joined, Indic clusters reordered and
// conjoined, marks placed on their bases, required ligatures such as
// lam-alef, default ignorables hidden). This is the neutral boundary: a
// Shaper is anything that sets a run of one script in a font file's glyphs
// (src/harfbuzz.js is the default, set by `loadShaper`); `useShaper` sets
// another, or none. Text no shaper changes (Latin, Greek, Cyrillic, CJK,
// Hebrew without points, ...) is never shaped: it is measured and drawn by
// the typeface's own advances (Sfnt), as it is without a shaper.
//
// Shaped text keeps kerning and the optional ligatures off (common,
// discretionary, historical and contextual), as ren-dom sets DOM text
// (`font-kerning: none`, `font-variant-ligatures: none`), so the canvases
// and the DOM set the same glyphs at the same widths; the features a script
// requires stay on.

import { rtl } from './bidi.js';

/**
 * Glyphs a Shaper set, in visual order (left to right), in the typeface's
 * units per em: each glyph's id, advance, offset from its pen position (y
 * up) and the UTF-16 index of its cluster's first character in the text
 * given.
 * @typedef {object} Glyphs
 * @property {number} count
 * @property {Uint32Array} ids
 * @property {Int32Array} advances
 * @property {Int32Array} dx
 * @property {Int32Array} dy
 * @property {Uint32Array} clusters
 */

/**
 * What sets text in glyphs.
 * @typedef {object} Shaper
 * @property {(bytes: Uint8Array) => number} face A handle of a font file's typeface, made once per file content.
 * @property {(face: number, text: string, start: number, end: number, rtl: boolean, features: Readonly<Record<string, number>>) => Glyphs} shape Sets text[start, end), a run of one script, in the typeface's glyphs, in a direction, with OpenType features on (1) or off (0); the text around the run is its context.
 */

/** The features shaped text keeps off: kerning and the optional ligatures. */
export const FEATURES = Object.freeze({ kern: 0, liga: 0, clig: 0, dlig: 0, hlig: 0, calt: 0 });

/** @type {Shaper | null} */
let current = null;
/** Whether a shaper was set (or none chosen): the default one is then not loaded on demand. */
let chosen = false;

/**
 * Sets what shapes text: a Shaper, or null for none (text is then set by
 * the typefaces' advances). `loadShaper` sets HarfBuzz's. Text already
 * measured keeps its measures until it is laid out again.
 * @param {Shaper | null} shaper
 */
export function useShaper(shaper) {
  current = shaper;
  chosen = true;
}

/** The shaper set, or null. */
export const shaper = () => current;

/** Whether a shaper was set or chosen against (`useShaper`). */
export const settled = () => chosen;

/**
 * The scripts shaped apart from each other and from the rest: each a run
 * of its own (a capture group of SCRIPT, its index the script's key).
 */
const SCRIPTS = ['Arabic', 'Syriac', 'Thaana', 'Nko', 'Mongolian', 'Mandaic', 'Manichaean', 'Psalter_Pahlavi', 'Adlam', 'Hanifi_Rohingya', 'Sogdian', 'Phags_Pa', 'Hebrew', 'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Khmer', 'Hangul', 'Balinese', 'Javanese', 'Sundanese', 'Tai_Tham', 'Buginese', 'Batak', 'Chakma', 'Cham', 'Lepcha', 'Limbu', 'Meetei_Mayek', 'Tirhuta', 'Grantha', 'Sharada', 'Kaithi', 'Brahmi', 'Khojki', 'Modi', 'Takri', 'Siddham', 'Tai_Viet', 'New_Tai_Lue'];

/** A code point's script group: the first capture that matches, none for the other scripts, Common or Inherited (neutral). */
const SCRIPT = new RegExp(`^(?:(${SCRIPTS.map(s => `\\p{sc=${s}}`).join(')|(')}))`, 'u');
/** Characters of no script of their own: they join the run around them. */
const NEUTRAL = /^[\p{sc=Common}\p{sc=Inherited}]/u;

/**
 * What a shaper sets otherwise than by the typeface's advances: marks,
 * format characters (joiners, bidi controls, a soft hyphen), the joining
 * and the complex scripts, Hangul jamo, emoji modifiers and flags.
 */
const COMPLEX = new RegExp(`[\\p{M}\\p{Cf}${SCRIPTS.filter(s => s !== 'Hebrew' && s !== 'Hangul').map(s => `\\p{sc=${s}}`).join('')}\\u1100-\\u11ff\\ua960-\\ua97f\\ud7b0-\\ud7ff\\u{1f1e6}-\\u{1f1ff}\\u{1f3fb}-\\u{1f3ff}]`, 'u');

/**
 * Whether `text` is shaped: whether it holds a character a shaper sets
 * otherwise than by the typeface's advances. One scan of the text; below
 * U+0300 only the soft hyphen is.
 * @param {string} text
 */
export function complex(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x300 || c === 0xad) return COMPLEX.test(text);
  }
  return false;
}

/** Script keys by code point, as found (0: another script, -1: neutral). @type {Map<number, number>} */
const KEYS = new Map();

/** @param {number} cp */
function keyOf(cp) {
  let key = KEYS.get(cp);
  if (key === undefined) {
    const ch = String.fromCodePoint(cp);
    if (cp < 0x300) key = NEUTRAL.test(ch) ? -1 : 0;
    else {
      const m = SCRIPT.exec(ch);
      if (m === null) key = NEUTRAL.test(ch) ? -1 : 0;
      else {
        key = 1;
        while (m[key] === undefined) key++;
      }
    }
    if (KEYS.size >= 8192) KEYS.clear();
    KEYS.set(cp, key);
  }
  return key;
}

/**
 * The runs of one script in `text`, as [start, end] pairs in logical
 * order: characters of no script of their own (spaces, digits,
 * punctuation, marks) join the run before them (the first run when the
 * text starts with them).
 * @param {string} text
 * @returns {number[]}
 */
export function itemize(text) {
  /** @type {number[]} */
  const out = [];
  let start = 0;
  let key = -1;
  for (let i = 0; i < text.length; ) {
    const cp = /** @type {number} */ (text.codePointAt(i));
    const k = keyOf(cp);
    if (k >= 0) {
      if (key >= 0 && k !== key) {
        out.push(start, i);
        start = i;
      }
      key = k;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  out.push(start, text.length);
  return out;
}

/** Grapheme clusters: a ligature's advance is shared among those it holds. */
const GRAPHEMES = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/**
 * Text set in glyphs, in the typeface's units: the glyphs in visual order
 * from the left (ids, pen positions with their offsets), the whole advance,
 * and the caret at each UTF-16 offset as its distance from the text's start
 * edge (its left, or its right right to left): a cluster's advance after
 * the clusters before it in the text's order, a ligature's shared evenly
 * among the grapheme clusters it holds (as a browser places a caret inside
 * one), an offset inside a grapheme cluster at its start.
 */
export class Shaped {
  /** @param {number} count @param {number} length */
  constructor(count, length) {
    this.count = count;
    this.ids = new Uint32Array(count);
    /** Each glyph's x from the left edge, its offset added. */
    this.xs = new Float64Array(count);
    /** Each glyph's offset up from the baseline. */
    this.ys = new Float64Array(count);
    this.advance = 0;
    this.carets = new Float64Array(length + 1);
  }
}

/**
 * `text` shaped in a typeface: run by script (`itemize`), each in its own
 * direction (right to left when it holds a right-to-left character; `rtl`
 * for a run of neutrals alone), its glyphs laid in visual order, the runs
 * from the right when `rtl` (a right-to-left piece).
 * @param {Shaper} shaper @param {number} face @param {string} text @param {boolean} rtlBase
 */
export function shapeText(shaper, face, text, rtlBase) {
  const runs = itemize(text);
  /** @type {Glyphs[]} */
  const sets = [];
  let count = 0;
  for (let r = 0; r < runs.length; r += 2) {
    const piece = text.slice(runs[r], runs[r + 1]);
    const dir = rtl(piece) || (rtlBase && runs.length === 2 && !strong(piece));
    const g = shaper.shape(face, text, runs[r], runs[r + 1], dir, FEATURES);
    sets.push(copy(g));
    count += g.count;
  }
  const out = new Shaped(count, text.length);
  // The glyphs from the left: the runs in order, or from the last when right to left.
  let pen = 0;
  let n = 0;
  for (let s = 0; s < sets.length; s++) {
    const g = sets[rtlBase ? sets.length - 1 - s : s];
    for (let i = 0; i < g.count; i++) {
      out.ids[n] = g.ids[i];
      out.xs[n] = pen + g.dx[i];
      out.ys[n] = g.dy[i];
      pen += g.advances[i];
      n++;
    }
  }
  out.advance = pen;
  // The carets, in the text's order: each run's clusters after the runs before it.
  const carets = out.carets;
  let base = 0;
  for (let s = 0, r = 0; s < sets.length; s++, r += 2) base = caretsOf(sets[s], text, runs[r], runs[r + 1], base, carets);
  carets[text.length] = base;
  return out;
}

/** Whether text holds a character of a script (not neutrals alone). @param {string} text */
function strong(text) {
  for (let i = 0; i < text.length; ) {
    const cp = /** @type {number} */ (text.codePointAt(i));
    if (keyOf(cp) >= 0) return true;
    i += cp > 0xffff ? 2 : 1;
  }
  return false;
}

/** A shaper's glyphs kept apart from the buffers it reuses. @param {Glyphs} g @returns {Glyphs} */
const copy = g => ({ count: g.count, ids: g.ids.slice(0, g.count), advances: g.advances.slice(0, g.count), dx: g.dx.slice(0, g.count), dy: g.dy.slice(0, g.count), clusters: g.clusters.slice(0, g.count) });

/**
 * Writes the carets of text[start, end) from its glyphs into `carets`,
 * `base` the distance before the run; returns the distance after it.
 * @param {Glyphs} g @param {string} text @param {number} start @param {number} end @param {number} base @param {Float64Array} carets
 */
function caretsOf(g, text, start, end, base, carets) {
  // Each cluster's advance, at its first character.
  const length = end - start;
  const advance = new Float64Array(length);
  const first = new Uint8Array(length);
  for (let i = 0; i < g.count; i++) {
    const c = Math.min(Math.max(g.clusters[i] - start, 0), length - 1);
    advance[c] += g.advances[i];
    first[c] = 1;
  }
  // The grapheme clusters' starts in the run.
  const starts = new Uint8Array(length + 1);
  if (GRAPHEMES !== null) for (const s of GRAPHEMES.segment(text.slice(start, end))) starts[s.index] = 1;
  else for (let i = 0; i < length; i++) starts[i] = (text.charCodeAt(start + i) & 0xfc00) === 0xdc00 ? 0 : 1;
  let x = base;
  for (let c = 0; c < length; ) {
    // A cluster: from c to the next cluster's first character.
    let e = c + 1;
    while (e < length && first[e] === 0) e++;
    let graphemes = 0;
    for (let i = c; i < e; i++) graphemes += starts[i] === 1 || i === c ? 1 : 0;
    let k = 0;
    let at = x;
    for (let i = c; i < e; i++) {
      if (i === c || starts[i] === 1) at = x + (advance[c] * k++) / graphemes;
      carets[start + i] = at;
    }
    x += advance[c];
    c = e;
  }
  return x;
}
