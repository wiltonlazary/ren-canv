// The Unicode Bidirectional Algorithm (UAX #9, Unicode 16.0.0) over the
// UTF-16 units of a paragraph: `levels` resolves each unit's embedding
// level (P2-P3, X1-X10, W1-W7, N0-N2, I1-I2), `line` applies L1 to one line
// of it, and `runs`, `order` and `visual` give the line's visual order (L2,
// with L4's mirroring in `visual`). Both units of a surrogate pair carry the
// code point's level and stay together, high then low, in a reversed run.
// The work arrays are kept between calls and grow with the longest text.

import { CLASSES, BRACKETS, MIRRORS } from './bidi-data.js';

/** Left-to-right. */
export const L = 0;
/** Right-to-left. */
export const R = 1;
/** Right-to-left Arabic. */
export const AL = 2;
/** European number. */
export const EN = 3;
/** European number separator. */
export const ES = 4;
/** European number terminator. */
export const ET = 5;
/** Arabic number. */
export const AN = 6;
/** Common number separator. */
export const CS = 7;
/** Nonspacing mark. */
export const NSM = 8;
/** Boundary neutral. */
export const BN = 9;
/** Paragraph separator. */
export const B = 10;
/** Segment separator. */
export const S = 11;
/** Whitespace. */
export const WS = 12;
/** Other neutral. */
export const ON = 13;
/** Left-to-right embedding. */
export const LRE = 14;
/** Left-to-right override. */
export const LRO = 15;
/** Right-to-left embedding. */
export const RLE = 16;
/** Right-to-left override. */
export const RLO = 17;
/** Pop directional format. */
export const PDF = 18;
/** Left-to-right isolate. */
export const LRI = 19;
/** Right-to-left isolate. */
export const RLI = 20;
/** First strong isolate. */
export const FSI = 21;
/** Pop directional isolate. */
export const PDI = 22;

/** The deepest explicit embedding level (BD2). */
const MAX_DEPTH = 125;
/** The paired brackets BD16 tracks at once. */
const BRACKET_DEPTH = 63;

// Bit masks of classes, tested as `(MASK >> k) & 1`.
/** What makes a text right-to-left for `rtl`. */
const RTL = (1 << R) | (1 << AL) | (1 << RLE) | (1 << RLO) | (1 << RLI) | (1 << FSI);
/** What X9 removes (and a low surrogate, carried as BN). */
const REMOVED = (1 << BN) | (1 << LRE) | (1 << LRO) | (1 << RLE) | (1 << RLO) | (1 << PDF);
/** The isolate initiators. */
const INITIATOR = (1 << LRI) | (1 << RLI) | (1 << FSI);
/** The neutrals and isolate formatting characters N1 and N2 resolve. */
const NI = (1 << B) | (1 << S) | (1 << WS) | (1 << ON) | INITIATOR | (1 << PDI);
/** What L1 resets before a separator or at a line's end. */
const TRAILING = (1 << WS) | INITIATOR | (1 << PDI) | REMOVED;

/** A packed number's digit values, by char code (bidi-data.js). */
const DIGIT = new Int8Array(128);
'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'.split('').forEach((c, i) => { DIGIT[c.charCodeAt(0)] = i; });

/**
 * The whole numbers packed in `s` (bidi-data.js's digits).
 * @param {string} s @returns {number[]}
 */
function unpack(s) {
  /** @type {number[]} */
  const out = [];
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const d = DIGIT[s.charCodeAt(i)];
    n = n * 32 + (d & 31);
    if (d < 32) { out.push(n); n = 0; }
  }
  return out;
}

/** A zigzag number back to its sign. @param {number} n */
const unzig = n => (n & 1 ? -(n + 1) / 2 : n / 2);

// The classes: a table for U+0000..U+FFFF, the runs above it for a binary search.
const BMP = new Uint8Array(0x10000);
/** @type {Int32Array} */
let astralStart;
/** @type {Uint8Array} */
let astralClass;
{
  const runs = unpack(CLASSES);
  /** @type {number[]} */
  const starts = [];
  /** @type {number[]} */
  const kinds = [];
  for (let i = 0, at = 0; i < runs.length; i++) {
    const len = Math.floor(runs[i] / 32), k = runs[i] & 31;
    if (at < 0x10000) BMP.fill(k, at, Math.min(at + len, 0x10000));
    if (at + len > 0x10000) { starts.push(Math.max(at, 0x10000)); kinds.push(k); }
    at += len;
  }
  astralStart = Int32Array.from(starts);
  astralClass = Uint8Array.from(kinds);
}

/** Each paired bracket's pair: the closing bracket of an opening one, minus the opening bracket of a closing one. @type {Map<number, number>} */
const PAIRS = new Map();
{
  const n = unpack(BRACKETS);
  for (let i = 0, at = 0; i < n.length; i += 2) {
    at += n[i];
    const close = at + unzig(n[i + 1]);
    PAIRS.set(at, close);
    PAIRS.set(close, -at);
  }
}

/** Each Bidi_Mirroring_Glyph pair. @type {Map<number, number>} */
const MIRROR = new Map();
{
  const n = unpack(MIRRORS);
  for (let i = 0, at = 0; i < n.length; i += 2) {
    at += n[i];
    MIRROR.set(at, at + unzig(n[i + 1]));
  }
}

/**
 * The Bidi_Class of a code point: one of the class constants.
 * @param {number} cp
 * @returns {number}
 */
export function classOf(cp) {
  if (cp < 0x10000) return BMP[cp];
  let lo = 0, hi = astralStart.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (astralStart[mid] <= cp) lo = mid;
    else hi = mid - 1;
  }
  return astralClass[lo];
}

/**
 * The mirrored code point of `cp` (Bidi_Mirroring_Glyph), or `cp` itself:
 * rule L4 draws an odd-level character with a mirror as its mirror.
 * @param {number} cp
 * @returns {number}
 */
export function mirror(cp) {
  return MIRROR.get(cp) ?? cp;
}

/**
 * Whether `text` needs the algorithm: it holds a character of class R or
 * AL, or an RLE, RLO, RLI or FSI. Everything below U+0590 is skipped by one
 * comparison, and a surrogate pair is decoded only when met.
 * @param {string} text
 * @returns {boolean}
 */
export function rtl(text) {
  for (let i = 0, n = text.length; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x590) continue;
    if (c < 0xd800 || c > 0xdfff) {
      if ((RTL >> BMP[c]) & 1) return true;
    } else if (c < 0xdc00 && i + 1 < n) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        if ((RTL >> classOf(((c - 0xd800) << 10) + d - 0xdc00 + 0x10000)) & 1) return true;
      }
    }
  }
  return false;
}

/**
 * The class of the unit at `i`: a pair's two units both give the code
 * point's.
 * @param {string} text @param {number} i
 */
function unitClass(text, i) {
  const c = text.charCodeAt(i);
  if (c < 0xd800 || c > 0xdfff) return BMP[c];
  if (c < 0xdc00) {
    const d = text.charCodeAt(i + 1);
    return d >= 0xdc00 && d <= 0xdfff ? classOf(((c - 0xd800) << 10) + d - 0xdc00 + 0x10000) : BMP[c];
  }
  const h = i > 0 ? text.charCodeAt(i - 1) : 0;
  return h >= 0xd800 && h < 0xdc00 ? classOf(((h - 0xd800) << 10) + c - 0xdc00 + 0x10000) : BMP[c];
}

// The work arrays, grown to the longest text.
let size = 0;
/** The text being resolved. */
let current = '';
/** The explicit levels (X1-X8). */
let lev = new Uint8Array(0);
/** The classes as the rules change them. */
let cls = new Uint8Array(0);
/** The classes before any rule, a low surrogate of a pair as BN. */
let orig = new Uint8Array(0);
/** An isolate initiator's matching PDI (BD9), or the text's length. */
let match = new Int32Array(0);
/** The level runs' characters, X9's removed ones left out. */
let chars = new Int32Array(0);
/** Each level run's first place in `chars`, and one past its last (`runFrom[r + 1]`). */
let runFrom = new Int32Array(0);
/** The level run a character starts. */
let runAt = new Int32Array(0);
/** Whether a level run is in a sequence yet. */
let used = new Uint8Array(0);
/** The current isolating run sequence's characters. */
let seq = new Int32Array(0);
/** The bracket pairs of a sequence: opening place times 2^26 plus closing place. */
let pairs = new Float64Array(0);

/** @param {number} n */
function grow(n) {
  if (n <= size) return;
  size = Math.max(n, size * 2, 64);
  lev = new Uint8Array(size);
  cls = new Uint8Array(size);
  orig = new Uint8Array(size);
  match = new Int32Array(size);
  chars = new Int32Array(size);
  runFrom = new Int32Array(size + 1);
  runAt = new Int32Array(size);
  used = new Uint8Array(size);
  seq = new Int32Array(size);
  pairs = new Float64Array((size >> 1) + 1);
}

// The directional status stack (X1): each entry's level, and its override
// (0 neutral, 1 left-to-right, 2 right-to-left) plus 4 for an isolate.
const stackLevel = new Uint8Array(MAX_DEPTH + 2);
const stackFlags = new Uint8Array(MAX_DEPTH + 2);
// BD16's bracket stack: an opening bracket's place, and its closing bracket.
const openAt = new Int32Array(BRACKET_DEPTH);
const openPair = new Int32Array(BRACKET_DEPTH);

/**
 * The first strong direction in [from, to) (P2-P3): 0 for L, 1 for R or AL,
 * -1 for none; isolates are skipped to their matching PDI.
 * @param {number} from @param {number} to
 */
function firstStrong(from, to) {
  for (let i = from; i < to; i++) {
    const k = orig[i];
    if (k === L) return 0;
    if (k === R || k === AL) return 1;
    if ((INITIATOR >> k) & 1) i = match[i];
  }
  return -1;
}

/**
 * Reads `text` into `orig` and `cls`, and matches its isolates (BD9).
 * @param {string} text
 */
function read(text) {
  const n = text.length;
  grow(n);
  current = text;
  let open = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    let k;
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < n) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        k = classOf(((c - 0xd800) << 10) + d - 0xdc00 + 0x10000);
        orig[i] = cls[i] = k;
        orig[++i] = cls[i] = BN;
        continue;
      }
    }
    k = BMP[c];
    orig[i] = cls[i] = k;
    // The open initiators wait in `chars`, here a stack.
    if ((INITIATOR >> k) & 1) { match[i] = n; chars[open++] = i; }
    else if (k === PDI && open > 0) match[chars[--open]] = i;
    else if (k === B) open = 0;
  }
}

/**
 * The paragraph level of `text` by rules P2 and P3: 1 when its first strong
 * character (outside isolates) is R or AL, else 0.
 * @param {string} text
 * @returns {0 | 1}
 */
export function paragraph(text) {
  if (!rtl(text)) return 0;
  read(text);
  return firstStrong(0, text.length) === 1 ? 1 : 0;
}

/**
 * The direction of the first strong character of `text` (outside
 * isolates), as HTML's `dir="auto"` finds it: 0 for L, 1 for R or AL,
 * -1 for none.
 * @param {string} text
 * @returns {-1 | 0 | 1}
 */
export function direction(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Latin letters, at once; everything else by the algorithm.
    if ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a) return 0;
    if (c >= 0x80) break;
  }
  read(text);
  const found = firstStrong(0, text.length);
  return found === 1 ? 1 : found === 0 ? 0 : -1;
}

/**
 * The resolved embedding level of each UTF-16 unit of one paragraph (rules
 * P2-P3, X1-X10, W1-W7, N0-N2, I1-I2); a paragraph separator inside it
 * takes the paragraph level (L1), and what X9 removes takes the level of
 * the character before it (the paragraph level at the start).
 * @param {string} text
 * @param {number} [base] the paragraph level: 0 left-to-right, 1 right-to-left, -1 (the default) by the first strong character (P2-P3), left-to-right when none
 * @returns {Uint8Array}
 */
export function levels(text, base = -1) {
  const n = text.length;
  const out = new Uint8Array(n);
  read(text);
  const para = base === 0 || base === 1 ? base : firstStrong(0, n) === 1 ? 1 : 0;
  if (n === 0) return out;
  explicit(n, para);
  sequences(n, para, out);
  for (let i = 0; i < n; i++) {
    const k = orig[i];
    if (k === B) out[i] = para;
    else if ((REMOVED >> k) & 1) out[i] = i > 0 ? out[i - 1] : para;
  }
  return out;
}

/**
 * Rules X1-X8: the explicit levels and overrides, into `lev` and `cls`.
 * @param {number} n @param {number} para
 */
function explicit(n, para) {
  const out = lev;
  let sp = 0;
  stackLevel[0] = para;
  stackFlags[0] = 0;
  let overflowIsolate = 0, overflowEmbedding = 0, validIsolate = 0;
  for (let i = 0; i < n; i++) {
    const k = orig[i];
    const level = stackLevel[sp], over = stackFlags[sp] & 3;
    switch (k) {
      case RLE: case LRE: case RLO: case LRO: {
        out[i] = level;
        const next = k === RLE || k === RLO ? (level + 1) | 1 : (level + 2) & ~1;
        if (next <= MAX_DEPTH && overflowIsolate === 0 && overflowEmbedding === 0) {
          sp++;
          stackLevel[sp] = next;
          stackFlags[sp] = k === LRO ? 1 : k === RLO ? 2 : 0;
        } else if (overflowIsolate === 0) overflowEmbedding++;
        break;
      }
      case RLI: case LRI: case FSI: {
        out[i] = level;
        if (over) cls[i] = over === 1 ? L : R;
        const right = k === RLI || (k === FSI && firstStrong(i + 1, match[i]) === 1);
        const next = right ? (level + 1) | 1 : (level + 2) & ~1;
        if (next <= MAX_DEPTH && overflowIsolate === 0 && overflowEmbedding === 0) {
          validIsolate++;
          sp++;
          stackLevel[sp] = next;
          stackFlags[sp] = 4;
        } else overflowIsolate++;
        break;
      }
      case PDI: {
        if (overflowIsolate > 0) overflowIsolate--;
        else if (validIsolate > 0) {
          overflowEmbedding = 0;
          while (!(stackFlags[sp] & 4)) sp--;
          sp--;
          validIsolate--;
        }
        out[i] = stackLevel[sp];
        const o = stackFlags[sp] & 3;
        if (o) cls[i] = o === 1 ? L : R;
        break;
      }
      case PDF:
        out[i] = level;
        // Inside an overflowed isolate a PDF pops nothing.
        if (overflowIsolate === 0) {
          if (overflowEmbedding > 0) overflowEmbedding--;
          else if (!(stackFlags[sp] & 4) && sp > 0) sp--;
        }
        break;
      case B:
        // X8: a separator ends every embedding, override and isolate.
        out[i] = para;
        sp = 0;
        overflowIsolate = overflowEmbedding = validIsolate = 0;
        break;
      case BN:
        out[i] = level;
        break;
      default:
        out[i] = level;
        if (over) cls[i] = over === 1 ? L : R;
    }
  }
}

/**
 * Rules X9-X10, then W1-W7, N0-N2 and I1-I2 on each isolating run sequence.
 * @param {number} n @param {number} para @param {Uint8Array} out
 */
function sequences(n, para, out) {
  // The level runs (BD7), X9's removed characters left out.
  let count = 0, runs = 0, prev = -1;
  for (let i = 0; i < n; i++) {
    if ((REMOVED >> orig[i]) & 1) continue;
    if (prev < 0 || lev[i] !== lev[prev]) {
      runFrom[runs] = count;
      runAt[i] = runs;
      used[runs++] = 0;
    }
    chars[count++] = i;
    prev = i;
  }
  runFrom[runs] = count;
  // Each isolating run sequence (BD13), from its first level run.
  for (let r = 0; r < runs; r++) {
    if (used[r]) continue;
    let len = 0, run = r;
    for (;;) {
      used[run] = 1;
      for (let j = runFrom[run]; j < runFrom[run + 1]; j++) seq[len++] = chars[j];
      const last = chars[runFrom[run + 1] - 1];
      if (!((INITIATOR >> orig[last]) & 1)) break;
      const m = match[last];
      if (m >= n) break;
      const next = runAt[m];
      if (next <= run || next >= runs || chars[runFrom[next]] !== m) break;
      run = next;
    }
    resolve(len, n, para, out);
  }
}

/**
 * W1-W7, N0-N2 and I1-I2 on the sequence `seq[0..len)`.
 * @param {number} len @param {number} n @param {number} para @param {Uint8Array} out
 */
function resolve(len, n, para, out) {
  const first = seq[0], last = seq[len - 1];
  const level = lev[first];
  // sos and eos (X10): the higher of this level and the one beside it.
  let before = first - 1;
  while (before >= 0 && (REMOVED >> orig[before]) & 1) before--;
  const sos = Math.max(level, before >= 0 ? lev[before] : para) & 1 ? R : L;
  let after = last + 1;
  while (after < n && (REMOVED >> orig[after]) & 1) after++;
  const eos = Math.max(level, after < n && !((INITIATOR >> orig[last]) & 1) ? lev[after] : para) & 1 ? R : L;
  const e = level & 1 ? R : L;

  // W1: a nonspacing mark takes the class before it (ON after an isolate initiator or PDI).
  // W2: a European number after an Arabic letter is an Arabic number. W3: AL is R.
  let strong = sos;
  for (let i = 0, prior = sos; i < len; i++) {
    const at = seq[i];
    let k = cls[at];
    if (k === NSM) cls[at] = k = (INITIATOR >> prior) & 1 || prior === PDI ? ON : prior;
    prior = k;
    if (k === L || k === R) strong = k;
    else if (k === AL) { strong = AL; cls[at] = R; }
    else if (k === EN && strong === AL) cls[at] = AN;
  }
  // W4: one separator between two numbers of a kind joins them.
  for (let i = 1; i + 1 < len; i++) {
    const k = cls[seq[i]];
    if (k !== ES && k !== CS) continue;
    const a = cls[seq[i - 1]], b = cls[seq[i + 1]];
    if (a === EN && b === EN) cls[seq[i]] = EN;
    else if (k === CS && a === AN && b === AN) cls[seq[i]] = AN;
  }
  // W5: terminators beside a European number join it. W6: other separators and terminators are ON.
  for (let i = 0; i < len; i++) {
    const k = cls[seq[i]];
    if (k === ET) {
      let j = i;
      while (j < len && cls[seq[j]] === ET) j++;
      const to = (i > 0 && cls[seq[i - 1]] === EN) || (j < len && cls[seq[j]] === EN) ? EN : ON;
      for (; i < j; i++) cls[seq[i]] = to;
      i--;
    } else if (k === ES || k === CS) cls[seq[i]] = ON;
  }
  // W7: a European number after L (or an L sos) is L.
  strong = sos;
  for (let i = 0; i < len; i++) {
    const k = cls[seq[i]];
    if (k === L || k === R) strong = k;
    else if (k === EN && strong === L) cls[seq[i]] = L;
  }

  brackets(len, sos, e);

  // N1-N2: a run of neutrals takes the direction around it when both sides
  // agree (numbers count as R), else the embedding direction.
  for (let i = 0; i < len; i++) {
    if (!((NI >> cls[seq[i]]) & 1)) continue;
    let j = i;
    while (j < len && (NI >> cls[seq[j]]) & 1) j++;
    const a = i > 0 ? strongOf(cls[seq[i - 1]]) : sos;
    const b = j < len ? strongOf(cls[seq[j]]) : eos;
    const to = a === b ? a : e;
    for (; i < j; i++) cls[seq[i]] = to;
  }

  // I1-I2: the implicit levels.
  for (let i = 0; i < len; i++) {
    const at = seq[i], k = cls[at];
    if (level & 1) out[at] = k === L || k === EN || k === AN ? level + 1 : level;
    else out[at] = k === R ? level + 1 : k === AN || k === EN ? level + 2 : level;
  }
}

/** A class as N0 and N1 see it: L, R (numbers too), or -1. @param {number} k */
const strongOf = k => (k === L ? L : k === R || k === EN || k === AN ? R : -1);

/** A bracket as BD16 compares it: U+2329 and U+232A are U+3008 and U+3009. @param {number} cp */
const canonical = cp => (cp === 0x2329 ? 0x3008 : cp === 0x232a ? 0x3009 : cp);

/**
 * N0: paired brackets (BD16) take the embedding direction when it is inside
 * them, else the other strong direction inside when the context before
 * them has it too, and the nonspacing marks after a bracket follow it.
 * @param {number} len @param {number} sos @param {number} e
 */
function brackets(len, sos, e) {
  let top = 0, found = 0;
  for (let i = 0; i < len; i++) {
    const at = seq[i];
    if (cls[at] !== ON) continue;
    // Every paired bracket is in the BMP.
    const cp = current.charCodeAt(at);
    const pair = PAIRS.get(cp);
    if (pair === undefined) continue;
    if (pair > 0) {
      if (top === BRACKET_DEPTH) break;
      openAt[top] = i;
      openPair[top++] = canonical(pair);
    } else {
      const want = canonical(cp);
      for (let s = top - 1; s >= 0; s--) {
        if (openPair[s] !== want) continue;
        pairs[found++] = openAt[s] * 67108864 + i;
        top = s;
        break;
      }
    }
  }
  if (found === 0) return;
  const list = pairs.subarray(0, found).sort();
  for (let p = 0; p < found; p++) {
    const open = Math.floor(list[p] / 67108864), close = list[p] % 67108864;
    let inside = -1;
    for (let i = open + 1; i < close; i++) {
      const s = strongOf(cls[seq[i]]);
      if (s === e) { inside = e; break; }
      if (s >= 0) inside = s;
    }
    if (inside < 0) continue;
    let to = e;
    if (inside !== e) {
      let context = sos;
      for (let i = open - 1; i >= 0; i--) {
        const s = strongOf(cls[seq[i]]);
        if (s >= 0) { context = s; break; }
      }
      if (context === inside) to = inside;
    }
    setBracket(open, to, len);
    setBracket(close, to, len);
  }
}

/**
 * Sets the bracket at sequence place `i` to `to`, and the nonspacing marks
 * right after it (their class before W1) too.
 * @param {number} i @param {number} to @param {number} len
 */
function setBracket(i, to, len) {
  cls[seq[i]] = to;
  for (let j = i + 1; j < len && orig[seq[j]] === NSM; j++) cls[seq[j]] = to;
}

/**
 * The levels of the line [start, end) of a paragraph, with rule L1 applied:
 * segment and paragraph separators, and the whitespace and isolate
 * formatting characters before them or at the line's end, take the
 * paragraph level. `levels` is left as it is.
 * @param {Uint8Array} levels the paragraph's levels (`levels`)
 * @param {string} text the paragraph's text
 * @param {number} start
 * @param {number} end
 * @param {number} base the paragraph level, 0 or 1 (`paragraph` for one decided by its text)
 * @returns {Uint8Array}
 */
export function line(levels, text, start, end, base) {
  const out = levels.slice(start, end);
  let trail = 0;
  for (let i = start; i < end; i++) {
    const k = unitClass(text, i);
    if (k === S || k === B) {
      for (let j = i - trail; j <= i; j++) out[j - start] = base;
      trail = 0;
    } else if ((TRAILING >> k) & 1) trail++;
    else trail = 0;
  }
  for (let j = end - trail; j < end; j++) out[j - start] = base;
  return out;
}

/**
 * The line's level runs in visual order (L2), as [start, end, level]
 * triples of offsets within the line: the pieces a renderer draws, left to
 * right, an odd level's reversed.
 * @param {Uint8Array} lineLevels a line's levels (`line`)
 * @returns {Int32Array}
 */
export function runs(lineLevels) {
  const n = lineLevels.length;
  let count = 0, high = 0, low = 255;
  for (let i = 0; i < n; i++) {
    const v = lineLevels[i];
    if (i === 0 || v !== lineLevels[i - 1]) count++;
    if (v > high) high = v;
    if (v < low) low = v;
  }
  const out = new Int32Array(count * 3);
  for (let i = 0, r = 0; i < n; r++) {
    let j = i + 1;
    while (j < n && lineLevels[j] === lineLevels[i]) j++;
    out[r * 3] = i;
    out[r * 3 + 1] = j;
    out[r * 3 + 2] = lineLevels[i];
    i = j;
  }
  // From the highest level down to the lowest odd one, reverse each stretch
  // of runs at that level or above.
  for (let level = high, lowOdd = low | 1; level >= lowOdd; level--) {
    for (let r = 0; r < count; r++) {
      if (out[r * 3 + 2] < level) continue;
      let s = r + 1;
      while (s < count && out[s * 3 + 2] >= level) s++;
      for (let a = r, b = s - 1; a < b; a++, b--) {
        for (let f = 0; f < 3; f++) {
          const t = out[a * 3 + f];
          out[a * 3 + f] = out[b * 3 + f];
          out[b * 3 + f] = t;
        }
      }
      r = s;
    }
  }
  return out;
}

/**
 * Whether the units at `i` and `i + 1` of `text` are a surrogate pair.
 * @param {string} text @param {number} i
 */
function pairAt(text, i) {
  const c = text.charCodeAt(i), d = text.charCodeAt(i + 1);
  return c >= 0xd800 && c < 0xdc00 && d >= 0xdc00 && d <= 0xdfff;
}

/**
 * The visual order of a line (L2): entry i is the line offset of the unit
 * shown at visual position i. Given the line's text, a surrogate pair in a
 * reversed run stays together, high then low.
 * @param {Uint8Array} lineLevels a line's levels (`line`)
 * @param {string} [text] the line's text
 * @returns {Int32Array}
 */
export function order(lineLevels, text) {
  const pieces = runs(lineLevels);
  const out = new Int32Array(lineLevels.length);
  let at = 0;
  for (let r = 0; r < pieces.length; r += 3) {
    const start = pieces[r], end = pieces[r + 1];
    if (!(pieces[r + 2] & 1)) for (let i = start; i < end; i++) out[at++] = i;
    else {
      for (let i = end - 1; i >= start; i--) {
        if (text !== undefined && i > start && pairAt(text, i - 1)) { out[at++] = i - 1; out[at++] = i; i--; }
        else out[at++] = i;
      }
    }
  }
  return out;
}

/**
 * A line's text in visual order, each character of an odd-level run drawn
 * as its mirror (L4): for a renderer that draws a line as one string.
 * @param {string} text the line's text
 * @param {Uint8Array} lineLevels its levels (`line`)
 * @returns {string}
 */
export function visual(text, lineLevels) {
  const pieces = runs(lineLevels);
  let out = '';
  for (let r = 0; r < pieces.length; r += 3) {
    const piece = text.slice(pieces[r], pieces[r + 1]);
    out += pieces[r + 2] & 1 ? reversed(piece) : piece;
  }
  return out;
}

/**
 * A right-to-left run as it is drawn glyph by glyph from the left: its
 * code points in reverse order (a surrogate pair stays whole), each with a
 * mirror drawn as its mirror (L4).
 * @param {string} text
 * @returns {string}
 */
export function reversed(text) {
  let out = '';
  for (let i = text.length - 1; i >= 0; i--) {
    const cp = i > 0 && pairAt(text, i - 1) ? /** @type {number} */ (text.codePointAt(--i)) : text.charCodeAt(i);
    out += String.fromCodePoint(mirror(cp));
  }
  return out;
}
