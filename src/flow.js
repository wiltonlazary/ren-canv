// A Flow: the primitives laid out by the layout engine and not drawn, for a
// renderer that draws them itself. ren-dom opts into it (its `layout`
// option): each of its primitives has an item here, and it places its
// elements at the boxes that come back instead of leaving layout to the
// browser. Layout runs in this thread, or in a layout worker
// (`remoteLayout`), as a Document's does.
//
// Each island (a primitive whose parent is not one: the top of a view) is
// laid out at the width it is given, beside the others in one tree, so one
// layout (one round trip with a worker) places them all.

import { Theme, styled } from 'ren-core/host';
import { Item, VIEW, TEXT, kindOf, assign, touch, link, unlink } from './scene.js';
import { Boxes } from './layout.js';
import { Local } from './engine.js';
import { BOLD, ITALIC, MONO, SLOT } from './text.js';
import { recent } from './sfnt.js';
import { down64 } from './units.js';

/** @typedef {import('./text.js').Fonts} Fonts */

/**
 * @typedef {object} FlowOptions
 * @property {import('ren-core/host').Tokens=} theme The theme's metrics (a field's height, an entry's width, the text size and leading), as the renderer's.
 * @property {import('./engine.js').LayoutPort=} layout Where the engine runs: this thread by default, or a layout worker (`remoteLayout(port)`).
 * @property {number=} scale Device pixels a logical one, which borders snap to as the browser snaps them: the window's devicePixelRatio by default (1 without one); `rescale` changes it.
 */

/** The primitives laid out without drawing. */
export class Flow {
  /** @param {Fonts} fonts what measures text, as the renderer sets it @param {FlowOptions} [options] */
  constructor(fonts, options = {}) {
    this.theme = new Theme(options.theme);
    this.fonts = fonts;
    this.boxes = new Boxes(fonts, this.theme, options.layout?.engine() ?? new Local(true));
    this.boxes.moved = new Set();
    this.boxes.scale = options.scale ?? /** @type {any} */ (globalThis).devicePixelRatio ?? 1;
    /** The islands' holder: each keeps the width it is given. */
    this.page = new Item(VIEW, '');
    this.page.style = styled({ align: 'start' });
    this.overlay = new Item(VIEW, '');
    /** The islands and the item holding each at its width. @type {Map<Item, Item>} */
    this.islands = new Map();
    /** @type {import('./engine.js').Spec} */
    this.spec = { root: 0, overlay: 0, width: 1, height: Infinity, bar: 0, gutter: false, fit: false };
    this.passes = 0;
    /** Something changed while a worker laid out. */
    this.again = false;
    /** What waits for the next layout. @type {((moved: Item[]) => void)[]} */
    this.waiting = [];
    this.closed = false;
  }

  /**
   * Borders snap to device pixels at a new `scale` (the page moved to
   * another screen, or zoomed): every item resolves again at the next
   * layout.
   * @param {number} scale
   */
  rescale(scale) {
    if (scale === this.boxes.scale) return;
    this.boxes.scale = scale;
    this.restyle();
  }

  /**
   * A new theme's metrics (a field's height, an entry's width, the text
   * size and leading), as ren-dom's `setTheme` gives them: every item
   * resolves again at the next layout (`arrange`).
   * @param {import('ren-core/host').Tokens} tokens
   */
  retheme(tokens) {
    const theme = new Theme(tokens);
    this.theme = theme;
    this.boxes.theme = theme;
    this.restyle();
  }

  /** Every item resolves again and is laid out at the next layout. */
  restyle() {
    /** @param {Item} n */
    const all = n => {
      n.stale = true;
      n.dirty = true;
      for (let c = n.first; c !== null; c = c.next) all(c);
    };
    all(this.page);
    all(this.overlay);
  }

  /** The item of a primitive (`View`, `Label`, …). @param {string} tag */
  node(tag) {
    const kind = kindOf(tag);
    if (kind < 0) throw new Error(`REN canv: ${tag} is not a primitive`);
    return new Item(kind, '');
  }

  /** The item of a text node inside a primitive. @param {string} text */
  text(text) {
    return new Item(TEXT, text);
  }

  /** @param {Item} item @param {string} text */
  content(item, text) {
    if (item.own === text) return;
    item.own = item.text = text;
    touch(item);
  }

  /** A portable property (`style`, `text`, `layout`, …). @param {Item} item @param {string} name @param {any} value */
  set(item, name, value) {
    if (assign(item, name, value) === 2) touch(item);
  }

  /** @param {Item} parent @param {Item} child @param {Item | null} before */
  insert(parent, child, before) {
    if (this.islands.has(child)) this.leave(child);
    link(parent, child, before);
  }

  /** @param {Item} parent @param {Item} child */
  remove(parent, child) {
    if (child.parent !== parent) return;
    unlink(child);
    this.boxes.drop(child);
  }

  /** Lays `item` out on its own at `width` (the top of a view). @param {Item} item @param {number} width */
  island(item, width) {
    let holder = this.islands.get(item);
    if (holder === undefined || item.parent !== holder) {
      if (item.parent !== null) unlink(item);
      holder = new Item(VIEW, '');
      this.islands.set(item, holder);
      link(this.page, holder, null);
      link(holder, item, null);
    }
    if (holder.width !== width) {
      holder.style = styled({ width, shrink: 0 });
      holder.width = width;
      touch(holder);
    }
  }

  /** `item` is no longer laid out on its own. @param {Item} item */
  leave(item) {
    const holder = this.islands.get(item);
    if (holder === undefined) return;
    this.islands.delete(item);
    if (item.parent === holder) unlink(item);
    unlink(holder);
    this.boxes.drop(holder);
    this.boxes.drop(item);
  }

  /**
   * Where an item's box starts in its containing block's padding box, as CSS
   * positions it: an island at its place in its holder, others inside
   * their parent's border (the nearest one with a box: a parent with none,
   * display contents, lays its children out as its own parent's).
   * @param {Item} item
   * @returns {[number, number]}
   */
  offset(item) {
    let parent = item.parent;
    if (parent === null || this.islands.has(item)) return [item.x, item.y];
    while (parent.flat && parent.parent !== null) parent = parent.parent;
    return [item.x - parent.r.bL, item.y - parent.r.bT];
  }

  /**
   * Lays out what changed; `done` gets the items whose boxes changed: at
   * once in this thread, when the answer comes from a worker.
   * @param {(moved: Item[]) => void} [done]
   */
  arrange(done) {
    if (this.closed) return;
    if (done !== undefined) this.waiting.push(done);
    if (this.boxes.engine.busy) {
      this.again = true;
      return;
    }
    this.passes = 0;
    this.lay();
  }

  lay() {
    const spec = this.spec;
    if (!this.boxes.prepare(this.page, this.overlay) && spec.root !== 0) {
      this.finish();
      return;
    }
    spec.root = this.page.node;
    spec.overlay = this.overlay.node;
    this.boxes.arrange(spec, () => this.placed());
  }

  placed() {
    if (this.closed) return;
    // Wrapping text takes the height of its rows at the width it got.
    const wrapped = this.passes < 3 && this.boxes.wraps();
    if (wrapped || this.again) {
      if (wrapped) this.passes++;
      this.again = false;
      this.lay();
      return;
    }
    this.finish();
  }

  finish() {
    const moved = /** @type {Set<Item>} */ (this.boxes.moved);
    const list = [...moved];
    moved.clear();
    const waiting = this.waiting;
    this.waiting = [];
    for (const done of waiting) done(list);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.boxes.close();
  }
}

/**
 * Fonts that measure with a 2D canvas context in a CSS font family, as the
 * browser sets DOM text in it (a Flow for ren-dom): `new
 * CanvasFonts(canvas.getContext('2d'), getComputedStyle(root).fontFamily)`.
 * @implements {Fonts}
 */
export class CanvasFonts {
  /** @param {any} context a CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D @param {string} family */
  constructor(context, family) {
    this.context = context;
    this.family = family;
    /**
     * Widths by face and set size (down to a 64th, as the browser sets
     * text), then text. As Sfnt's widths: at most 64 face and size pairs,
     * the least recently measured going first, so an animated font size
     * holds a bounded number. @type {Map<string, Map<string, number>>}
     */
    this.cache = new Map();
    /** The face and size key last measured and its widths: the common case skips reordering `cache`. */
    this.key = '';
    /** @type {Map<string, number>} */
    this.widths = new Map();
    this.font = '';
    /** The font-family lists a style named, by slot less one (`typeface`). @type {string[]} */
    this.lists = [];
  }

  /**
   * The slot of a CSS font-family list a style names: text in it measures
   * in that list, as the browser sets DOM text in it (its fallback per
   * character too).
   * @param {string} family
   */
  typeface(family) {
    const at = this.lists.indexOf(family);
    if (at >= 0) return at + 1;
    this.lists.push(family);
    return this.lists.length;
  }

  /** @param {number} size @param {number} face */
  set(size, face) {
    // The monospace face measures in the browser's monospace, as a DOM text set in it; a named family in its list.
    const slot = face >>> SLOT;
    const font = `${face & ITALIC ? 'italic ' : ''}${face & BOLD ? 'bold ' : ''}${size}px ${slot > 0 ? this.lists[slot - 1] : face & MONO ? 'monospace' : this.family}`;
    if (font !== this.font) {
      this.context.font = font;
      this.font = font;
    }
    return font;
  }

  /** @param {string} text @param {number} size @param {number} [face] */
  width(text, size, face = 0) {
    const set = down64(size);
    const key = `${face}|${set}`;
    let widths = this.widths;
    if (key !== this.key) {
      widths = this.widths = recent(this.cache, key, () => new Map());
      this.key = key;
    }
    let w = widths.get(text);
    if (w === undefined) {
      // Measured at the set size: every size that sets the same shares its widths.
      this.set(set, face);
      w = /** @type {number} */ (this.context.measureText(text).width);
      if (widths.size > 4096) widths.clear();
      widths.set(text, w);
    }
    return w;
  }

  /** @param {number} size @param {number} [face] */
  metrics(size, face = 0) {
    this.set(size, face);
    const m = this.context.measureText('M');
    return { ascent: m.fontBoundingBoxAscent ?? size * 0.8, descent: m.fontBoundingBoxDescent ?? size * 0.2 };
  }

  close() {
    this.cache.clear();
    this.key = '';
    this.widths = new Map();
  }
}
