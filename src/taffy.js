// Taffy as the layout engine: a Solver (engine.js) over taffy-layout, the
// Taffy engine's WebAssembly build, which runs CSS flexbox and grid with
// CSS's defaults. This is the only module that knows Taffy: it turns the
// neutral CSS Box records into Taffy's styles. Taffy lays out left to
// right only: the children of a right-to-left box (`dir`) are laid out so
// and mirrored as they are read (`mirror`). `loadLayout()` loads it and
// sets it as the engine; `useLayout` sets another instead.

import init, { initSync, TaffyTree, Style, Display, FlexDirection, FlexWrap, AlignItems, AlignSelf, JustifyContent, Overflow, Position } from 'taffy-layout/wasm';
import { useLayout } from './engine.js';

/** @typedef {import('./engine.js').Box} Box */
/** @typedef {import('./engine.js').Solver} Solver */

let loaded = false;
/** @type {Promise<void> | null} */
let loading = null;

/**
 * Loads Taffy's WebAssembly once and makes it the layout engine, where
 * layout runs: the main thread (the default), or the worker that
 * `serveLayout` serves. In node it reads the module beside taffy-layout; in
 * a browser it fetches `taffy_wasm_bg.wasm` beside the script (a bundle
 * copies it there), or `source`: a URL, a Response, the bytes, or a
 * compiled module.
 * @param {string | URL | Response | ArrayBuffer | Uint8Array | WebAssembly.Module} [source]
 * @returns {Promise<void>}
 */
export function loadLayout(source) {
  if (loaded) return Promise.resolve();
  if (source === undefined) {
    const proc = /** @type {any} */ (globalThis).process;
    if (typeof proc?.getBuiltinModule === 'function') {
      const fs = proc.getBuiltinModule('node:fs');
      const url = proc.getBuiltinModule('node:url');
      source = fs.readFileSync(url.fileURLToPath(new URL('taffy_wasm_bg.wasm', import.meta.resolve('taffy-layout/wasm'))));
    }
  }
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source) || source instanceof WebAssembly.Module) {
    // Bad bytes reject, as any failed load does; they are not thrown.
    try {
      initSync({ module: /** @type {any} */ (source) });
    } catch (e) {
      return Promise.reject(e);
    }
    ready();
    return Promise.resolve();
  }
  return (loading ??= init(source === undefined ? undefined : { module_or_path: /** @type {any} */ (source) }).then(ready, e => {
    // A failed load (a fetch that failed) may be tried again.
    loading = null;
    throw e;
  }));
}

function ready() {
  loaded = true;
  useLayout(() => new Taffy());
}

const DISPLAY = { flex: Display.Flex, grid: Display.Grid, none: Display.None };
const ALIGN_ITEMS = { start: AlignItems.Start, center: AlignItems.Center, end: AlignItems.End, stretch: AlignItems.Stretch };
const ALIGN_SELF = { auto: AlignSelf.Auto, start: AlignSelf.Start, center: AlignSelf.Center, end: AlignSelf.End, stretch: AlignSelf.Stretch };
const JUSTIFY = { start: JustifyContent.FlexStart, center: JustifyContent.Center, end: JustifyContent.FlexEnd, between: JustifyContent.SpaceBetween, around: JustifyContent.SpaceAround, evenly: JustifyContent.SpaceEvenly };
const OVERFLOW = { visible: Overflow.Visible, hidden: Overflow.Hidden, scroll: Overflow.Scroll };

/**
 * One CSS track size as Taffy's: a length (px or a bare number), a
 * percentage, `Nfr`, auto, min-content, max-content, or minmax(a, b).
 * @param {string} t
 * @returns {any}
 */
function track(t) {
  t = t.trim();
  const m = /^minmax\((.*),(.*)\)$/.exec(t);
  if (m !== null) return { min: size1(m[1].trim(), true), max: size1(m[2].trim(), false) };
  if (t.endsWith('fr')) return { min: 'auto', max: t };
  const v = size1(t, true);
  return { min: v, max: v };
}

/** @param {string} t @param {boolean} min */
function size1(t, min) {
  if (t === 'auto' || t === 'min-content' || t === 'max-content') return t;
  if (t.endsWith('%')) return t;
  if (!min && t.endsWith('fr')) return t;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : 'auto';
}

/** Splits a track list at top-level spaces (not inside parentheses). @param {string} text */
function tokens(text) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of text.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (current !== '') out.push(current);
      current = '';
    } else current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

/** A CSS track list (grid-template-columns) as Taffy's components, repeat() included. @param {string} text */
export function tracks(text) {
  return tokens(text).map(t => {
    const m = /^repeat\(\s*([^,]+),(.*)\)$/.exec(t);
    if (m === null) return track(t);
    const count = m[1].trim();
    return { count: count === 'auto-fill' || count === 'auto-fit' ? count : Number(count), tracks: tokens(m[2]).map(track) };
  });
}

/** A CSS grid line (grid-column: 2, '1 / 3', 'span 2', 'auto') as Taffy's. @param {string} text */
export function lines(text) {
  const one = (/** @type {string} */ t) => {
    t = t.trim();
    if (t === '' || t === 'auto') return 'auto';
    const span = /^span\s+(\d+)$/.exec(t);
    if (span !== null) return { span: Number(span[1]) };
    const v = Number(t);
    return Number.isFinite(v) ? v : 'auto';
  };
  const [start, end] = text.split('/');
  return { start: one(start), end: end === undefined ? 'auto' : one(end) };
}

/** Four sides (top, right, bottom, left) as Taffy's rectangle. @param {readonly (number | string)[]} s */
const sides = s => ({ top: s[0], right: s[1], bottom: s[2], left: s[3] });

/**
 * A size in pixels clamped by its minimum and maximum in pixels, as CSS
 * uses it. Taffy clamps a flex item's size in its line, but a flex column
 * sized by its content takes an unshrinkable item's size unclamped (height
 * 240, max-height 100: the column 240 high).
 * @param {number | string} size @param {number | string} min @param {number | string} max
 */
const clamped = (size, min, max) => (typeof size !== 'number' ? size : Math.max(typeof min === 'number' ? min : 0, typeof max === 'number' ? Math.min(size, max) : size));

/** A Box as Taffy's style props. @param {Box} b */
export function props(b) {
  return {
    display: DISPLAY[b.display],
    position: b.position === 'absolute' ? Position.Absolute : Position.Relative,
    inset: sides(b.inset),
    flexDirection: b.direction === 'row' ? FlexDirection.Row : FlexDirection.Column,
    flexWrap: b.wrap ? FlexWrap.Wrap : FlexWrap.NoWrap,
    gap: { width: b.columnGap, height: b.rowGap },
    padding: sides(b.padding),
    border: sides(b.border),
    margin: sides(b.margin),
    size: { width: clamped(b.width, b.minWidth, b.maxWidth), height: clamped(b.height, b.minHeight, b.maxHeight) },
    minSize: { width: b.minWidth, height: b.minHeight },
    maxSize: { width: b.maxWidth, height: b.maxHeight },
    aspectRatio: b.ratio ?? undefined,
    flexBasis: b.basis,
    flexGrow: b.grow,
    flexShrink: b.shrink,
    alignItems: ALIGN_ITEMS[b.align],
    alignSelf: ALIGN_SELF[b.self],
    // CSS's normal is Taffy's unset: the start in a flex container, stretch for a grid's tracks.
    justifyContent: b.justify === 'normal' ? undefined : JUSTIFY[b.justify],
    overflow: { x: OVERFLOW[b.overflowX], y: OVERFLOW[b.overflowY] },
    scrollbarWidth: b.scrollbar,
    gridTemplateColumns: b.columns === null ? [] : tracks(b.columns),
    gridTemplateRows: b.rows === null ? [] : tracks(b.rows),
    gridColumn: b.column === null ? { start: 'auto', end: 'auto' } : lines(b.column),
    gridRow: b.row === null ? { start: 'auto', end: 'auto' } : lines(b.row),
  };
}

/**
 * True for a grid Taffy would shrink below its content in a flex column:
 * Taffy takes a grid's automatic minimum height (CSS's min-height: auto)
 * from its tracks sized for a min-content height, where items that clip
 * count as nothing; Chrome takes the grid's laid-out height, as for any
 * block size. With its height, basis and minimum automatic, that minimum
 * is its basis, so the grid does not shrink at all.
 * @param {any} p its props @param {any} parent its parent's props
 */
const heldGrid = (p, parent) =>
  p.display === Display.Grid && p.position !== Position.Absolute && p.flexShrink > 0 && p.size.height === 'auto' && p.minSize.height === 'auto' && p.flexBasis === 'auto' && p.overflow.y === Overflow.Visible &&
  parent !== undefined && parent.display === Display.Flex && parent.flexDirection === FlexDirection.Column;

/** A percentage shaved by a relative 2^-16 (`shaved`). */
const SHAVE = 1 - 2 ** -16;

/**
 * A percentage a hair smaller: Taffy resolves percentages and sums a flex
 * line in 32-bit floats and wraps an item that overflows the line by any
 * amount, so items of 66.6667% and 33.3333% (exactly 100%) wrap a row 664
 * wide (442.66693 + 221.33331 = 664.00024); Chrome floors each percentage
 * to a 64th of a pixel and keeps one line. Shaved by 2^-16 of itself (at
 * most 0.015 px for a 1000 px item, under the 64th Chrome floors away), a
 * line of percentages that sum to 100% or less fits.
 * @param {any} v
 */
const shaved = v => (typeof v === 'string' && v.endsWith('%') ? `${parseFloat(v) * SHAVE}%` : v);

/**
 * How a node's style differs from its shared one, by what its parent is,
 * as bits: 1 a grid held from shrinking (`heldGrid`), 2 its percentage
 * width shaved in a wrapping row, 4 its percentage height in a wrapping
 * column (`shaved`).
 * @param {any} p its props @param {any} parent its parent's props
 */
function variant(p, parent) {
  let bits = heldGrid(p, parent) ? 1 : 0;
  if (parent !== undefined && parent.display === Display.Flex && parent.flexWrap === FlexWrap.Wrap && p.position !== Position.Absolute) {
    const row = parent.flexDirection === FlexDirection.Row;
    if (row && (shaved(p.size.width) !== p.size.width || shaved(p.flexBasis) !== p.flexBasis)) bits |= 2;
    if (!row && (shaved(p.size.height) !== p.size.height || shaved(p.flexBasis) !== p.flexBasis)) bits |= 4;
  }
  return bits;
}

/** An inset in pixels: a length, or a percentage of `room`. @param {number | string} v @param {number} room */
const inset = (v, room) => (typeof v === 'number' ? v : typeof v === 'string' && v.endsWith('%') ? (parseFloat(v) / 100) * room : 0);

/** Taffy's tree as a Solver. @implements {Solver} */
export class Taffy {
  constructor() {
    this.tree = new TaffyTree();
    // Layout keeps its fractions; the painter snaps boxes to device pixels.
    this.tree.disableRounding();
    this.empty = new Style({});
    /** The props each style was made from, and its mutable copy for `sized`. @type {Map<Style, any>} */
    this.defined = new Map();
    /** @type {Map<Style, Style>} */
    this.copies = new Map();
    /**
     * Each node's props (its shared style's, kept past a FORGET that frees
     * the style), parent and children, and the styles copied from props for
     * a `variant` (by props, then its bits).
     * @type {Map<bigint, any>}
     */
    this.propsOf = new Map();
    /** @type {Map<bigint, bigint>} */
    this.parentOf = new Map();
    /** @type {Map<bigint, bigint[]>} */
    this.kidsOf = new Map();
    /** @type {Map<any, Map<number, Style>>} */
    this.held = new Map();
    /** The nodes set to a variant's copy, and its bits. @type {Map<bigint, number>} */
    this.holding = new Map();
    /** Each node's Box (a sized node's shared one), for mirroring right to left. @type {Map<bigint, Box>} */
    this.boxes = new Map();
    /** The Box each style was made from. @type {Map<Style, Box>} */
    this.boxOf = new Map();
    /** How many right-to-left styles were made: none, and nothing is mirrored. */
    this.rtl = 0;
    /** The widths of the right-to-left boxes read since the last layout. @type {Map<bigint, number>} */
    this.widths = new Map();
    /** The available space of a layout: open (max-content) or a width (and a height). @type {{ width: number | string, height: number | string }} */
    this.open = { width: 'max-content', height: 'max-content' };
    /** @type {{ width: number | string, height: number | string }} */
    this.fixed = { width: 0, height: 'max-content' };
  }

  leaf() {
    return this.tree.newLeaf(this.empty);
  }

  /** @param {Box} b */
  define(b) {
    const p = props(b);
    const style = new Style(p);
    this.defined.set(style, p);
    this.boxOf.set(style, b);
    if (b.dir === 'rtl') this.rtl++;
    return style;
  }

  /** @param {Style} style */
  undefine(style) {
    this.copies.get(style)?.free();
    this.copies.delete(style);
    const p = this.defined.get(style);
    for (const copy of this.held.get(p)?.values() ?? []) copy.free();
    this.held.delete(p);
    this.defined.delete(style);
    this.boxOf.delete(style);
    style.free();
  }

  /** @param {bigint} node @param {Style} style */
  set(node, style) {
    this.propsOf.set(node, this.defined.get(style));
    this.boxes.set(node, /** @type {Box} */ (this.boxOf.get(style)));
    this.fit(node, true, style);
    for (const kid of this.kidsOf.get(node) ?? []) this.fit(kid, false);
  }

  /**
   * Sets a node's style, or its copy for the `variant` its parent makes it;
   * unless `always`, only when that choice changed. `style` is the shared style
   * just set; otherwise the node's is made again from its props.
   * @param {bigint} node @param {boolean} always @param {Style} [style]
   */
  fit(node, always, style) {
    const p = this.propsOf.get(node);
    if (p === undefined) return;
    const parent = this.parentOf.get(node);
    const bits = variant(p, parent === undefined ? undefined : this.propsOf.get(parent));
    if (!always && bits === (this.holding.get(node) ?? 0)) return;
    if (bits !== 0) this.holding.set(node, bits);
    else this.holding.delete(node);
    if (bits === 0) {
      if (style !== undefined) this.tree.setStyle(node, style);
      else {
        // Unheld again, its style perhaps forgotten: one made from its props.
        const plain = new Style(p);
        this.tree.setStyle(node, plain);
        plain.free();
      }
      return;
    }
    let copies = this.held.get(p);
    if (copies === undefined) this.held.set(p, (copies = new Map()));
    let copy = copies.get(bits);
    if (copy === undefined) {
      copy = new Style((bits & 6) === 0 ? p : { ...p, size: (bits & 2) !== 0 ? { width: shaved(p.size.width), height: p.size.height } : { width: p.size.width, height: shaved(p.size.height) }, flexBasis: shaved(p.flexBasis) });
      if ((bits & 1) !== 0) copy.flexShrink = 0;
      copies.set(bits, copy);
    }
    this.tree.setStyle(node, copy);
  }

  /**
   * A copy of the style, its three sizes replaced: one mutable copy per
   * shared style, set on each node (Taffy copies a style it is given).
   * @param {bigint} node @param {Style} style @param {number | string} minWidth @param {number | string} minHeight @param {number | string} basis
   */
  sized(node, style, minWidth, minHeight, basis) {
    let copy = this.copies.get(style);
    if (copy === undefined) {
      copy = new Style(/** @type {any} */ (this.defined.get(style)));
      this.copies.set(style, copy);
    }
    copy.minWidth = /** @type {any} */ (minWidth);
    copy.minHeight = /** @type {any} */ (minHeight);
    copy.flexBasis = /** @type {any} */ (basis);
    this.propsOf.delete(node);
    this.holding.delete(node);
    this.boxes.set(node, /** @type {Box} */ (this.boxOf.get(style)));
    this.tree.setStyle(node, copy);
  }

  /** @param {bigint} node @param {bigint[]} children */
  children(node, children) {
    this.tree.setChildren(node, children);
    const before = this.kidsOf.get(node) ?? [];
    for (const kid of before) if (this.parentOf.get(kid) === node) this.parentOf.delete(kid);
    this.kidsOf.set(node, children.slice());
    for (const kid of children) {
      this.parentOf.set(kid, node);
      this.fit(kid, false);
    }
    for (const kid of before) if (!this.parentOf.has(kid)) this.fit(kid, false);
  }

  /** @param {bigint} node */
  remove(node) {
    this.tree.remove(node);
    // Its children stay, parentless; its parent lists it no more.
    for (const kid of this.kidsOf.get(node) ?? []) if (this.parentOf.get(kid) === node) this.parentOf.delete(kid);
    const parent = this.parentOf.get(node);
    const siblings = parent === undefined ? undefined : this.kidsOf.get(parent);
    if (siblings !== undefined && siblings.includes(node)) siblings.splice(siblings.indexOf(node), 1);
    this.propsOf.delete(node);
    this.boxes.delete(node);
    this.kidsOf.delete(node);
    this.parentOf.delete(node);
    this.holding.delete(node);
  }

  /** @param {bigint} node @param {number} width @param {number} [height] */
  compute(node, width, height = NaN) {
    let space = this.open;
    if (width === width) {
      space = this.fixed;
      space.width = width;
      space.height = height === height ? height : 'max-content';
    }
    this.tree.computeLayout(node, /** @type {any} */ (space));
    this.widths.clear();
  }

  /** @param {bigint} node @param {Float64Array} out */
  read(node, out) {
    const layout = this.tree.getLayout(node);
    const [x, y, w, h, content, across] = /** @type {number[]} */ (/** @type {any} */ (layout).get('x', 'y', 'width', 'height', 'contentHeight', 'contentWidth'));
    layout.free();
    out[0] = x;
    out[1] = y;
    out[2] = w;
    out[3] = h;
    out[4] = content;
    out[5] = across;
    if (this.rtl !== 0) this.mirror(node, out);
  }

  /**
   * A node's box in a right-to-left parent, as CSS places it: Taffy laid
   * it out left to right, so its margin box is mirrored in the parent's
   * content box (x' = left + right - x - width, the margins swapped), a
   * relative offset taken as right to left takes it (`right` before
   * `left`), and an absolute box placed by its `right` inset from the
   * parent's padding box (by its `left` it stays; by neither, its static
   * place is mirrored). A Scroll's bar's room, kept on the right, falls on
   * the left. Each level mirrors in its parent, so nested boxes agree.
   * @param {bigint} node @param {Float64Array} out
   */
  mirror(node, out) {
    const parent = this.parentOf.get(node);
    if (parent === undefined) return;
    const pb = this.boxes.get(parent);
    const b = this.boxes.get(node);
    if (pb === undefined || b === undefined || pb.dir !== 'rtl') return;
    let width = this.widths.get(parent);
    if (width === undefined) {
      const layout = this.tree.getLayout(parent);
      width = /** @type {number} */ (/** @type {any} */ (layout).get('width'));
      layout.free();
      this.widths.set(parent, width);
    }
    const x = out[0];
    const w = out[2];
    const left = pb.border[3] + pb.padding[3];
    const right = width - pb.border[1] - pb.padding[1];
    const [, r, , l] = b.inset;
    const swap = b.margin[3] - b.margin[1];
    if (b.position === 'absolute') {
      const box = width - pb.border[1] - pb.border[3];
      if (r !== 'auto') out[0] = width - pb.border[1] - inset(r, box) - b.margin[1] - w;
      else if (l === 'auto') out[0] = left + right - x - w + swap;
      return;
    }
    // Taffy moved it by its left inset, else back by its right; right to left, the right one wins.
    const room = right - left;
    const moved = l !== 'auto' ? inset(l, room) : r !== 'auto' ? -inset(r, room) : 0;
    const by = r !== 'auto' ? -inset(r, room) : l !== 'auto' ? inset(l, room) : 0;
    out[0] = left + right - (x - moved) - w + swap + by;
  }

  close() {
    for (const copy of this.copies.values()) copy.free();
    this.copies.clear();
    for (const copies of this.held.values()) for (const copy of copies.values()) copy.free();
    this.held.clear();
    this.defined.clear();
    this.boxOf.clear();
    this.boxes.clear();
    this.empty.free();
    this.tree.free();
  }
}
