// Fonts over font files (Sfnt): the root typeface, a monospace one,
// typefaces by family name and fallback typefaces, each character measured
// in the first of them that has it. ren-skia and ren-three measure their
// text with one; a typeface's slot (text.js SLOT) in a face tells a
// renderer which typeface draws a piece.

import { Sfnt } from './sfnt.js';
import { BOLD, ITALIC, MONO, RTL, SLOT } from './text.js';
import { complex } from './shape.js';
import { rtl } from './bidi.js';

/** A typeface: the bytes of its font file, or its Sfnt. @typedef {ArrayBuffer | Uint8Array | Sfnt} Source */

/**
 * The typefaces text is set in.
 * @typedef {object} Typefaces
 * @property {Source} font the root typeface: text is set in it unless its family names another
 * @property {Source | null} [mono] the typeface of text whose family names monospace (the root one without it)
 * @property {Record<string, Source>} [families] typefaces by family name: text whose `fontFamily` names one (the first of its list that is here, before a generic family) is set in it
 * @property {Source[]} [fallback] typefaces, in order, for the characters a typeface lacks: each is set in the first that has it
 */

/** CSS's generic families: a list that reaches one takes the root face (or the monospace one). */
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);

/** How many texts' pieces a face keeps (`faces`) before it forgets them. */
const LIMIT = 4096;

/** Marks and the format characters that continue a cluster. */
const MARK = /^[\p{M}]/u;
/** Characters a shaper hides where a typeface lacks them (joiners, variation selectors, bidi controls, a soft hyphen). */
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}/u;
/** A pictograph a joiner joins to the cluster before it. */
const PICTOGRAPH = /^\p{Extended_Pictographic}/u;

/**
 * Whether `cp` continues the cluster that `prev` ends (`joined`: `prev`
 * continued one itself), as HarfBuzz forms the clusters Chrome falls back
 * by: marks, emoji modifiers, the joiners and tags, a pictograph after a
 * zero width joiner, and the second of a pair of regional indicators.
 * @param {number} cp @param {number} prev @param {boolean} joined
 */
function continues(cp, prev, joined) {
  if (cp < 0x300) return false;
  if (cp === 0x200c || cp === 0x200d || (cp >= 0x1f3fb && cp <= 0x1f3ff) || cp === 0xff9e || cp === 0xff9f || (cp >= 0xe0020 && cp <= 0xe007f)) return true;
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return prev >= 0x1f1e6 && prev <= 0x1f1ff && !joined;
  const ch = String.fromCodePoint(cp);
  return MARK.test(ch) || (prev === 0x200d && PICTOGRAPH.test(ch));
}

/**
 * Whether a typeface has every character of text[from, to) a shaper draws:
 * the default ignorables need no glyph of it.
 * @param {Sfnt} sfnt @param {string} text @param {number} from @param {number} to
 */
function covers(sfnt, text, from, to) {
  for (let i = from; i < to; ) {
    const cp = /** @type {number} */ (text.codePointAt(i));
    if (sfnt.glyph(cp) === 0 && (cp < 0xad || !IGNORABLE.test(String.fromCodePoint(cp)))) return false;
    i += cp > 0xffff ? 2 : 1;
  }
  return true;
}

/** @param {Source} source */
const sfnt = source => (source instanceof Sfnt ? source : new Sfnt(source));

/** A family name as CSS compares it: unquoted, trimmed, in lowercase. @param {string} name */
const bare = name => name.trim().replace(/^["']|["']$/g, '').toLowerCase();

/**
 * Fonts (ren-canv's `Fonts`) over font files: the root typeface, a
 * monospace one, typefaces by family name (`typeface`) and fallback ones
 * for the characters a face lacks (`faces`), measured by the files' own
 * advances, shaped where a shaper sets them otherwise (shape.js). The slots: 0 the root typeface (the monospace one for MONO),
 * then the named typefaces in the order given, then the fallbacks.
 */
export class Faces {
  /** @param {Typefaces} typefaces */
  constructor({ font, mono = null, families = {}, fallback = [] }) {
    this.regular = sfnt(font);
    /** @type {Sfnt | null} */
    this.mono = mono == null ? null : sfnt(mono);
    const named = Object.entries(families);
    /** The family names, by slot less one. */
    this.names = named.map(([name]) => bare(name));
    /** The typefaces by slot. @type {Sfnt[]} */
    this.list = [this.regular, ...named.map(([, source]) => sfnt(source)), ...fallback.map(sfnt)];
    /** The first fallback's slot. */
    this.first = 1 + named.length;
    /** Each face's pieces by text (null: the face draws it all). @type {Map<number, Map<string, number[] | null>>} */
    this.pieces = new Map();
  }

  /**
   * The slot of the typeface a CSS font-family list names first, 0 when a
   * generic family or none of its names comes first.
   * @param {string} family
   */
  typeface(family) {
    for (const part of family.split(',')) {
      const name = bare(part);
      if (GENERIC.has(name)) return 0;
      const at = this.names.indexOf(name);
      if (at >= 0) return at + 1;
    }
    return 0;
  }

  /** The typeface of a face: its slot's, else the monospace one for MONO, else the root one. @param {number} face */
  of(face) {
    const slot = face >>> SLOT;
    if (slot > 0 && slot < this.list.length) return this.list[slot];
    return (face & MONO) !== 0 && this.mono !== null ? this.mono : this.regular;
  }

  /**
   * Where text in a face is set in a fallback typeface: null when the
   * face's own has every character (or there are no fallbacks), else the
   * pieces as [end, face, ...], a character the face lacks in the first
   * fallback that has it (in the face's own when none does: its missing
   * glyph).
   * @param {string} text @param {number} face
   * @returns {number[] | null}
   */
  faces(text, face) {
    if (this.list.length === this.first || text.length === 0) return null;
    const style = face & ~(BOLD | ITALIC | RTL);
    let known = this.pieces.get(style);
    if (known === undefined) this.pieces.set(style, (known = new Map()));
    let out = known.get(text);
    if (out === undefined) {
      out = this.split(text, face & ~(BOLD | ITALIC | RTL));
      if (known.size >= LIMIT) known.clear();
      known.set(text, out);
    }
    if (out === null || (face & (BOLD | ITALIC)) === 0) return out;
    // The style carries over to every piece.
    const styled = out.slice();
    for (let i = 1; i < styled.length; i += 2) styled[i] |= face & (BOLD | ITALIC);
    return styled;
  }

  /**
   * `faces` of a face without style bits, not cached: each cluster (a
   * character and what continues it: `continues`) in the first of the
   * face's own typeface and the fallbacks that has every character of it,
   * in the face's own when none has (its missing glyphs), as Chrome falls
   * back: a cluster stays in one typeface, its marks on their base.
   * @param {string} text @param {number} face
   */
  split(text, face) {
    const own = this.of(face);
    /** @type {number[] | null} */
    let out = null;
    let last = face;
    for (let i = 0; i < text.length; ) {
      let cp = /** @type {number} */ (text.codePointAt(i));
      let end = i + (cp > 0xffff ? 2 : 1);
      let joined = false;
      while (end < text.length) {
        const next = /** @type {number} */ (text.codePointAt(end));
        if (!continues(next, cp, joined)) break;
        cp = next;
        joined = true;
        end += next > 0xffff ? 2 : 1;
      }
      let f = face;
      if (!covers(own, text, i, end))
        for (let k = this.first; k < this.list.length; k++)
          if (covers(this.list[k], text, i, end)) {
            f = k << SLOT;
            break;
          }
      if (f !== last) {
        out ??= [];
        if (i > 0) out.push(i, last);
        last = f;
      }
      i = end;
    }
    if (out === null) return null;
    out.push(text.length, last);
    return out;
  }

  /**
   * The advance width of `text` at `size` in a face: each piece in the
   * typeface that has its characters.
   * @param {string} text @param {number} size @param {number} [face]
   */
  width(text, size, face = 0) {
    const pieces = this.faces(text, face);
    if (pieces === null) return this.of(face).width(text, size);
    let w = 0;
    let from = 0;
    for (let i = 0; i < pieces.length; i += 2) {
      w += this.of(pieces[i + 1]).width(text.slice(from, pieces[i]), size);
      from = pieces[i];
    }
    return w;
  }

  /**
   * The caret at each UTF-16 offset of `text` at `size` in a face, from
   * its start edge, each piece in the typeface that has it: null when the
   * text is not shaped (shape.js `complex`), where a caret is the width of
   * the text before it.
   * @param {string} text @param {number} size @param {number} [face]
   * @returns {Float64Array | null}
   */
  offsets(text, size, face = 0) {
    if (!complex(text)) return null;
    const back = rtl(text);
    const pieces = this.faces(text, face);
    if (pieces === null) return this.of(face).carets(text, size, back);
    const out = new Float64Array(text.length + 1);
    let from = 0;
    let base = 0;
    for (let i = 0; i < pieces.length; i += 2) {
      const own = this.of(pieces[i + 1]);
      const part = text.slice(from, pieces[i]);
      const carets = own.carets(part, size, back);
      if (carets !== null) for (let k = 0; k < part.length; k++) out[from + k] = base + carets[k];
      else for (let k = 0; k < part.length; k++) out[from + k] = base + own.width(part.slice(0, k), size);
      base += own.width(part, size);
      from = pieces[i];
    }
    out[text.length] = base;
    return out;
  }

  /** The ascent and descent at `size` of a face's typeface, both positive. @param {number} size @param {number} [face] */
  metrics(size, face = 0) {
    return this.of(face).metrics(size);
  }

  close() {
    for (const s of this.list) s.close();
    this.mono?.close();
    this.pieces.clear();
  }
}
