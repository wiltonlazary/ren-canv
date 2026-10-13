// Text wrapping and caret placement over a Fonts: whatever measures the
// advance width of a string at a size (the font file's own advances, Sfnt,
// in ren-skia and ren-three; a 2D context's in CanvasFonts). Text is measured through a
// Measure: one face and size (`Face`), or a Label's styled runs (`Runs`),
// each piece in its run's face and size.

import { up64 } from './units.js';
import { rtl, levels, line, runs } from './bidi.js';

/**
 * The measure a Document lays text out with.
 * @typedef {object} Fonts
 * @property {(text: string, size: number, face?: number) => number} width The advance width of `text` at `size`, in logical pixels; `face` (BOLD | ITALIC | MONO, and a typeface's slot shifted by SLOT; 0 by default) is the style it is set in, for a measure that has one per style (MONO: the monospace face, when it has one; a slot: the face `typeface` gave for a family name).
 * @property {(size: number, face?: number) => { ascent: number, descent: number }} metrics The font's ascent and descent at `size` (both positive), which place the baseline in a line; `face` as `width`'s.
 * @property {() => void} close Frees what the fonts hold.
 * @property {(family: string) => number} [typeface] The slot (from 1) of the typeface a CSS font-family list names first among those the fonts have, 0 for none (the root face): text in that family is measured and drawn in it.
 * @property {(text: string, size: number, face?: number) => Float64Array | null} [offsets] The caret at each UTF-16 offset of shaped `text` (joined scripts, clusters, marks), from its start edge (its right right to left): a cluster's advance after those before it in the text's order, a ligature's shared among its grapheme clusters; null when the text is not shaped, where a caret is the width of the text before it.
 * @property {(text: string, face: number) => number[] | null} [faces] Where `text` in `face` is drawn in other typefaces (a fallback for characters the face lacks): null when the face draws it all, else its pieces as [end, face, end, face, ...], each piece's face with its typeface's slot; `width` measures each piece in its face.
 */

/**
 * The width of `text` whose first character is at `at` in the whole text
 * (a run list reads its runs from there), and the carets of shaped text
 * (`Fonts.offsets`; null: the widths of the text before them).
 * @typedef {{ width(text: string, at: number): number, offsets?(text: string, at: number): Float64Array | null }} Measure
 */

/** Bits of a face: its weight and style (Fonts.width). */
export const BOLD = 1;
export const ITALIC = 2;
/** The monospace face (a family naming monospace). */
export const MONO = 4;
/** A text command's piece that runs right to left (its x is its right edge). */
export const RTL = 8;
/** A face's typeface slot sits above its style bits: `face >>> SLOT` (0: the root face, or the monospace one for MONO). */
export const SLOT = 4;

/**
 * Text's ascent and descent at `size` as a browser sets them in a line
 * box: each rounded to a pixel (Blink's SimpleFontData), so the baseline
 * and a span's background land where the DOM puts them.
 * @param {Fonts} fonts @param {number} size @param {number} [face]
 */
export function textExtent(fonts, size, face = 0) {
  const { ascent, descent } = fonts.metrics(size, face);
  return { ascent: Math.round(ascent), descent: Math.round(descent) };
}

/**
 * The baseline of text at `size` from the top of a line box `height`
 * high: the half leading above the ascent, floored to a pixel as Blink's
 * CalculateLeadingSpace does (the rest goes below the descent).
 * @param {Fonts} fonts @param {number} size @param {number} height @param {number} [face]
 */
export function baseline(fonts, size, height, face = 0) {
  const { ascent, descent } = textExtent(fonts, size, face);
  return ascent + Math.floor((height - ascent - descent) / 2);
}

/** Text in one face and size. @implements {Measure} */
export class Face {
  /** @param {Fonts} fonts @param {number} size @param {number} face */
  constructor(fonts, size, face) {
    this.fonts = fonts;
    this.size = size;
    this.face = face;
  }

  /** @param {string} text @param {number} at */
  width(text, at) {
    void at;
    return this.fonts.width(text, this.size, this.face);
  }

  /** @param {string} text @param {number} at */
  offsets(text, at) {
    void at;
    const fonts = this.fonts;
    return fonts.offsets === undefined ? null : fonts.offsets(text, this.size, this.face);
  }
}

/**
 * A run of text in a face and size of its own, over [start, end) of the
 * whole text (scene.js's Span).
 * @typedef {{ start: number, end: number, size: number, face: number }} Run
 */

/**
 * A text width as a browser lays it out: up to the next 64th of a pixel
 * (Blink's LayoutUnit, as it takes a shaped run's width), so boxes beside
 * text land where the DOM's do, to the 64th. The float noise of a sum of
 * advances does not push an exact width up.
 * @param {number} w
 */
export const unit = up64;

/**
 * Text over a list of runs: each piece measured in its run's face and size.
 * Characters past the last run's end (an ellipsis) take the last run.
 * Snapped (a Label's runs, each a span of its own in the DOM), a piece
 * that reaches its run's end is as wide as `unit` makes it, as Blink sizes
 * each text item on a line; a piece cut before its end (a caret's or a
 * selection's offset) keeps its width. An Edit's runs are one text in the
 * DOM's field, so they are not snapped.
 * @implements {Measure}
 */
export class Runs {
  /** @param {Fonts} fonts @param {readonly Run[]} runs in order, covering the text @param {boolean} [snap] */
  constructor(fonts, runs, snap = false) {
    this.fonts = fonts;
    this.runs = runs;
    this.snap = snap;
  }

  /** The index of the run holding offset `at` (the last one past the end). @param {number} at */
  at(at) {
    const runs = this.runs;
    let k = 0;
    while (k < runs.length - 1 && runs[k].end <= at) k++;
    return k;
  }

  /** @param {string} text @param {number} at */
  width(text, at) {
    const runs = this.runs;
    const fonts = this.fonts;
    if (runs.length === 0 || text.length === 0) return 0;
    let w = 0;
    let pos = 0;
    for (let k = this.at(at); pos < text.length; k++) {
      const run = runs[k];
      const take = k === runs.length - 1 ? text.length - pos : Math.min(text.length - pos, run.end - (at + pos));
      if (take > 0) {
        const piece = fonts.width(text.slice(pos, pos + take), run.size, run.face);
        w += this.snap && at + pos + take >= run.end ? unit(piece) : piece;
        pos += take;
      }
    }
    return w;
  }

  /** @param {string} text @param {number} at */
  offsets(text, at) {
    const runs = this.runs;
    const fonts = this.fonts;
    if (fonts.offsets === undefined || runs.length === 0 || text.length === 0) return null;
    /** @type {Float64Array | null} */
    let out = null;
    let w = 0;
    let pos = 0;
    for (let k = this.at(at); pos < text.length; k++) {
      const run = runs[k];
      const take = k === runs.length - 1 ? text.length - pos : Math.min(text.length - pos, run.end - (at + pos));
      if (take > 0) {
        const part = text.slice(pos, pos + take);
        const carets = fonts.offsets(part, run.size, run.face);
        if (carets !== null && out === null) {
          // The pieces before, as the widths of their prefixes.
          out = new Float64Array(text.length + 1);
          for (let i = 0; i < pos; i++) out[i] = this.width(text.slice(0, i), at);
        }
        if (out !== null)
          for (let i = 0; i < take; i++) out[pos + i] = w + (carets !== null ? carets[i] : fonts.width(part.slice(0, i), run.size, run.face));
        const piece = fonts.width(part, run.size, run.face);
        w += this.snap && at + pos + take >= run.end ? unit(piece) : piece;
        pos += take;
      }
    }
    if (out !== null) out[text.length] = w;
    return out;
  }
}

/**
 * The distance of the caret at offset `k` of `text` from its start edge:
 * from the shaped carets when there are (`Measure.offsets`), else the
 * width of the text before it.
 * @param {Measure} m @param {string} text @param {number} at @param {Float64Array | null} carets @param {number} k
 */
const before = (m, text, at, carets, k) => (carets !== null ? carets[k] : m.width(text.slice(0, k), at));

/** The shaped carets of `text` through a measure, or null. @param {Measure} m @param {string} text @param {number} at */
const caretsOf = (m, text, at) => (m.offsets === undefined || text.length === 0 ? null : m.offsets(text, at));

/** Whether index `i` falls inside a surrogate pair of `text` (between its two units). @param {string} text @param {number} i */
export const inside = (text, i) => i > 0 && i < text.length && (text.charCodeAt(i) & 0xfc00) === 0xdc00 && (text.charCodeAt(i - 1) & 0xfc00) === 0xd800;

/**
 * How many units of `word` fit `room` (at least its first cluster), ending
 * at a cluster's edge: a row never breaks inside one (क्ष, 👨‍👩‍👧), as a
 * browser breaks a word, nor inside a surrogate pair. The widths are read
 * at cluster edges only, where they grow with the text (a part of a ZWJ
 * sequence can be wider than all of it).
 * @param {Measure} measure @param {string} word @param {number} at @param {number} room
 */
function fit(measure, word, at, room) {
  // A prefix longer than the room, to find the edges in.
  let reach = Math.min(word.length, 64);
  while (reach < word.length && measure.width(word.slice(0, reach), at) <= room) reach = Math.min(word.length, reach * 2);
  /** @type {number[]} */
  const edges = [];
  if (CLUSTERS !== null) {
    for (const s of CLUSTERS.segment(word.slice(0, reach))) edges.push(s.index + s.segment.length);
    // The prefix's last cluster may go on past it: not an edge, unless it is the first (then its whole).
    if (reach < word.length) {
      if (edges.length > 1) edges.pop();
      else edges[0] = /** @type {Intl.SegmentData} */ (CLUSTERS.segment(word).containing(0)).segment.length;
    }
  } else for (let i = 1; i <= reach; i++) if (!inside(word, i)) edges.push(i);
  let low = 0;
  let high = edges.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (measure.width(word.slice(0, edges[middle]), at) <= room) low = middle;
    else high = middle - 1;
  }
  return edges[low];
}

/** Grapheme clusters, where the platform has them: a row never breaks inside one. */
const CLUSTERS = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/**
 * A text's rows wrapped in `room`, as a browser wraps pre-wrap text (a
 * Label's, as ren-dom sets it): newlines always break, spaces are kept (a
 * row's leading ones too), and a word wider than the room breaks between
 * clusters. The spaces a soft wrap falls on hang past their row: no row
 * holds them (each row is a run of the text, found in it in order).
 * @param {Measure} measure @param {string} text @param {number} room
 * @returns {string[]}
 */
export function Wrapped(measure, text, room) {
  const rows = Lines(measure, text, room);
  return rows.map((row, i) => (wraps(rows, i) ? row.text.replace(/ +$/, '') : row.text));
}

/**
 * Greedy word wrapping at `size`. Newlines always break; a word wider than
 * the room breaks between characters.
 * @param {Fonts} fonts @param {string} text @param {number} size @param {number} room @param {number} [face] BOLD | ITALIC
 * @returns {string[]}
 */
export function Wrap(fonts, text, size, room, face = 0) {
  return Wrapped(new Face(fonts, size, face), text, room);
}

/** One soft-wrapped row of an edit value and its start offset in the value. */
export class Row {
  /** @param {number} start @param {string} text */
  constructor(start, text) {
    this.start = start;
    this.text = text;
  }
}

/**
 * Where a soft wrap breaks a row `count` units fit in: after the spaces
 * there when it ends before them (they hang past the room, as in a
 * textarea), else after the last space before it, keeping words whole.
 * @param {string} text @param {number} count
 */
function breakable(text, count, from = 0) {
  if (text.charCodeAt(count) === 32) {
    let end = count;
    while (text.charCodeAt(end) === 32) end++;
    return end;
  }
  // The last space before it in the row (from `from`), the row's first too (a paragraph that starts with one breaks after it).
  let index = count - 1;
  while (index >= from && text.charCodeAt(index) !== 32) index--;
  return index >= from ? index + 1 : count;
}

/**
 * Soft-wrapped rows of a multi-line edit value through a measure (its face,
 * or its runs). A newline ends a row and is not drawn.
 * @param {Measure} measure @param {string} value @param {number} room
 * @returns {Row[]}
 */
export function Lines(measure, value, room) {
  /** @type {Row[]} */
  const rows = [];
  let start = 0;
  const paragraphs = value.split('\n');
  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p];
    let offset = 0;
    // The text a row is fitted in: a window past the row's start, grown while the row fills it (never the
    // whole rest of a long paragraph, measured or copied for each row: long text wraps in linear work).
    let span = 256;
    for (;;) {
      const left = paragraph.length - offset;
      const window = left <= span ? paragraph.slice(offset) : paragraph.slice(offset, offset + span);
      const count = window.length <= 1 || (window.length === 2 && inside(window, 1)) ? window.length : fit(measure, window, start + offset, room);
      if (count >= window.length && window.length < left) {
        span *= 2;
        continue;
      }
      if (count >= left) {
        rows.push(new Row(start + offset, window));
        break;
      }
      const cut = breakable(paragraph, offset + count, offset);
      rows.push(new Row(start + offset, paragraph.slice(offset, cut)));
      offset = cut;
      span = 256;
      // Spaces hanging at the paragraph's end make no row of their own.
      if (offset >= paragraph.length) break;
    }
    start += paragraph.length + 1;
  }
  return rows;
}

/**
 * The row holding `position`: a position at a soft wrap belongs to the next
 * row, or with `upstream` (the caret a move up, down or to a row's end left
 * there) to the row it ends.
 * @param {Row[]} rows @param {number} position @param {boolean} [upstream]
 */
export function Seek(rows, position, upstream = false) {
  let found = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i].start <= position) found = i;
  return upstream && found > 0 && rows[found].start === position && wraps(rows, found - 1) ? found - 1 : found;
}

/** Whether row `i` soft-wraps into the next (no line break between them). @param {Row[]} rows @param {number} i */
export function wraps(rows, i) {
  return i + 1 < rows.length && rows[i].start + rows[i].text.length === rows[i + 1].start;
}

/**
 * The index in a row `text` (at `at` in the whole text) nearest to
 * `distance` from its left edge, through a measure: in the visual run
 * under it (the first or the last past the row's ends), in that run's own
 * direction.
 * @param {Measure} measure @param {string} text @param {number} at @param {number} distance @param {number | Uint8Array} [base] the row's direction, or its levels (`order`)
 */
export function Nearest(measure, text, at, distance, base = 0) {
  const runs = text.length === 0 ? null : order(text, base);
  if (runs === null) return nearest(measure, text, at, distance);
  let x = 0;
  for (let i = 0; i < runs.length; i += 3) {
    const start = runs[i];
    const end = runs[i + 1];
    const piece = text.slice(start, end);
    const carets = caretsOf(measure, piece, at + start);
    const w = carets !== null ? carets[piece.length] : measure.width(piece, at + start);
    if (distance < x + w || i + 3 >= runs.length) return start + nearest(measure, piece, at + start, runs[i + 2] & 1 ? x + w - distance : distance - x, carets);
    x += w;
  }
  return 0;
}

/** `Nearest` in text laid out in its logical order. @param {Measure} measure @param {string} text @param {number} at @param {number} distance @param {Float64Array | null} [carets] */
function nearest(measure, text, at, distance, carets = caretsOf(measure, text, at)) {
  // The edges between clusters (between code points without Intl.Segmenter), where widths grow with the text.
  const edges = [0];
  if (CLUSTERS !== null) for (const s of CLUSTERS.segment(text)) edges.push(s.index + s.segment.length);
  else for (let i = 1; i <= text.length; i++) if (!inside(text, i)) edges.push(i);
  let low = 0;
  let high = edges.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (before(measure, text, at, carets, edges[middle]) < distance) low = middle + 1;
    else high = middle;
  }
  const left = edges[Math.max(0, low - 1)];
  const right = edges[low];
  return Math.abs(before(measure, text, at, carets, left) - distance) < Math.abs(before(measure, text, at, carets, right) - distance) ? left : right;
}

/**
 * The index of the character of a row `text` (at `at`) under
 * `distance` from its left edge, or -1 past its end or before it.
 * @param {Measure} measure @param {string} text @param {number} at @param {number} distance @param {number | Uint8Array} [base] the row's direction, or its levels (`order`)
 */
export function Under(measure, text, at, distance, base = 0) {
  if (distance < 0) return -1;
  const runs = text.length === 0 ? null : order(text, base);
  if (runs === null) return under(measure, text, at, distance);
  let x = 0;
  for (let i = 0; i < runs.length; i += 3) {
    const start = runs[i];
    const piece = text.slice(start, runs[i + 1]);
    const carets = caretsOf(measure, piece, at + start);
    const w = carets !== null ? carets[piece.length] : measure.width(piece, at + start);
    if (distance < x + w) {
      const hit = under(measure, piece, at + start, runs[i + 2] & 1 ? x + w - distance : distance - x, carets);
      return hit < 0 ? -1 : start + hit;
    }
    x += w;
  }
  return -1;
}

/** `Under` in text laid out in its logical order. @param {Measure} measure @param {string} text @param {number} at @param {number} distance @param {Float64Array | null} [carets] */
function under(measure, text, at, distance, carets = caretsOf(measure, text, at)) {
  if (distance < 0) return -1;
  // The cluster edges (code points without Intl.Segmenter), where widths grow with the text.
  const edges = [0];
  if (CLUSTERS !== null) for (const s of CLUSTERS.segment(text)) edges.push(s.index + s.segment.length);
  else for (let i = 1; i <= text.length; i++) if (!inside(text, i)) edges.push(i);
  // The most clusters whose width does not pass the distance: the next is under it.
  let low = 0;
  let high = edges.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (before(measure, text, at, carets, edges[middle]) <= distance) low = middle;
    else high = middle - 1;
  }
  return low < edges.length - 1 ? edges[low] : -1;
}

/** Word boundaries for `capitalize`, as a browser finds them (ICU's). */
const WORDS = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

/**
 * Text in a case, as CSS's text-transform shows it: `mode` 1 uppercase, 2
 * lowercase, 3 capitalized (the first letter of each word, as ICU's word
 * breaks find them, as Chrome's), else as given. It keeps the text's
 * length, so offsets into it (runs, selection, the caret's `offsetAt`) are
 * the given text's: a character whose case takes more or fewer UTF-16
 * units (`ß` uppercased is `SS`) keeps its own.
 * @param {string} text @param {number} mode
 */
export function cased(text, mode) {
  if (mode <= 0 || mode > 3 || text.length === 0) return text;
  if (mode === 3) return capitalized(text);
  const whole = mode === 1 ? text.toUpperCase() : text.toLowerCase();
  if (whole.length === text.length) return whole;
  let out = '';
  for (const ch of text) {
    const c = mode === 1 ? ch.toUpperCase() : ch.toLowerCase();
    out += c.length === ch.length ? c : ch;
  }
  return out;
}

/** The first letter of each word uppercased (`cased`'s 3). @param {string} text */
function capitalized(text) {
  let out = '';
  /** Uppercases the first code point of a word, when that keeps its length. @param {string} word */
  const first = word => {
    const cp = /** @type {number} */ (word.codePointAt(0));
    const size = cp > 0xffff ? 2 : 1;
    const head = word.slice(0, size);
    const up = head.toUpperCase();
    return (up.length === size ? up : head) + word.slice(size);
  };
  if (WORDS === null) return text.replace(/[\p{L}\p{N}_'’]+/gu, first);
  for (const s of WORDS.segment(text)) out += s.isWordLike ? first(s.segment) : s.segment;
  return out;
}

/** The visual runs of rows met lately, by their text (`order`): left to right, and right to left. @type {Map<string, Int32Array | null>} */
const ORDERS = new Map();
/** @type {Map<string, Int32Array | null>} */
const ORDERS_RTL = new Map();
/** Rows whose runs are kept at once. */
const ORDERS_KEPT = 1024;

/**
 * A row's level runs in visual order, as [start, end, level] triples (an
 * odd level runs right to left), from the Unicode bidirectional algorithm
 * (bidi.js) with the row as a paragraph in its base direction: `base` 0
 * left to right (the DOM's default), 1 right to left (`dir="rtl"`); or
 * the row's levels as given (a row cut with an ellipsis keeps those its
 * characters had in the whole row). Null when the whole row runs left to
 * right (one even run: left to right, a row with no right-to-left text),
 * which is drawn, measured and hit as it is, in its logical order.
 * @param {string} text @param {number | Uint8Array} [base]
 * @returns {Int32Array | null}
 */
export function order(text, base = 0) {
  if (typeof base !== 'number') {
    const found = runs(base);
    return found.length === 3 && (found[2] & 1) === 0 ? null : found;
  }
  if (base === 0 && !rtl(text)) return null;
  const known = base === 0 ? ORDERS : ORDERS_RTL;
  let found = known.get(text);
  if (found === undefined) {
    found = runs(line(levels(text, base), text, 0, text.length, base));
    if (found.length === 3 && (found[2] & 1) === 0) found = null;
    if (known.size >= ORDERS_KEPT) known.clear();
    known.set(text, found);
  }
  return found;
}

/**
 * The visual run of a row holding the caret at offset `k` (the
 * character after it; at the row's end, the last one), as its index in
 * `runs`.
 * @param {Int32Array} runs @param {number} k @param {number} length
 */
function runOfCaret(runs, k, length) {
  const at = k >= length ? length - 1 : k;
  for (let i = 0; i < runs.length; i += 3) if (at >= runs[i] && at < runs[i + 1]) return i;
  return 0;
}

/**
 * Where the caret at offset `k` of a row stands, from the row's left
 * edge: at the start edge of the character after it (its left in a run
 * left to right, its right in one right to left), at the end edge of the
 * last character at the row's end. Left to right, the width of the text
 * before it.
 * @param {Measure} m @param {string} text the row @param {number} at where the row starts in the whole text @param {number} k @param {number | Uint8Array} [base] the row's direction, or its levels (`order`)
 */
export function xAt(m, text, at, k, base = 0) {
  const runs = text.length === 0 ? null : order(text, base);
  if (runs === null) return before(m, text, at, caretsOf(m, text, at), k);
  const hold = runOfCaret(runs, k, text.length);
  let x = 0;
  for (let i = 0; i < runs.length; i += 3) {
    const start = runs[i];
    const end = runs[i + 1];
    const piece = text.slice(start, end);
    const carets = caretsOf(m, piece, at + start);
    const w = carets !== null ? carets[piece.length] : m.width(piece, at + start);
    if (i === hold) {
      const b = before(m, piece, at + start, carets, k - start);
      return runs[i + 2] & 1 ? x + w - b : x + b;
    }
    x += w;
  }
  return x;
}

/**
 * The visual ranges a run of a row's text [a, b) covers, from the row's
 * left edge, into `out` as [left, right] pairs: one left to right, one
 * per visual run it reaches otherwise (a selection across a change of
 * direction shows as separate pieces).
 * @param {Measure} m @param {string} text @param {number} at @param {number} a @param {number} b @param {number[]} out @param {number | Uint8Array} [base] the row's direction, or its levels (`order`)
 */
export function marks(m, text, at, a, b, out, base = 0) {
  out.length = 0;
  if (a >= b) return out;
  const runs = order(text, base);
  if (runs === null) {
    const carets = caretsOf(m, text, at);
    out.push(before(m, text, at, carets, a), before(m, text, at, carets, b));
    return out;
  }
  let x = 0;
  for (let i = 0; i < runs.length; i += 3) {
    const start = runs[i];
    const end = runs[i + 1];
    const piece = text.slice(start, end);
    const carets = caretsOf(m, piece, at + start);
    const w = carets !== null ? carets[piece.length] : m.width(piece, at + start);
    const from = Math.max(a, start);
    const to = Math.min(b, end);
    if (from < to) {
      const x0 = before(m, piece, at + start, carets, from - start);
      const x1 = before(m, piece, at + start, carets, to - start);
      if (runs[i + 2] & 1) out.push(x + w - x1, x + w - x0);
      else out.push(x + x0, x + x1);
    }
    x += w;
  }
  return out;
}
