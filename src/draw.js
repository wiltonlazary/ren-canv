// The painter: draws a laid-out scene into a flat
// command buffer, and records the hit regions of what it drew.
//
// A frame is numbers in `ops` (a Float64Array) and strings in `texts`. An
// opcode is the index of the command in the `commands` vocabulary below,
// and its operands follow it; text and image take the next string
// of `texts`, in command order:
//   0 text x y size color flags  (x at the start, y the baseline; flags: 1 bold, 2 italic, 4 monospace,
//                                 8 right to left: its characters drawn from x leftward, x its right edge,
//                                 and the typeface's slot from bit 4 (text.js SLOT; 0 the root one))
//   1 rect x y right bottom color
//   2 round x y right bottom color radius
//   3 clip x y right bottom      4 save    5 restore
//   6 line x y right bottom color width
//   7 oval x y right bottom color stroke
//   8 path color stroke closed count, then count coordinates
//   9 image x y right bottom
//  10 border x y right bottom color radius width  (a stroke inside the box, as CSS draws a border)
//  11 shadow x y right bottom color radius blur   (the box filled and blurred: CSS box-shadow's blur, sigma blur / 2)
//  12 layer alpha                                 (what follows until the matching restore, composited at alpha)
//  13 rclip x y right bottom tl tr br bl          (a clip to a box with rounded corners: their radii, top-left first)
//  14 rround x y right bottom color tl tr br bl   (a fill with its own radius at each corner)
//  15 rborder x y right bottom color width tl tr br bl  (a border, as 10, with its own radius at each corner)
//  16 rshadow x y right bottom color blur tl tr br bl   (a shadow, as 11, with its own radius at each corner)
//  17 dash cap count, then count lengths          (the strokes that follow are dashed so, on and off, until a dash of none; cap 1 rounds their ends)
//  18 edges x y right bottom tl tr br bl style top right bottom left, then the sides' colors top right bottom left
//                                                 (a border of its own width and color on each side, inside the box, split at
//                                                 the corners as CSS splits it; style 0 solid, 1 dashed, 2 dotted)
//  19 gradient x y right bottom tl tr br bl radial angle count, then count offset, color pairs
//                                                 (a box filled with a gradient: linear at an angle in degrees as CSS's,
//                                                 or radial from the center to the farthest corner)
//  20 transform a b c d e f                         (what follows until the matching restore is transformed so, as a canvas's transform())
//  21 picture x y right bottom fit                (an image fitted in its box, as CSS's object-fit: 1 contain, 2 cover, 3 none; clipped to it)
//  22 shade x y right bottom radial angle count, then count offset, color pairs
//                                                 (the next fill, a rect, round, oval or closed path, takes this gradient over
//                                                 the box, laid as 19's, in place of its color: a Shape figure's `fill`)
// Corner radii come scaled to fit their box, as CSS scales them.
// Colors are ARGB numbers. The buffers are reused from frame to frame.

import { SCROLL, LABEL, EDIT, ACTION, IMAGE, SHAPE, TEXT, Item, Resolved, shown, edited, compose, transformOf, pinAt, stickAt, portOf, holdOf, PLACE } from './scene.js';
import { active, holds, line, rowWidth, rowMeasure, textAt, rowIndex, dirOf, measureOf, indent } from './layout.js';
import { Lines, Seek, wraps, Runs, Face, RTL, baseline, textExtent, unit, order, xAt, marks } from './text.js';

import { argb, styled } from 'ren-core/host';

/** @typedef {import('./text.js').Fonts} Fonts */
/** @typedef {import('ren-core/host').Theme} Theme */

/**
 * Where an Action's caption sits in its content box (`cw` by `ch`), as
 * the DOM lays it out: one flex item (a column unless its direction is a
 * row), placed along by `justify` (the center unset) and across by
 * `align`; stretched across, as wide as the box, else as its widest line.
 * Its rows (split at line breaks: one string for one line), and its left,
 * top and width from the content box's origin.
 * @param {Fonts} fonts @param {string} text @param {Resolved} r @param {number} cw @param {number} ch
 * @returns {[readonly string[] | string, number, number, number]}
 */
export function captionOf(fonts, text, r, cw, ch) {
  const rows = text.indexOf('\n') < 0 ? text : text.split('\n');
  const tall = (typeof rows === 'string' ? 1 : rows.length) * line(r);
  const j = r.justify < 0 ? 1 : r.justify;
  // Along: start (between, with one item), center (around, evenly), end.
  const along = j === 0 || j === 3 ? 0 : j === 2 ? 1 : 0.5;
  const a = r.align;
  const across = a === 0 || a === 3 ? 0 : a === 2 ? 1 : 0.5;
  const wide = () => {
    let most = 0;
    for (const row of typeof rows === 'string' ? [rows] : rows) most = Math.max(most, fonts.width(row, r.size, r.face));
    return most;
  };
  if (r.row) {
    const width = wide();
    return [rows, (cw - width) * along, (ch - tall) * across, width];
  }
  if (a === 3) return [rows, 0, (ch - tall) * along, cw];
  const width = wide();
  return [rows, (cw - width) * across, (ch - tall) * along, width];
}

/**
 * Where a caption's row starts in its block `width` wide, as `lines`
 * aligns it by `textAlign`.
 * @param {Fonts} fonts @param {string} text @param {Resolved} r @param {number} width
 */
export function rowLeft(fonts, text, r, width) {
  const align = r.textAlign;
  if (align === 0) return 0;
  const advance = fonts.width(text, r.size, r.face);
  return align === 1 ? (width - advance) / 2 : width - advance;
}

export const TEXT_OP = 0;
export const RECT = 1;
export const ROUND = 2;
export const CLIP = 3;
export const SAVE = 4;
export const RESTORE = 5;
export const LINE = 6;
export const OVAL = 7;
export const PATH = 8;
export const IMAGE_OP = 9;
export const BORDER = 10;
export const SHADOW = 11;
export const LAYER = 12;
export const RCLIP = 13;
export const RROUND = 14;
export const RBORDER = 15;
export const RSHADOW = 16;
export const DASH = 17;
export const EDGES = 18;
export const GRADIENT = 19;
export const TRANSFORM = 20;
export const PICTURE = 21;
export const SHADE = 22;

/** Text flags. */
export const BOLD = 1;
export const ITALIC = 2;

/** The command names, indexed by opcode. */
export const commands = ['text', 'rect', 'round', 'clip', 'save', 'restore', 'line', 'oval', 'path', 'image', 'border', 'shadow', 'layer', 'rclip', 'rround', 'rborder', 'rshadow', 'dash', 'edges', 'gradient', 'transform', 'picture', 'shade'];

/** The number of operands of each opcode; a path adds its coordinates. */
export const operands = [5, 5, 6, 4, 0, 0, 6, 6, 4, 4, 7, 7, 1, 8, 9, 10, 10, 2, 17, 11, 6, 5, 7];

/** A flat drawing command buffer and its string table. */
export class Frame {
  constructor() {
    this.ops = new Float64Array(1024);
    /** The used length of `ops`. */
    this.n = 0;
    /** @type {string[]} */
    this.texts = [];
    /** The used length of `texts`. */
    this.t = 0;
  }

  reset() {
    this.n = 0;
    this.t = 0;
  }

  /** Ends a frame: drops strings left from a longer one. */
  end() {
    if (this.texts.length > this.t) this.texts.length = this.t;
  }

  /** Makes room for `count` more numbers. @param {number} count */
  room(count) {
    if (this.n + count <= this.ops.length) return this.ops;
    let size = this.ops.length * 2;
    while (size < this.n + count) size *= 2;
    const ops = new Float64Array(size);
    ops.set(this.ops.subarray(0, this.n));
    this.ops = ops;
    return ops;
  }

  /** @param {string} value @param {number} x @param {number} y the baseline @param {number} size @param {number} color @param {number} [flags] BOLD, ITALIC */
  text(value, x, y, size, color, flags = 0) {
    const o = this.room(6);
    const n = this.n;
    o[n] = TEXT_OP;
    o[n + 1] = x;
    o[n + 2] = y;
    o[n + 3] = size;
    o[n + 4] = color;
    o[n + 5] = flags;
    this.n = n + 6;
    this.texts[this.t++] = value;
  }

  /** A border or a shadow: a box, its color, radius and width or blur. @param {number} op BORDER or SHADOW @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} color @param {number} radius @param {number} extra */
  edge(op, x, y, right, bottom, color, radius, extra) {
    const o = this.room(8);
    const n = this.n;
    o[n] = op;
    o[n + 1] = x;
    o[n + 2] = y;
    o[n + 3] = right;
    o[n + 4] = bottom;
    o[n + 5] = color;
    o[n + 6] = radius;
    o[n + 7] = extra;
    this.n = n + 8;
  }

  /** Composites what follows, until the matching `leave`, at `alpha`. @param {number} alpha */
  layer(alpha) {
    const o = this.room(2);
    o[this.n] = LAYER;
    o[this.n + 1] = alpha;
    this.n += 2;
  }

  /** @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} color */
  rect(x, y, right, bottom, color) {
    const o = this.room(6);
    const n = this.n;
    o[n] = RECT;
    o[n + 1] = x;
    o[n + 2] = y;
    o[n + 3] = right;
    o[n + 4] = bottom;
    o[n + 5] = color;
    this.n = n + 6;
  }

  /** A round rect, line or oval, whose last operand is its radius, width or stroke. @param {number} op @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} color @param {number} extra */
  figure(op, x, y, right, bottom, color, extra) {
    const o = this.room(7);
    const n = this.n;
    o[n] = op;
    o[n + 1] = x;
    o[n + 2] = y;
    o[n + 3] = right;
    o[n + 4] = bottom;
    o[n + 5] = color;
    o[n + 6] = extra;
    this.n = n + 7;
  }

  /** Saves the canvas and clips it to a rectangle. @param {number} x @param {number} y @param {number} right @param {number} bottom */
  enter(x, y, right, bottom) {
    const o = this.room(6);
    const n = this.n;
    o[n] = SAVE;
    o[n + 1] = CLIP;
    o[n + 2] = x;
    o[n + 3] = y;
    o[n + 4] = right;
    o[n + 5] = bottom;
    this.n = n + 6;
  }

  /**
   * Saves the canvas and clips it to a box with rounded corners.
   * @param {number} x @param {number} y @param {number} right @param {number} bottom
   * @param {number} tl @param {number} tr @param {number} br @param {number} bl the corners' radii
   */
  rclip(x, y, right, bottom, tl, tr, br, bl) {
    const o = this.room(10);
    const n = this.n;
    o[n] = SAVE;
    o[n + 1] = RCLIP;
    o[n + 2] = x;
    o[n + 3] = y;
    o[n + 4] = right;
    o[n + 5] = bottom;
    o[n + 6] = tl;
    o[n + 7] = tr;
    o[n + 8] = br;
    o[n + 9] = bl;
    this.n = n + 10;
  }

  /**
   * A box with its own radius at each corner: a fill (RROUND, no extra), a
   * border (RBORDER, its width) or a shadow (RSHADOW, its blur).
   * @param {number} op @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} color
   * @param {number} extra @param {Float64Array} radii top-left, top-right, bottom-right, bottom-left
   */
  corners(op, x, y, right, bottom, color, extra, radii) {
    const o = this.room(11);
    let n = this.n;
    o[n] = op;
    o[n + 1] = x;
    o[n + 2] = y;
    o[n + 3] = right;
    o[n + 4] = bottom;
    o[n + 5] = color;
    n += 6;
    if (op !== RROUND) o[n++] = extra;
    o[n] = radii[0];
    o[n + 1] = radii[1];
    o[n + 2] = radii[2];
    o[n + 3] = radii[3];
    this.n = n + 4;
  }

  /**
   * Dashes the strokes that follow (SVG's stroke-dasharray: lengths on and
   * off), until a dash of none (null or empty).
   * @param {number} cap 1 rounds the dashes' ends (dots), 0 cuts them @param {readonly number[] | null} lengths
   */
  dash(cap, lengths) {
    const count = lengths === null ? 0 : lengths.length;
    const o = this.room(3 + count);
    const n = this.n;
    o[n] = DASH;
    o[n + 1] = cap;
    o[n + 2] = count;
    for (let k = 0; k < count; k++) o[n + 3 + k] = /** @type {readonly number[]} */ (lengths)[k];
    this.n = n + 3 + count;
  }

  /**
   * A border with each side's own width and color, inside a box with its
   * corners' radii.
   * @param {number} x @param {number} y @param {number} right @param {number} bottom @param {Float64Array} radii
   * @param {number} style 0 solid, 1 dashed, 2 dotted @param {Resolved} r its widths (bT, bR, bB, bL) and colors (bc, cR, cB, cL; -1 none)
   */
  edges(x, y, right, bottom, radii, style, r) {
    const o = this.room(18);
    const n = this.n;
    o[n] = EDGES;
    o[n + 1] = x;
    o[n + 2] = y;
    o[n + 3] = right;
    o[n + 4] = bottom;
    for (let k = 0; k < 4; k++) o[n + 5 + k] = radii[k];
    o[n + 9] = style;
    o[n + 10] = r.bT;
    o[n + 11] = r.bR;
    o[n + 12] = r.bB;
    o[n + 13] = r.bL;
    o[n + 14] = r.bc === -1 ? 0 : r.bc;
    o[n + 15] = r.cR === -1 ? 0 : r.cR;
    o[n + 16] = r.cB === -1 ? 0 : r.cB;
    o[n + 17] = r.cL === -1 ? 0 : r.cL;
    this.n = n + 18;
  }

  /**
   * A box filled with a gradient.
   * @param {number} x @param {number} y @param {number} right @param {number} bottom @param {Float64Array} radii
   * @param {{ radial: boolean, angle: number, stops: number[] }} g
   */
  gradient(x, y, right, bottom, radii, g) {
    const stops = g.stops;
    const o = this.room(12 + stops.length);
    const n = this.n;
    o[n] = GRADIENT;
    o[n + 1] = x;
    o[n + 2] = y;
    o[n + 3] = right;
    o[n + 4] = bottom;
    for (let k = 0; k < 4; k++) o[n + 5 + k] = radii[k];
    o[n + 9] = g.radial ? 1 : 0;
    o[n + 10] = g.angle;
    o[n + 11] = stops.length / 2;
    for (let k = 0; k < stops.length; k++) o[n + 12 + k] = stops[k];
    this.n = n + 12 + stops.length;
  }

  /**
   * The gradient the next fill takes over a box, in place of its color (a
   * Shape figure's `fill`).
   * @param {number} x @param {number} y @param {number} right @param {number} bottom
   * @param {{ radial: boolean, angle: number, stops: number[] }} g
   */
  shade(x, y, right, bottom, g) {
    const stops = g.stops;
    const o = this.room(8 + stops.length);
    const n = this.n;
    o[n] = SHADE;
    o[n + 1] = x;
    o[n + 2] = y;
    o[n + 3] = right;
    o[n + 4] = bottom;
    o[n + 5] = g.radial ? 1 : 0;
    o[n + 6] = g.angle;
    o[n + 7] = stops.length / 2;
    for (let k = 0; k < stops.length; k++) o[n + 8 + k] = stops[k];
    this.n = n + 8 + stops.length;
  }

  /** Saves the canvas and transforms what follows (until `leave`). @param {Float64Array} m a, b, c, d, e, f */
  transform(m) {
    const o = this.room(8);
    const n = this.n;
    o[n] = SAVE;
    o[n + 1] = TRANSFORM;
    for (let k = 0; k < 6; k++) o[n + 2 + k] = m[k];
    this.n = n + 8;
  }

  leave() {
    const o = this.room(1);
    o[this.n++] = RESTORE;
  }

  /** @param {number} color @param {number} stroke @param {boolean} closed @param {ArrayLike<number>} points @param {number} dx @param {number} dy */
  path(color, stroke, closed, points, dx, dy) {
    const count = points.length;
    const o = this.room(5 + count);
    let n = this.n;
    o[n] = PATH;
    o[n + 1] = color;
    o[n + 2] = stroke;
    o[n + 3] = closed ? 1 : 0;
    o[n + 4] = count;
    n += 5;
    for (let i = 0; i < count; i += 2) {
      o[n + i] = points[i] + dx;
      o[n + i + 1] = points[i + 1] + dy;
    }
    this.n = n + count;
  }

  /** @param {string} source @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} [fit] 0 fill (IMAGE), else contain 1, cover 2, none 3 (PICTURE) */
  image(source, x, y, right, bottom, fit = 0) {
    if (fit > 0) {
      const o = this.room(6);
      const n = this.n;
      o[n] = PICTURE;
      o[n + 1] = x;
      o[n + 2] = y;
      o[n + 3] = right;
      o[n + 4] = bottom;
      o[n + 5] = fit;
      this.n = n + 6;
      this.texts[this.t++] = source;
      return;
    }
    const o = this.room(5);
    const n = this.n;
    o[n] = IMAGE_OP;
    o[n + 1] = x;
    o[n + 2] = y;
    o[n + 3] = right;
    o[n + 4] = bottom;
    this.n = n + 5;
    this.texts[this.t++] = source;
  }
}

/** An ARGB color as `#aarrggbb`. @param {number} color */
export const hex = color => '#' + (color >>> 0).toString(16).padStart(8, '0');

/**
 * Decodes a frame into readable commands: `[name, ...operands]`, with the
 * string of a text or image first and colors as `#aarrggbb`. For tests and
 * debugging; hosts replay the buffer itself.
 * @param {Frame} frame
 * @returns {(string | number)[][]}
 */
export function decode(frame) {
  const o = frame.ops;
  /** @type {(string | number)[][]} */
  const out = [];
  let i = 0;
  let s = 0;
  while (i < frame.n) {
    const code = o[i++];
    const name = commands[code];
    if (name === undefined) throw new Error(`REN canv: unknown opcode ${code}`);
    /** @type {(string | number)[]} */
    const command = [name];
    if (code === TEXT_OP) command.push(frame.texts[s++], o[i], o[i + 1], o[i + 2], hex(o[i + 3]), o[i + 4]);
    else if (code === DASH) {
      command.push(o[i], o[i + 1]);
      for (let k = 0; k < o[i + 1]; k++) command.push(o[i + 2 + k]);
      i += o[i + 1];
    }
    else if (code === IMAGE_OP) command.push(frame.texts[s++], o[i], o[i + 1], o[i + 2], o[i + 3]);
    else if (code === PICTURE) command.push(frame.texts[s++], o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 4]);
    else if (code === PATH) {
      command.push(hex(o[i]), o[i + 1], o[i + 2], o[i + 3]);
      for (let k = 0; k < o[i + 3]; k++) command.push(o[i + 4 + k]);
      i += o[i + 3];
    } else if (code === RECT || code === ROUND || code === LINE || code === OVAL) {
      command.push(o[i], o[i + 1], o[i + 2], o[i + 3], hex(o[i + 4]));
      if (code !== RECT) command.push(o[i + 5]);
    } else if (code === BORDER || code === SHADOW) command.push(o[i], o[i + 1], o[i + 2], o[i + 3], hex(o[i + 4]), o[i + 5], o[i + 6]);
    else if (code === GRADIENT) {
      for (let k = 0; k < 11; k++) command.push(o[i + k]);
      for (let k = 0; k < o[i + 10]; k++) command.push(o[i + 11 + k * 2], hex(o[i + 12 + k * 2]));
      i += o[i + 10] * 2;
    } else if (code === SHADE) {
      for (let k = 0; k < 7; k++) command.push(o[i + k]);
      for (let k = 0; k < o[i + 6]; k++) command.push(o[i + 7 + k * 2], hex(o[i + 8 + k * 2]));
      i += o[i + 6] * 2;
    } else if (code === EDGES) {
      for (let k = 0; k < 13; k++) command.push(o[i + k]);
      for (let k = 13; k < 17; k++) command.push(hex(o[i + k]));
    } else if (code === RROUND || code === RBORDER || code === RSHADOW) {
      command.push(o[i], o[i + 1], o[i + 2], o[i + 3], hex(o[i + 4]));
      for (let k = 5; k < operands[code]; k++) command.push(o[i + k]);
    }
    else for (let k = 0; k < operands[code]; k++) command.push(o[i + k]);
    i += operands[code];
    out.push(command);
  }
  return out;
}

/** Hit regions in drawing order: an item and its clipped rectangle. */
export class Hits {
  /** @param {Space} [space] the transform regions are added in (shared with the painter) */
  constructor(space = new Space()) {
    this.space = space;
    /** @type {Item[]} */
    this.items = [];
    /**
     * x, y, right, bottom, then the origin x, y of each region: where an
     * edit's text starts. In the space of the transform it was drawn in.
     */
    this.box = new Float64Array(6 * 64);
    /** Each region's inverse transform (a point on screen into its space), when `bent`. */
    this.inv = new Float64Array(6 * 64);
    this.bent = new Uint8Array(64);
    this.n = 0;
    /** A point in a region's space, after `local`. */
    this.px = 0;
    this.py = 0;
  }

  reset() {
    this.n = 0;
  }

  /** @param {Item} item @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} ox @param {number} oy */
  add(item, x, y, right, bottom, ox, oy) {
    if (right <= x || bottom <= y) return;
    if ((this.n + 1) * 6 > this.box.length) {
      this.box = grow(this.box);
      this.inv = grow(this.inv);
      this.bent = grow(this.bent);
    }
    const b = this.box;
    const k = this.n * 6;
    const space = this.space;
    this.bent[this.n] = space.bent ? 1 : 0;
    if (space.bent) this.inv.set(space.inv, k);
    b[k] = x;
    b[k + 1] = y;
    b[k + 2] = right;
    b[k + 3] = bottom;
    b[k + 4] = ox;
    b[k + 5] = oy;
    this.items[this.n++] = item;
  }

  /** Maps a point on screen into region `i`'s space: `px`, `py`. @param {number} i @param {number} x @param {number} y */
  local(i, x, y) {
    if (this.bent[i] === 0) {
      this.px = x;
      this.py = y;
      return;
    }
    const m = this.inv;
    const k = i * 6;
    this.px = m[k] * x + m[k + 2] * y + m[k + 4];
    this.py = m[k + 1] * x + m[k + 3] * y + m[k + 5];
  }

  /** True when a point on screen is in region `i` (`px`, `py` hold it in its space). @param {number} i @param {number} x @param {number} y */
  inside(i, x, y) {
    this.local(i, x, y);
    const b = this.box;
    const k = i * 6;
    const px = this.px;
    const py = this.py;
    return px >= b[k] && px < b[k + 2] && py >= b[k + 1] && py < b[k + 3];
  }

  /** The topmost region under a point, or -1. @param {number} x @param {number} y */
  find(x, y) {
    for (let i = this.n - 1; i >= 0; i--) if (this.inside(i, x, y)) return i;
    return -1;
  }

  /** Drops references past the used length. */
  end() {
    if (this.items.length > this.n) this.items.length = this.n;
  }
}

/**
 * The transform being drawn in: `mat` maps its space onto the screen
 * (a, b, c, d, e, f as a canvas's), `inv` back; `bent` while it is not
 * the identity.
 */
export class Space {
  constructor() {
    this.bent = false;
    this.mat = Float64Array.of(1, 0, 0, 1, 0, 0);
    this.inv = Float64Array.of(1, 0, 0, 1, 0, 0);
  }
}

/** What a mark covers: a container's fill, an item's own drawing, or a scrollbar (the page's has no item). */
const FILL = 0;
const OWN = 1;
const BAR = 2;

/**
 * The drawn pieces of one frame: for each, its item and slot, the box its
 * pixels stay in, and its range of commands and strings. Comparing two
 * frames' marks by item finds what changed on screen.
 */
export class Marks {
  constructor() {
    /** @type {(Item | null)[]} */
    this.items = [];
    this.slots = new Uint8Array(256);
    /** x, y, right, bottom of each mark. */
    this.box = new Float64Array(4 * 256);
    /** The start and end of each mark in the frame's numbers, then in its strings. */
    this.spans = new Int32Array(4 * 256);
    /** True for each mark the next frame found unchanged. */
    this.kept = new Uint8Array(256);
    /**
     * The box each mark damages: its box, a pixel past it for a mark with an
     * antialiased edge along it (a rounded fill, a border, a shadow), within
     * the clip it was drawn in.
     */
    this.outer = new Float64Array(4 * 256);
    /**
     * Each mark's predecessor in painting order (its item, and its slot; 255
     * none) and whether it was drawn out of the flow's order (an absolute or
     * moved item, a stacking context): the order of such pieces can change
     * with nothing else, and must damage them.
     * @type {(Item | null)[]}
     */
    this.before = [];
    this.beforeSlots = new Uint8Array(256);
    this.loose = new Uint8Array(256);
    /**
     * 1 for each mark that clips exactly: plain axis-aligned fills on whole
     * device pixels, which a damage border cuts into the same pixels as a
     * whole repaint draws (nothing antialiased along it).
     */
    this.exact = new Uint8Array(256);
    this.n = 0;
    /** The mark of each item, by slot. @type {Map<Item | null, number>[]} */
    this.index = [new Map(), new Map(), new Map()];
  }

  reset() {
    this.n = 0;
    for (let s = 0; s < 3; s++) this.index[s].clear();
  }

  /** @param {Item | null} item @param {number} slot @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} o0 @param {number} o1 @param {number} t0 @param {number} t1 @param {boolean} [loose] drawn out of the flow's order */
  add(item, slot, x, y, right, bottom, o0, o1, t0, t1, loose = false) {
    if (o1 === o0) return;
    const n = this.n;
    if (n === this.slots.length) {
      this.slots = grow(this.slots);
      this.box = grow(this.box);
      this.spans = grow(this.spans);
      this.kept = grow(this.kept);
      this.outer = grow(this.outer);
      this.beforeSlots = grow(this.beforeSlots);
      this.loose = grow(this.loose);
      this.exact = grow(this.exact);
    }
    this.exact[n] = 0;
    this.before[n] = n > 0 ? this.items[n - 1] : null;
    this.beforeSlots[n] = n > 0 ? this.slots[n - 1] : 255;
    this.loose[n] = loose ? 1 : 0;
    this.items[n] = item;
    this.slots[n] = slot;
    const b = this.box;
    b[n * 4] = x;
    b[n * 4 + 1] = y;
    b[n * 4 + 2] = right;
    b[n * 4 + 3] = bottom;
    const s = this.spans;
    s[n * 4] = o0;
    s[n * 4 + 1] = o1;
    s[n * 4 + 2] = t0;
    s[n * 4 + 3] = t1;
    this.kept[n] = 0;
    const u = this.outer;
    u[n * 4] = x;
    u[n * 4 + 1] = y;
    u[n * 4 + 2] = right;
    u[n * 4 + 3] = bottom;
    this.index[slot].set(item, n);
    this.n = n + 1;
  }

  /** Drops references past the used length. */
  end() {
    if (this.items.length > this.n) this.items.length = this.n;
    if (this.before.length > this.n) this.before.length = this.n;
  }
}

/**
 * True when mark `i` of `a` and mark `j` of `b` (the same piece) moved in
 * painting order against a piece drawn out of the flow's order: what they
 * overlap stacks differently.
 * @param {Marks} a @param {number} i @param {Marks} b @param {number} j
 */
function reordered(a, i, b, j) {
  const loose = a.loose[i] | b.loose[j] | (i > 0 ? a.loose[i - 1] : 0) | (j > 0 ? b.loose[j - 1] : 0);
  return loose !== 0 && (a.before[i] !== b.before[j] || a.beforeSlots[i] !== b.beforeSlots[j]);
}

/**
 * A stacking context's child context, drawn in z order out of the tree's:
 * the item, where it is, and the clip it was met in.
 */
class Stacked {
  /** @param {Item} item @param {number} x0 @param {number} top0 @param {number} depth @param {number} left @param {number} top @param {number} right @param {number} bottom */
  constructor(item, x0, top0, depth, left, top, right, bottom) {
    this.item = item;
    this.x0 = x0;
    this.top0 = top0;
    this.depth = depth;
    this.left = left;
    this.top = top;
    this.right = right;
    this.bottom = bottom;
  }
}

/** True when an item's four corners share one radius. @param {Resolved} r */
const even = r => r.rtl === r.rtr && r.rtl === r.rbr && r.rtl === r.rbl;

/** A transform's inverse, or null when it flattens (a scale of 0). @param {Float64Array} m */
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0 || det !== det) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return Float64Array.of(a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5]));
}

/** A transform that maps everything out of reach: a flat item takes no pointer. */
const NOWHERE = Float64Array.of(0, 0, 0, 0, -Infinity, -Infinity);

/** The bounds of a transformed box, reused: left, top, right, bottom. */
const BOUNDS = new Float64Array(4);
/** Sets BOUNDS to the bounds of a box transformed by `m`. @param {Float64Array} m @param {number} x @param {number} y @param {number} right @param {number} bottom */
function bounds(m, x, y, right, bottom) {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (let k = 0; k < 4; k++) {
    const px = k & 1 ? right : x;
    const py = k & 2 ? bottom : y;
    const tx = m[0] * px + m[2] * py + m[4];
    const ty = m[1] * px + m[3] * py + m[5];
    if (tx < l) l = tx;
    if (tx > r) r = tx;
    if (ty < t) t = ty;
    if (ty > b) b = ty;
  }
  BOUNDS[0] = l;
  BOUNDS[1] = t;
  BOUNDS[2] = r;
  BOUNDS[3] = b;
}

/** An ARGB color with its alpha times `opacity`. @param {number} color @param {number} opacity */
const faded = (color, opacity) => (color === -1 ? -1 : ((Math.round(((color >>> 24) & 255) * Math.max(0, opacity)) << 24) | (color & 0xffffff)) >>> 0);

/** A dash pattern, reused. */
const PATTERN = [0, 0];

/**
 * The dashes of a border style along a stroke of width `w`, as browsers
 * draw them: dashed, dashes and gaps three widths long; dotted, round dots
 * a width across, a width apart.
 * @param {number} style 1 dashed, 2 dotted @param {number} w
 */
function dashes(style, w) {
  PATTERN[0] = style === 2 ? 0 : 3 * w;
  PATTERN[1] = style === 2 ? 2 * w : 3 * w;
  return PATTERN;
}

/** Corner radii, reused. */
const RADII = new Float64Array(4);

/**
 * An item's corner radii grown by `by` (a ring's offset; negative: the
 * inner curve inside a border), none below 0, then scaled to fit a box as
 * CSS scales them (no two corners on a side reach past it), into RADII.
 * @param {Resolved} r @param {number} w @param {number} h @param {number} by
 */
function radii(r, w, h, by) {
  const tl = r.rtl > 0 ? Math.max(0, r.rtl + by) : 0;
  const tr = r.rtr > 0 ? Math.max(0, r.rtr + by) : 0;
  const br = r.rbr > 0 ? Math.max(0, r.rbr + by) : 0;
  const bl = r.rbl > 0 ? Math.max(0, r.rbl + by) : 0;
  /** @param {number} side @param {number} sum */
  const fit = (side, sum) => (sum > side ? side / sum : 1);
  const f = Math.max(0, Math.min(fit(w, tl + tr), fit(w, bl + br), fit(h, tl + bl), fit(h, tr + br)));
  RADII[0] = tl * f;
  RADII[1] = tr * f;
  RADII[2] = br * f;
  RADII[3] = bl * f;
  return RADII;
}

/** Orders stacked contexts by z; a stable sort keeps equal ones in tree order. @param {Stacked} a @param {Stacked} b */
const byZ = (a, b) => /** @type {number} */ (a.item.r.z) - /** @type {number} */ (b.item.r.z);

/** True when an item is drawn out of the flow's order: absolute, moved by its insets, or a stacking context with a z. @param {Resolved} r */
const loosened = r => r.abs || r.tf || r.z === r.z || r.top === r.top || r.right === r.right || r.bottom === r.bottom || r.left === r.left;

/**
 * The rectangles of a frame that differ from the previous one, merged:
 * overlapping or close rectangles join; past `LIMIT`, a new one joins the
 * rectangle whose union grows least, so distant changes stay apart.
 */
export class Damage {
  constructor() {
    this.box = new Float64Array(4 * LIMIT);
    this.n = 0;
    /** Their bounds. */
    this.left = 0;
    this.top = 0;
    this.right = 0;
    this.bottom = 0;
  }

  reset() {
    this.n = 0;
  }

  /**
   * Adds a rectangle, rounded out to whole pixels and clamped to `width` ×
   * `height`. Marks already hold everything they draw (their clip, a focus
   * ring's margin), so no margin is added.
   * @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} width @param {number} height
   */
  add(x, y, right, bottom, width, height) {
    x = Math.max(0, Math.floor(x));
    y = Math.max(0, Math.floor(y));
    right = Math.min(width, Math.ceil(right));
    bottom = Math.min(height, Math.ceil(bottom));
    if (right <= x || bottom <= y) return;
    const b = this.box;
    // Join any rectangle this one touches or nearly touches, until none does.
    for (let i = 0; i < this.n; i++) {
      const k = i * 4;
      if (x > b[k + 2] + 8 || right < b[k] - 8 || y > b[k + 3] + 8 || bottom < b[k + 1] - 8) continue;
      x = Math.min(x, b[k]);
      y = Math.min(y, b[k + 1]);
      right = Math.max(right, b[k + 2]);
      bottom = Math.max(bottom, b[k + 3]);
      this.n--;
      const last = this.n * 4;
      b[k] = b[last];
      b[k + 1] = b[last + 1];
      b[k + 2] = b[last + 2];
      b[k + 3] = b[last + 3];
      i = -1;
    }
    if (this.n === LIMIT) {
      // Full: the new one joins the rectangle whose union grows least, so
      // distant changes stay apart (a busy screen is not one whole repaint).
      let best = 0;
      let cost = Infinity;
      for (let i = 0; i < this.n; i++) {
        const k = i * 4;
        const grown = (Math.max(right, b[k + 2]) - Math.min(x, b[k])) * (Math.max(bottom, b[k + 3]) - Math.min(y, b[k + 1])) - (b[k + 2] - b[k]) * (b[k + 3] - b[k + 1]);
        if (grown < cost) {
          cost = grown;
          best = i;
        }
      }
      const k = best * 4;
      const [bx, by, br, bb] = [Math.min(x, b[k]), Math.min(y, b[k + 1]), Math.max(right, b[k + 2]), Math.max(bottom, b[k + 3])];
      this.n--;
      const last = this.n * 4;
      b[k] = b[last];
      b[k + 1] = b[last + 1];
      b[k + 2] = b[last + 2];
      b[k + 3] = b[last + 3];
      // The union may now touch others: add it again.
      this.add(bx, by, br, bb, width, height);
      return;
    }
    const k = this.n * 4;
    b[k] = x;
    b[k + 1] = y;
    b[k + 2] = right;
    b[k + 3] = bottom;
    this.n++;
  }

  /** The total area and the bounds of the rectangles. */
  area() {
    const b = this.box;
    let sum = 0;
    this.left = this.top = Infinity;
    this.right = this.bottom = -Infinity;
    for (let i = 0; i < this.n; i++) {
      const k = i * 4;
      sum += (b[k + 2] - b[k]) * (b[k + 3] - b[k + 1]);
      this.left = Math.min(this.left, b[k]);
      this.top = Math.min(this.top, b[k + 1]);
      this.right = Math.max(this.right, b[k + 2]);
      this.bottom = Math.max(this.bottom, b[k + 3]);
    }
    return sum;
  }
}

/**
 * True when mark `i` of frame `a` draws exactly what mark `j` of frame `b`
 * drew: the same box, commands and strings.
 * @param {Frame} a @param {Marks} am @param {number} i @param {Frame} b @param {Marks} bm @param {number} j
 */
function same(a, am, i, b, bm, j) {
  const x = am.box;
  const y = bm.box;
  const k = i * 4;
  const l = j * 4;
  if (x[k] !== y[l] || x[k + 1] !== y[l + 1] || x[k + 2] !== y[l + 2] || x[k + 3] !== y[l + 3]) return false;
  const s = am.spans;
  const r = bm.spans;
  const o0 = s[k];
  const count = s[k + 1] - o0;
  const p0 = r[l];
  if (count !== r[l + 1] - p0 || s[k + 3] - s[k + 2] !== r[l + 3] - r[l + 2]) return false;
  const ao = a.ops;
  const bo = b.ops;
  for (let n = 0; n < count; n++) if (ao[o0 + n] !== bo[p0 + n]) return false;
  const at = a.texts;
  const bt = b.texts;
  for (let n = s[k + 2], m = r[l + 2]; n < s[k + 3]; n++, m++) if (at[n] !== bt[m]) return false;
  return true;
}

/** A typed array twice as long, with the same start. @template {Uint8Array | Int32Array | Float64Array} T @param {T} a @returns {T} */
function grow(a) {
  const b = /** @type {T} */ (new /** @type {any} */ (a.constructor)(a.length * 2));
  b.set(a);
  return b;
}

/** Damage rectangles kept apart at most; more collapse into their bounds. */
const LIMIT = 16;

/** What the painter needs from the renderer for one frame. */
export class State {
  constructor() {
    this.width = 0;
    this.height = 0;
    /** @type {Item | null} */
    this.focus = null;
    this.caret = 0;
    /** The caret at a soft wrap shows at the end of the row before (the Document's `upstream`). */
    this.upstream = false;
    /** The fixed end of the focused edit's selection. */
    this.anchor = 0;
    /** Where the focused edit's IME composition starts (-1: none), and its length. */
    this.from = -1;
    this.span = 0;
    /** Draw the focus ring on a focused Action (keyboard focus). */
    this.ring = false;
    /** The page scroll offset. */
    this.page = 0;
    /** Device pixels per logical pixel: boxes snap to them. */
    this.scale = 1;
  }
}

/** Draws a scene into a frame and records its hit regions. */
/**
 * The items that draw the ring a focused item hands on (its `ring` false):
 * the items inside it marked outer, or, with none, the nearest item around
 * it marked inner; null when the focus shows no ring or keeps its own. A
 * field shows its ring whenever it has the focus, an Action or a region
 * when the keyboard gave it.
 * @param {State} state @returns {Item[] | null}
 */
function handed(state) {
  const focus = state.focus;
  if (focus === null || !(focus.kind === EDIT || state.ring) || focus.r.ring !== 0) return null;
  /** @type {Item[]} */
  const out = [];
  const inside = (/** @type {Item} */ n) => {
    for (let c = n.first; c !== null; c = c.next) {
      if (c.r.ring === 3) out.push(c);
      inside(c);
    }
  };
  inside(focus);
  if (out.length > 0) return out;
  for (let n = focus.parent; n !== null; n = n.parent) if (n.r.ring === 2) return [n];
  return null;
}

export class Painter {
  /** @param {Fonts} fonts @param {Theme} theme @param {import('./layout.js').Boxes} boxes the layout, read as items are drawn */
  constructor(fonts, theme, boxes) {
    this.fonts = fonts;
    this.theme = theme;
    this.boxes = boxes;
    this.frame = new Frame();
    /** The previous frame; the two swap on each draw. */
    this.back = new Frame();
    /** The drawn pieces of this frame and of the previous one. */
    this.marks = new Marks();
    this.last = new Marks();
    /** What differs between the two, after `compare`. */
    this.damage = new Damage();
    /** The transform being drawn in; hit regions and marks read it. */
    this.space = new Space();
    /** Press, hover and focus targets. */
    this.hits = new Hits(this.space);
    /** Every box drawn but the page's and the overlay's, in painting order: what is topmost under a point, as the DOM's hit test finds an element. */
    this.covers = new Hits(this.space);
    /** Scrolling regions. */
    this.regions = new Hits(this.space);
    /** Text the pointer reaches (selectable or not): each Label's (or text node's) visible box and its content origin. */
    this.texts = new Hits(this.space);
    this.state = new State();
    /** The stacking contexts met in the current one, drawn over its children (null: none yet). @type {Stacked[] | null} */
    this.stacked = null;
    /** Above 0 while drawing out of the flow's order: its marks keep their order. */
    this.loose = 0;
    /** The fixed items met in the layer being drawn, drawn after it (null: none). @type {Stacked[] | null} */
    this.pinned = null;
    /** The items drawing the focus ring a focused item hands on (`ring: false`), this frame; null: none. @type {Item[] | null} */
    this.ringed = null;
    /** The scrollport a sticky item is held in, left, top, right, bottom: the nearest Scroll's (`portOf`), else the viewport. */
    this.port = new Float64Array(4);
    /**
     * The box a sticky item is held within, left, top, right, bottom: its
     * containing block's content box (`holdOf`), the nearest ancestor that
     * makes a box (a child of a boxless one, display contents, is held in
     * its parent's).
     */
    this.hold = new Float64Array(4);
    // The current clip, for hit regions.
    this.left = 0;
    this.top = 0;
    this.right = 0;
    this.bottom = 0;
  }

  /**
   * Draws a frame: the page and the overlay layer, clipped to the viewport,
   * then the page scrollbar when the page overflows.
   * @param {Item} root @param {Item} overlay @param {number} limit the page scroll limit
   */
  draw(root, overlay, limit) {
    const frame = this.back;
    this.back = this.frame;
    this.frame = frame;
    const marks = this.last;
    this.last = this.marks;
    this.marks = marks;
    const state = this.state;
    const theme = this.theme;
    frame.reset();
    marks.reset();
    this.stacked = null;
    this.loose = 0;
    this.hits.reset();
    this.covers.reset();
    this.regions.reset();
    this.texts.reset();
    this.left = 0;
    this.top = 0;
    // The page's content stops at its scrollbar, as a browser's does.
    const page = limit > 0 ? state.width - theme.bar : state.width;
    this.right = page;
    this.bottom = state.height;
    frame.enter(0, 0, page, state.height);
    this.viewport(page, state.height);
    this.ringed = handed(state);
    this.pinned = null;
    this.visit(root, 0, -state.page, 0);
    this.pin(page, state.height);
    frame.leave();
    this.right = state.width;
    frame.enter(0, 0, state.width, state.height);
    this.viewport(state.width, state.height);
    this.visit(overlay, 0, 0, 0);
    this.pin(state.width, state.height);
    frame.leave();
    if (limit > 0) {
      const h = state.height;
      const length = Math.min(h, Math.max(28, (h * h) / (h + limit)));
      const start = ((h - length) * state.page) / limit;
      const o = frame.n;
      frame.rect(state.width - theme.bar, 0, state.width, h, theme.soft);
      frame.figure(ROUND, state.width - theme.bar + 1, start + 1, state.width - 1, start + length - 1, theme.muted, 3);
      marks.add(null, BAR, state.width - theme.bar, 0, state.width, h, o, frame.n, frame.t, frame.t);
    }
    frame.end();
    marks.end();
    this.hits.end();
    this.covers.end();
    this.regions.end();
    this.texts.end();
  }

  /**
   * Draws an item with its border box at `x0`, `top0` (layout's; the paint
   * snaps them). Items paint in tree order, except stacking contexts (an
   * item with a z, or an opacity below 1, and the page and the overlay):
   * the contexts met inside one with a negative z paint over its own box
   * and under its children, those with a positive z over its children, each
   * in z order and equal ones in tree order; a z of 0 (or an opacity alone)
   * paints in place. Hit regions follow the painting order, so the topmost
   * takes the pointer.
   * @param {Item} item @param {number} x0 @param {number} top0 @param {number} depth
   */
  visit(item, x0, top0, depth) {
    this.boxes.fix(item);
    if (item.r.tf) this.bend(item, x0, top0, depth);
    else this.box(item, x0, top0, depth);
  }

  /**
   * Draws a transformed item (scale, rotate, translate about its origin, as
   * CSS's translate, rotate and scale): in its transform, which hit
   * regions and marks follow, and the clip taken into its space.
   * @param {Item} item @param {number} x0 @param {number} top0 @param {number} depth
   */
  bend(item, x0, top0, depth) {
    const r = item.r;
    const scale = this.state.scale;
    const x = Math.round(x0 * scale) / scale;
    const top = Math.round(top0 * scale) / scale;
    const w = Math.round((x0 + item.w) * scale) / scale - x;
    const h = Math.round((top0 + item.h) * scale) / scale - top;
    const m = transformOf(r, x, top, w, h);
    const space = this.space;
    const was = Float64Array.from(space.mat);
    const back = Float64Array.from(space.inv);
    const bent = space.bent;
    const { left: l, top: t, right: rt, bottom: b } = this;
    // The clip in the item's space: the bounds of its corners there.
    const inv = invert(m);
    if (inv !== null) {
      bounds(inv, l, t, rt, b);
      this.left = BOUNDS[0];
      this.top = BOUNDS[1];
      this.right = BOUNDS[2];
      this.bottom = BOUNDS[3];
    } else this.right = this.left;
    space.mat.set(compose(was, m));
    space.inv.set(inv === null ? NOWHERE : compose(inv, back));
    space.bent = true;
    this.frame.transform(m);
    this.box(item, x0, top0, depth);
    this.frame.leave();
    space.mat.set(was);
    space.inv.set(back);
    space.bent = bent;
    this.left = l;
    this.top = t;
    this.right = rt;
    this.bottom = b;
  }

  /**
   * Draws an item in the current transform (`visit`'s).
   * @param {Item} item @param {number} x0 @param {number} top0 @param {number} depth
   */
  box(item, x0, top0, depth) {
    const r = item.r;
    // Boxes snap to device pixels, as browsers paint them: layout keeps its
    // fractions (a line box 23.8 high), and neighbors share an exact edge.
    const scale = this.state.scale;
    const x = Math.round(x0 * scale) / scale;
    const top = Math.round(top0 * scale) / scale;
    const w = Math.round((x0 + item.w) * scale) / scale - x;
    const bottom = Math.round((top0 + item.h) * scale) / scale;
    // A shadow reaches past the box.
    const reach = r.shColor !== -1 ? r.shBlur + Math.max(Math.abs(r.shX), Math.abs(r.shY)) : 0;
    // Out of view: nothing to draw, unless a child placed out of the flow
    // may show where its parent does not, or its content overflows its box
    // into view (a box of no height holding text), and no clip hides it.
    const hidden = item.h <= 0 || bottom + reach <= this.top || top - reach >= this.bottom;
    // An item with no box (display: contents) is empty where its children are not.
    if (hidden && !item.pins && !r.contents && (r.clip || (!item.placed && !(item.content > item.h && top0 + item.content > this.top && top < this.bottom)))) return;
    const kind = item.kind;
    const input = kind === EDIT || kind === ACTION;
    const state = this.state;
    const frame = this.frame;
    const o = frame.n;
    const t = frame.t;
    // An opacity below 1 composites the item as a layer, unless it draws
    // one fill and nothing else (an empty box with a background, no border,
    // shadow or ring): then the fill's own alpha is the same picture, with no
    // offscreen layer (a pulsing skeleton).
    const focusedBox = item === this.state.focus || (this.ringed !== null && this.ringed.includes(item));
    const alone = r.opacity < 1 && item.first === null && holds(item) && r.bw === 0 && r.shColor === -1 && r.grad === null && !focusedBox;
    const layered = r.opacity < 1 && !alone;
    const bg = alone ? faded(r.bg, r.opacity) : r.bg;
    const context = depth === 0 || r.opacity < 1 || r.z === r.z || r.tf;
    const loose = loosened(r);
    if (loose) this.loose++;
    /** @type {Stacked[] | null} */
    const outer = this.stacked;
    if (context) this.stacked = null;
    if (layered) frame.layer(Math.max(0, r.opacity));
    // A field shows its ring whenever it has the focus; an Action, or a region given a tabIndex, when the keyboard gave it.
    // An item that hands its ring on draws none; the items it hands it to draw it.
    const focused = (item === state.focus && (kind === EDIT || state.ring) && r.ring !== 0) || (this.ringed !== null && this.ringed.includes(item));
    const edged = r.radius > 0 || r.bw > 0 || r.shColor !== -1 || focused;
    if (!hidden) {
      // The box: shadow, background, border, focus ring.
      // Corners of one radius draw as a rounded box; four radii take the corner commands.
      const one = even(r);
      const h = bottom - top;
      if (r.shColor !== -1) {
        if (one) frame.edge(SHADOW, x + r.shX, top + r.shY, x + w + r.shX, bottom + r.shY, r.shColor, r.radius, r.shBlur);
        else frame.corners(RSHADOW, x + r.shX, top + r.shY, x + w + r.shX, bottom + r.shY, r.shColor, r.shBlur, radii(r, w, h, 0));
      }
      if (r.grad !== null) frame.gradient(x, top, x + w, bottom, radii(r, w, h, 0), r.grad);
      else if (r.bg !== -1) {
        if (r.radius === 0) frame.rect(x, top, x + w, bottom, bg);
        else if (one) frame.figure(ROUND, x, top, x + w, bottom, bg, r.radius);
        else frame.corners(RROUND, x, top, x + w, bottom, bg, 0, radii(r, w, h, 0));
      }
      if (r.bw > 0) {
        if (r.bT === r.bR && r.bT === r.bB && r.bT === r.bL && r.bc === r.cR && r.bc === r.cB && r.bc === r.cL) {
          // One width and color: a stroke, dashed or dotted by its style.
          if (r.bc !== -1) {
            if (r.bs !== 0) frame.dash(r.bs === 2 ? 1 : 0, dashes(r.bs, r.bw));
            if (one) frame.edge(BORDER, x, top, x + w, bottom, r.bc, r.radius, r.bw);
            else frame.corners(RBORDER, x, top, x + w, bottom, r.bc, r.bw, radii(r, w, h, 0));
            if (r.bs !== 0) frame.dash(0, null);
          }
        } else frame.edges(x, top, x + w, bottom, radii(r, w, h, 0), r.bs, r);
      }
      if (focused) {
        // The focus ring: a 2 wide stroke just outside the box, as the DOM's
        // outline, so a box with no background of its own shows no fill.
        const ring = item.get('focus') ?? this.theme.label;
        if (one) frame.edge(BORDER, x - 2, top - 2, x + w + 2, bottom + 2, ring, r.radius + 2, 2);
        else frame.corners(RBORDER, x - 2, top - 2, x + w + 2, bottom + 2, ring, 2, radii(r, w + 4, h + 4, 2));
      }
      // Pieces keep their box (neighbors only touch), past it only what they
      // draw there: a shadow, a focus ring (2 out).
      const grow = Math.max(reach, focused ? 3 : 0);
      if (frame.n > o) this.mark(item, FILL, x - grow, top - grow, x + w + grow, bottom + grow, o, t, edged);
      // A target for the pointer: what takes input, changes on hover or press, or shows a cursor.
      if (item.presses || item.pointers || input || item.style.hover !== null || item.style.press !== null || item.style.cursor !== null) this.hit(item, x, top, x + w, bottom, x, top);
      if (depth > 0 && r.events) this.covers.add(item, Math.max(x, this.left), Math.max(top, this.top), Math.min(x + w, this.right), Math.min(bottom, this.bottom), x, top);
    }
    // Negative contexts below paint over the box, under the children.
    if (context && item.sunk) this.under(item, x0, top0, x, top, w, bottom, depth);
    // With no box, it is a target of the pointer where its children are (the DOM's hit reaches it through them).
    if (r.contents && (item.presses || item.pointers || item.style.hover !== null || item.style.press !== null || item.style.cursor !== null)) this.through(item, x0, top0);
    if (holds(item)) {
      if (kind === SCROLL && !r.contents) this.scroller(item, x, top, w, bottom - top, x0, top0, depth);
      else {
        const clip = r.clip;
        const { left: l, top: tp, right: rt, bottom: b } = this;
        if (clip) this.clip(x + r.bL, top + r.bT, x + w - r.bR, bottom - r.bB, r);
        // Children of a column come top to bottom: the rest are below the
        // clip, unless one is placed out of the flow.
        const ordered = !r.row && !r.grid && !item.placed;
        // Sticky children are held within this item's content box; with no box, within the one around it.
        const hold = this.hold;
        const hl = hold[0];
        const ht = hold[1];
        const hr = hold[2];
        const hb = hold[3];
        if (!r.contents) holdOf(item, x0, top0, x0, top0, hold);
        for (let c = item.first; c !== null; c = c.next)
          if (active(c)) {
            this.boxes.fix(c);
            if (ordered && top0 + c.y >= this.bottom) break;
            if (c.r.sticky) {
              // Held in the scrollport, within its containing block's content box.
              stickAt(c, x0 + c.x, top0 + c.y, this.port, hold);
              this.child(c, PLACE[0], PLACE[1], depth + 1);
            } else this.child(c, x0 + c.x, top0 + c.y, depth + 1);
          }
        hold[0] = hl;
        hold[1] = ht;
        hold[2] = hr;
        hold[3] = hb;
        if (clip) {
          frame.leave();
          this.left = l;
          this.top = tp;
          this.right = rt;
          this.bottom = b;
        }
      }
    } else {
      const o2 = frame.n;
      const t2 = frame.t;
      // Content: the text and figures keep layout's fractions.
      const cx = x0 + r.bL + r.pl;
      const cy = top0 + r.bT + r.pt;
      const cw = item.w - r.bL - r.bR - r.pl - r.pr;
      const ch = item.h - r.bT - r.bB - r.pt - r.pb;
      if (kind === LABEL || kind === TEXT) {
        frame.enter(x, top, x + w, bottom);
        if (item.rows !== null) {
          if (item.from >= 0) this.highlight(item, r, cx, cw, cy);
          if (item.spans !== null) this.spanned(item, r, cx, cw, cy);
          else this.lines(item.rows, r, cx, cw, cy, r.textAlign, item.levels);
        }
        frame.leave();
        // Every text the pointer reaches, selectable or not (the Document asks which are: `selectable`).
        if (r.events) this.texts.add(item, Math.max(x, this.left), Math.max(top, this.top), Math.min(x + w, this.right), Math.min(bottom, this.bottom), cx, cy);
      } else if (input) {
        this.control(item, x, top, w, bottom, cx, cy, cw, ch);
        // An Action's own text is a text the pointer reaches too (the root's text actions find it; selectText opens it).
        if (kind === ACTION && r.events && item.text !== '') this.texts.add(item, Math.max(x, this.left), Math.max(top, this.top), Math.min(x + w, this.right), Math.min(bottom, this.bottom), cx, cy);
      } else if (kind === IMAGE) {
        if (item.source !== null) frame.image(item.source, cx, cy, cx + cw, cy + ch, r.fit);
      } else if (kind === SHAPE) this.figures(item, cx, cy, cw, ch);
      // A control's text sits on its rounded fill: typing damages that edge too.
      if (frame.n > o2) this.mark(item, OWN, x, top, x + w, bottom, o2, t2, input && edged);
    }
    // The positive contexts met inside paint over everything else in this one.
    if (context) {
      const stacked = this.stacked;
      this.stacked = outer;
      if (stacked !== null) {
        stacked.sort(byZ);
        for (let i = 0; i < stacked.length; i++) this.stack(stacked[i]);
      }
    }
    if (layered) frame.leave();
    if (loose) this.loose--;
  }

  /**
   * A child met in the tree: drawn in place, or kept for its context when it
   * is a stacking context with a z (a negative one was drawn already).
   * @param {Item} c @param {number} x0 @param {number} top0 @param {number} depth
   */
  child(c, x0, top0, depth) {
    if (c.r.fixed) {
      // Placed against the viewport after its layer, over its scroll and clips.
      (this.pinned ??= []).push(new Stacked(c, x0, top0, depth, 0, 0, 0, 0));
      return;
    }
    const z = c.r.z;
    if (z === z && z !== 0) {
      if (z > 0) (this.stacked ??= []).push(new Stacked(c, x0, top0, depth, this.left, this.top, this.right, this.bottom));
      return;
    }
    this.visit(c, x0, top0, depth);
  }

  /**
   * Draws the fixed items met in a layer, in z order (equal ones in tree
   * order), placed by their insets against the viewport (`width` ×
   * `height`; without an inset on an axis, where the flow put them), clipped
   * to it alone.
   * @param {number} width @param {number} height
   */
  pin(width, height) {
    const list = this.pinned;
    this.pinned = null;
    if (list === null) return;
    list.sort((a, b) => (a.item.r.z || 0) - (b.item.r.z || 0));
    const { left: l, top: t, right: rt, bottom: b } = this;
    for (const s of list) {
      const c = s.item;
      pinAt(c, width, height, s.x0, s.top0);
      const x0 = PLACE[0];
      const top0 = PLACE[1];
      this.left = 0;
      this.top = 0;
      this.right = width;
      this.bottom = height;
      this.frame.enter(0, 0, width, height);
      this.loose++;
      this.visit(c, x0, top0, s.depth);
      this.loose--;
      this.frame.leave();
      // What a fixed item holds may be fixed too: after it.
      if (this.pinned !== null) this.pin(width, height);
    }
    this.left = l;
    this.top = t;
    this.right = rt;
    this.bottom = b;
  }

  /** Holds sticky items in the viewport, `width` by `height`, until a Scroll's scrollport. @param {number} width @param {number} height */
  viewport(width, height) {
    const port = this.port;
    port[0] = port[1] = 0;
    port[2] = width;
    port[3] = height;
  }

  /** Draws a stacked context in the clip it was met in. @param {Stacked} s */
  stack(s) {
    const { left: l, top: tp, right: rt, bottom: b } = this;
    this.frame.enter(s.left, s.top, s.right, s.bottom);
    this.left = s.left;
    this.top = s.top;
    this.right = s.right;
    this.bottom = s.bottom;
    this.visit(s.item, s.x0, s.top0, s.depth);
    this.frame.leave();
    this.left = l;
    this.top = tp;
    this.right = rt;
    this.bottom = b;
  }

  /**
   * Draws the negative stacking contexts of a context, in z order: found
   * through its children the way they are drawn (their places, scrolls and
   * clips), not into other contexts.
   * @param {Item} item @param {number} x0 @param {number} top0 @param {number} x @param {number} top @param {number} w @param {number} bottom its snapped box @param {number} depth
   */
  under(item, x0, top0, x, top, w, bottom, depth) {
    /** @type {Stacked[]} */
    const found = [];
    this.sink(item, x0, top0, x, top, w, bottom, depth, this.left, this.top, this.right, this.bottom, found);
    found.sort(byZ);
    for (let i = 0; i < found.length; i++) this.stack(found[i]);
  }

  /**
   * Finds the negative contexts below an item, not into other contexts.
   * @param {Item} item @param {number} x0 @param {number} top0 @param {number} x @param {number} top @param {number} w @param {number} bottom its snapped box @param {number} depth
   * @param {number} l @param {number} t @param {number} rt @param {number} b the clip @param {Stacked[]} found
   */
  sink(item, x0, top0, x, top, w, bottom, depth, l, t, rt, b, found) {
    const r = item.r;
    let dy = 0;
    let dx = 0;
    if (item.kind === SCROLL) {
      const down = item.axis !== 1;
      const across = item.axis !== 0;
      // It scrolls as far as its content reaches past the room inside its border.
      dy = down ? Math.min(Math.max(0, item.content - (bottom - top - r.bT - r.bB)), Math.max(0, item.offset)) : 0;
      dx = across ? Math.min(Math.max(0, item.contentW - (w - r.bL - r.bR)), Math.max(0, item.offsetX)) : 0;
      // Right to left, it scrolls from its right and keeps its bar on its left.
      const back = r.dir === 1;
      if (back) dx = -dx;
      l = Math.max(l, x + r.bL + (down && back ? r.bar : 0));
      t = Math.max(t, top + r.bT);
      rt = Math.min(rt, x + w - r.bR - (down && !back ? r.bar : 0));
      b = Math.min(b, bottom - r.bB - (across ? r.bar : 0));
    } else if (r.clip) {
      l = Math.max(l, x + r.bL);
      t = Math.max(t, top + r.bT);
      rt = Math.min(rt, x + w - r.bR);
      b = Math.min(b, bottom - r.bB);
    }
    if (rt <= l || b <= t) return;
    const scale = this.state.scale;
    for (let c = item.first; c !== null; c = c.next) {
      if (!active(c)) continue;
      this.boxes.fix(c);
      const cr = c.r;
      const cx0 = x0 + c.x - dx;
      const ct0 = top0 + c.y - dy;
      if (cr.z < 0) found.push(new Stacked(c, cx0, ct0, depth + 1, l, t, rt, b));
      else if (cr.z !== cr.z && !(cr.opacity < 1) && !cr.tf && c.sunk) {
        const cx = Math.round(cx0 * scale) / scale;
        const ct = Math.round(ct0 * scale) / scale;
        this.sink(c, cx0, ct0, cx, ct, Math.round((cx0 + c.w) * scale) / scale - cx, Math.round((ct0 + c.h) * scale) / scale, depth + 1, l, t, rt, b, found);
      }
    }
  }

  /**
   * Clips drawing and hit regions to a rectangle within the current clip:
   * drawing to its rounded corners when it has a radius, as CSS clips a
   * box's content to its padding box's curve (hit regions keep the
   * rectangle).
   * @param {number} x @param {number} y @param {number} right @param {number} bottom
   * @param {Resolved | null} [r] the clipping item's style: its corners, less its border
   */
  clip(x, y, right, bottom, r = null) {
    if (r !== null && r.radius > r.bw) {
      const k = radii(r, right - x, bottom - y, -r.bw);
      this.frame.rclip(x, y, right, bottom, k[0], k[1], k[2], k[3]);
    } else this.frame.enter(x, y, right, bottom);
    this.left = Math.max(x, this.left);
    this.top = Math.max(y, this.top);
    this.right = Math.min(right, this.right);
    this.bottom = Math.min(bottom, this.bottom);
  }

  /** Records a mark of what was drawn since `o`, `t`, within a box and the current clip; `edged` when it has an antialiased edge along the box. @param {Item | null} item @param {number} slot @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} o @param {number} t @param {boolean} [edged] */
  mark(item, slot, x, y, right, bottom, o, t, edged = false) {
    const frame = this.frame;
    const marks = this.marks;
    const n = marks.n;
    marks.add(item, slot, Math.max(x, this.left), Math.max(y, this.top), Math.min(right, this.right), Math.min(bottom, this.bottom), o, frame.n, t, frame.t, this.loose > 0);
    if (edged && marks.n > n) {
      const u = marks.outer;
      u[n * 4] = Math.max(x - 1, this.left);
      u[n * 4 + 1] = Math.max(y - 1, this.top);
      u[n * 4 + 2] = Math.min(right + 1, this.right);
      u[n * 4 + 3] = Math.min(bottom + 1, this.bottom);
    }
    if (marks.n > n && !this.space.bent) marks.exact[n] = this.flat(o, frame.n) ? 1 : 0;
    if (this.space.bent && marks.n > n) {
      // Marks are on the screen: the bounds of the box transformed, a pixel out for its edges.
      const mat = this.space.mat;
      for (const a of [marks.box, marks.outer]) {
        bounds(mat, a[n * 4], a[n * 4 + 1], a[n * 4 + 2], a[n * 4 + 3]);
        a[n * 4] = Math.floor(BOUNDS[0]) - 1;
        a[n * 4 + 1] = Math.floor(BOUNDS[1]) - 1;
        a[n * 4 + 2] = Math.ceil(BOUNDS[2]) + 1;
        a[n * 4 + 3] = Math.ceil(BOUNDS[3]) + 1;
      }
    }
  }

  /**
   * True when the commands from `o` to `end` of this frame are plain fills
   * (`rect`) on whole device pixels: cut anywhere, they draw the pixels a
   * whole repaint draws.
   * @param {number} o @param {number} end
   */
  flat(o, end) {
    const ops = this.frame.ops;
    const scale = this.state.scale;
    for (let i = o; i < end; i += 6) {
      if (ops[i] !== RECT) return false;
      for (let k = 1; k <= 4; k++) {
        const v = ops[i + k] * scale;
        if (Math.abs(v - Math.round(v)) > 1e-6) return false;
      }
    }
    return true;
  }

  /**
   * Finds what differs on screen between the previous frame and this one:
   * the old and new boxes of every piece that moved, changed, came or went.
   * Returns the merged rectangles.
   */
  compare() {
    const damage = this.damage;
    const width = this.state.width;
    const height = this.state.height;
    damage.reset();
    const now = this.marks;
    const then = this.last;
    const a = this.frame;
    const b = this.back;
    const nb = now.box;
    const tb = then.box;
    // A changed piece with an antialiased edge along its box is damaged a
    // pixel past it, so the clip never runs along that edge (which would
    // rasterize a little differently); the pieces that pixel reaches grow
    // it below.
    const nu = now.outer;
    const tu = then.outer;
    for (let i = 0; i < now.n; i++) {
      const j = then.index[now.slots[i]].get(now.items[i]);
      if (j !== undefined) {
        then.kept[j] = 1;
        if (same(a, now, i, b, then, j) && !reordered(now, i, then, j)) continue;
        damage.add(tu[j * 4], tu[j * 4 + 1], tu[j * 4 + 2], tu[j * 4 + 3], width, height);
      }
      damage.add(nu[i * 4], nu[i * 4 + 1], nu[i * 4 + 2], nu[i * 4 + 3], width, height);
    }
    for (let j = 0; j < then.n; j++) if (then.kept[j] === 0) damage.add(tu[j * 4], tu[j * 4 + 1], tu[j * 4 + 2], tu[j * 4 + 3], width, height);
    // A shape cut by a damage border rasterizes its antialiased edge a little
    // differently than whole: grow each rectangle over every piece it cuts,
    // unless the piece holds it whole (a fill behind it) or clips exactly (a
    // plain fill on whole pixels: a column's background stays out of it).
    const db = damage.box;
    const exact = now.exact;
    for (let i = 0; i < now.n && damage.n > 0; i++) {
      if (exact[i] === 1) continue;
      const k = i * 4;
      // On the canvas only, as the damage is: a piece reaching past an edge
      // (a moved or scaled one) would never lie inside a clamped rectangle,
      // and growing over it would start this pass again forever.
      const x = Math.max(0, nb[k]);
      const y = Math.max(0, nb[k + 1]);
      const r = Math.min(width, nb[k + 2]);
      const bt = Math.min(height, nb[k + 3]);
      if (r <= x || bt <= y) continue;
      for (let d = 0; d < damage.n * 4; d += 4) {
        const l = db[d], tp = db[d + 1], rr = db[d + 2], bb = db[d + 3];
        if (x >= rr || r <= l || y >= bb || bt <= tp) continue;
        if (x >= l && r <= rr && y >= tp && bt <= bb) continue;
        if (x <= l && r >= rr && y <= tp && bt >= bb) continue;
        damage.add(x, y, r, bt, width, height);
        i = -1;
        break;
      }
    }
    return damage;
  }

  /**
   * The hit regions of an item with no box (display: contents): its
   * children's boxes (a child with none, its own children's), under them,
   * so a child that is a target itself stays the topmost.
   * @param {Item} item @param {number} x0 @param {number} top0
   */
  through(item, x0, top0) {
    const scale = this.state.scale;
    for (let c = item.first; c !== null; c = c.next) {
      if (!active(c)) continue;
      this.boxes.fix(c);
      if (c.flat) {
        this.through(c, x0 + c.x, top0 + c.y);
        continue;
      }
      const x = Math.round((x0 + c.x) * scale) / scale;
      const top = Math.round((top0 + c.y) * scale) / scale;
      this.hit(item, x, top, Math.round((x0 + c.x + c.w) * scale) / scale, Math.round((top0 + c.y + c.h) * scale) / scale, x, top);
    }
  }

  /** Records a hit region clipped to the current clip. @param {Item} item @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} ox @param {number} oy */
  hit(item, x, y, right, bottom, ox, oy) {
    // pointerEvents none: the pointer goes through it.
    if (!item.r.events) return;
    this.hits.add(item, Math.max(x, this.left), Math.max(y, this.top), Math.min(right, this.right), Math.min(bottom, this.bottom), ox, oy);
  }

  /**
   * A scrolling region clips its content to its padding box, moves it by its
   * offset, and draws a thin bar when it overflows.
   * @param {Item} item @param {number} x @param {number} top @param {number} w @param {number} h its snapped box
   * @param {number} x0 @param {number} top0 its layout origin @param {number} depth
   */
  scroller(item, x, top, w, h, x0, top0, depth) {
    const frame = this.frame;
    const theme = this.theme;
    const r = item.r;
    const bottom = top + h;
    // The axes it scrolls along: down, across, or both.
    const down = item.axis !== 1;
    const across = item.axis !== 0;
    // It scrolls as far as its content reaches past the room inside its border.
    const limit = down ? Math.max(0, item.content - (h - r.bT - r.bB)) : 0;
    const offset = Math.min(limit, Math.max(0, item.offset));
    const limitX = across ? Math.max(0, item.contentW - (w - r.bL - r.bR)) : 0;
    const offsetX = Math.min(limitX, Math.max(0, item.offsetX));
    // Right to left, it scrolls from its right (its content moves right) and keeps its bar on its left.
    const back = r.dir === 1;
    const shift = back ? -offsetX : offsetX;
    const { left: l, top: t, right: rt, bottom: b } = this;
    if (r.events) this.regions.add(item, Math.max(x, l), Math.max(top, t), Math.min(x + w, rt), Math.min(bottom, b), x, top);
    // Its content stops at its bars (none with scrollbarWidth 'none').
    const bar = r.bar;
    const barX = down ? bar : 0;
    const barY = across ? bar : 0;
    this.clip(x + r.bL + (back ? barX : 0), top + r.bT, x + w - r.bR - (back ? 0 : barX), bottom - r.bB - barY, r);
    // Its scrollport is the one sticky items below are held in, and they are held within its content.
    const port = this.port;
    const hold = this.hold;
    const pl = port[0];
    const pt = port[1];
    const pr = port[2];
    const pb = port[3];
    const hl = hold[0];
    const ht = hold[1];
    const hr = hold[2];
    const hb = hold[3];
    portOf(item, x0, top0, port);
    holdOf(item, x0, top0, x0 - shift, top0 - offset, hold);
    const ordered = !r.row && !r.grid && !item.placed;
    for (let c = item.first; c !== null; c = c.next)
      if (active(c)) {
        this.boxes.fix(c);
        if (ordered && top0 + c.y - offset >= this.bottom) break;
        if (c.r.sticky) {
          stickAt(c, x0 + c.x - shift, top0 + c.y - offset, port, hold);
          this.child(c, PLACE[0], PLACE[1], depth + 1);
        } else this.child(c, x0 + c.x - shift, top0 + c.y - offset, depth + 1);
      }
    hold[0] = hl;
    hold[1] = ht;
    hold[2] = hr;
    hold[3] = hb;
    port[0] = pl;
    port[1] = pt;
    port[2] = pr;
    port[3] = pb;
    frame.leave();
    this.left = l;
    this.top = t;
    this.right = rt;
    this.bottom = b;
    const o = frame.n;
    const right = x + w - r.bR;
    const low = bottom - r.bB;
    // The colors: its style's (scrollbarColor, inherited), else its renderer props', else the theme's.
    const track = r.track >= 0 ? r.track : (item.get('track') ?? theme.soft);
    const thumb = r.thumb >= 0 ? r.thumb : (item.get('thumb') ?? theme.muted);
    if (limit > 0 && bar > 0) {
      const inner = h - r.bT - r.bB - barY;
      const length = Math.max(24, (inner * inner) / (item.content - barY));
      const start = top + r.bT + ((inner - length) * offset) / limit;
      const side = back ? x + r.bL + bar : right;
      frame.rect(side - bar, top + r.bT, side, low - barY, track);
      frame.figure(ROUND, side - bar + 1, start + 1, side - 1, start + length - 1, thumb, 3);
    }
    if (limitX > 0 && bar > 0) {
      // The bar across, along its bottom (from its right at its start, right to left).
      const inner = w - r.bL - r.bR - barX;
      const length = Math.max(24, (inner * inner) / (item.contentW - barX));
      const from = x + r.bL + (back ? barX : 0);
      const start = from + ((inner - length) * (back ? limitX - offsetX : offsetX)) / limitX;
      frame.rect(from, low - bar, from + inner, low, track);
      frame.figure(ROUND, start + 1, low - bar + 1, start + length - 1, low - 1, thumb, 3);
    }
    if (frame.n > o) this.mark(item, BAR, limitX > 0 || back ? x : right - bar, limit > 0 ? top : low - bar, limitX > 0 || !back ? right : x + r.bL + bar, bottom, o, frame.t);
  }

  /**
   * The selection behind a Label's rows: a line box high, from its first
   * selected character to its last, and on past a row's end when the
   * selection goes on (the space or line break it continues across).
   * @param {Item} item @param {Resolved} r @param {number} left @param {number} width @param {number} top
   */
  highlight(item, r, left, width, top) {
    const rows = /** @type {string[]} */ (item.rows);
    const starts = /** @type {number[]} */ (item.starts);
    const fonts = this.fonts;
    const frame = this.frame;
    const size = r.size;
    const height = line(r);
    const color = item.get('selection') ?? this.theme.selection;
    if (item.spans !== null) {
      // Runs: each row's line box, the ends measured through their runs.
      const runs = new Runs(fonts, item.spans, true);
      const tops = /** @type {number[]} */ (item.tops);
      const cuts = /** @type {number[]} */ (item.cuts);
      for (let i = 0; i < rows.length; i++) {
        const text = rows[i];
        const start = starts[i];
        const end = textAt(item, i, cuts[i]);
        const m = rowMeasure(item, runs, i);
        const a = Math.max(item.from, start);
        const b = Math.min(item.to, end);
        const on = item.to > end && item.from <= end;
        if (a >= b && !on) continue;
        const rtl = r.dir === 1 || order(text, 0) !== null;
        const advance = r.textAlign === 0 && !rtl ? 0 : rowWidth(item, runs, i);
        const dx = r.textAlign === 1 ? (width - advance) / 2 : r.textAlign === 2 ? width - advance : 0;
        if (rtl) {
          const pairs = marks(m, text, start, Math.max(0, rowIndex(item, i, a)), Math.max(0, rowIndex(item, i, b)), MARKS, dirOf(item, i));
          for (let k = 0; k < pairs.length; k += 2) frame.rect(left + dx + pairs[k], top + tops[i], left + dx + pairs[k + 1], top + tops[i + 1], color);
          // On past the row's end: its right, or its left right to left.
          const space = on ? runs.width(' ', end) : 0;
          if (on) frame.rect(left + dx + (r.dir === 1 ? -space : advance), top + tops[i], left + dx + (r.dir === 1 ? 0 : advance + space), top + tops[i + 1], color);
          continue;
        }
        const x0 = left + dx + xAt(m, text, start, Math.max(0, rowIndex(item, i, a)), dirOf(item, i));
        const x1 = left + dx + xAt(m, text, start, Math.max(0, rowIndex(item, i, b)), dirOf(item, i)) + (on ? runs.width(' ', end) : 0);
        frame.rect(x0, top + tops[i], x1, top + tops[i + 1], color);
      }
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      const text = rows[i];
      const start = starts[i];
      const end = textAt(item, i, text.length);
      const a = Math.max(item.from, start);
      const b = Math.min(item.to, end);
      const on = item.to > end && item.from <= end;
      if (a >= b && !on) continue;
      const rtl = r.dir === 1 || order(text, 0) !== null;
      const advance = r.textAlign === 0 && !rtl ? 0 : fonts.width(text, size, r.face);
      const dx = r.textAlign === 1 ? (width - advance) / 2 : r.textAlign === 2 ? width - advance : 0;
      if (rtl) {
        // Right-to-left text: a rect for each visual run the selection reaches, and the line on past its end (its left, right to left).
        const m = new Face(fonts, size, r.face);
        const pairs = marks(m, text, start, Math.max(0, rowIndex(item, i, a)), Math.max(0, rowIndex(item, i, b)), MARKS, dirOf(item, i));
        for (let k = 0; k < pairs.length; k += 2) frame.rect(left + dx + pairs[k], top + i * height, left + dx + pairs[k + 1], top + (i + 1) * height, color);
        const space = on ? fonts.width(' ', size, r.face) : 0;
        if (on) frame.rect(left + dx + (r.dir === 1 ? -space : advance), top + i * height, left + dx + (r.dir === 1 ? 0 : advance + space), top + (i + 1) * height, color);
        continue;
      }
      const m = new Face(fonts, size, r.face);
      const x0 = left + dx + xAt(m, text, start, Math.max(0, rowIndex(item, i, a)), dirOf(item, i));
      const x1 = left + dx + xAt(m, text, start, Math.max(0, rowIndex(item, i, b)), dirOf(item, i)) + (on ? fonts.width(' ', size, r.face) : 0);
      frame.rect(x0, top + i * height, x1, top + (i + 1) * height, color);
    }
  }

  /**
   * An Action's caption where the DOM lays it out: one flex item in the
   * Action's box (a column unless its direction is a row), placed along it
   * by `justify` (the center unset) and across by `align`; stretched
   * across, its lines align by `textAlign` in the whole width, else it is
   * as wide as its widest line.
   * @param {string} text @param {Resolved} r @param {number} cx @param {number} cy @param {number} cw @param {number} ch
   */
  caption(text, r, cx, cy, cw, ch) {
    const [rows, dx, dy, width] = captionOf(this.fonts, text, r, cw, ch);
    this.lines(rows, r, cx + dx, width, cy + dy);
  }

  /**
   * The selection in an Action's own text (`selectText` opened on it),
   * behind its caption's rows: a rectangle a line high on each row it
   * reaches.
   * @param {Item} item @param {Resolved} r @param {number} cx @param {number} cy @param {number} cw @param {number} ch
   */
  marked(item, r, cx, cy, cw, ch) {
    const frame = this.frame;
    const fonts = this.fonts;
    const [shown, dx, dy, width] = captionOf(fonts, item.text, r, cw, ch);
    const rows = typeof shown === 'string' ? [shown] : shown;
    const m = new Face(fonts, r.size, r.face);
    const height = line(r);
    const color = item.get('selection') ?? this.theme.selection;
    let start = 0;
    for (let i = 0; i < rows.length; i++) {
      const text = rows[i];
      const a = Math.max(item.from, start) - start;
      const b = Math.min(item.to, start + text.length) - start;
      if (a < b) {
        const left = cx + dx + rowLeft(fonts, text, r, width);
        const pairs = marks(m, text, start, a, b, MARKS, r.dir);
        for (let k = 0; k < pairs.length; k += 2) frame.rect(left + pairs[k], cy + dy + i * height, left + pairs[k + 1], cy + dy + (i + 1) * height, color);
      }
      start += text.length + 1;
    }
  }

  /**
   * Lines of text in a content box `width` wide from `top`, one line height
   * apart, aligned, the baseline where CSS puts it (half the leading above
   * the ascent); underlined and struck through when the style says.
   * @param {readonly string[] | string} rows the rows, or one line @param {Resolved} r @param {number} left @param {number} width @param {number} top
   * @param {number} [align] where the rows align (0 left, 1 center, 2 right): the style's by default
   * @param {(Uint8Array | null)[] | null} [levels] rows laid out by levels of their own (a Label's cut rows, `Item.levels`)
   */
  lines(rows, r, left, width, top, align = r.textAlign, levels = null) {
    const frame = this.frame;
    const fonts = this.fonts;
    const size = r.size;
    const height = line(r);
    const base = baseline(fonts, size, height, r.face);
    const flags = r.face;
    const one = typeof rows === 'string';
    const count = one ? 1 : rows.length;
    for (let i = 0; i < count; i++) {
      const text = one ? rows : rows[i];
      const advance = align === 0 && !r.underline && !r.strike ? 0 : fonts.width(text, size, r.face);
      const dx = align === 1 ? (width - advance) / 2 : align === 2 ? width - advance : 0;
      const y = top + i * height + base;
      this.row(text, left + dx, y, size, r.fg, flags, levels === null ? r.dir : (levels[i] ?? r.dir));
      if (r.underline && advance > 0) {
        const thick = Math.max(1, size / 14);
        frame.figure(LINE, left + dx, y + thick * 1.5, left + dx + advance, y + thick * 1.5, r.fg, thick);
      }
      if (r.strike && advance > 0) {
        // Through the middle of the lowercase letters, as browsers draw line-through.
        const thick = Math.max(1, size / 14);
        const mid = y - size * 0.3;
        frame.figure(LINE, left + dx, mid, left + dx + advance, mid, r.fg, thick);
      }
    }
  }

  /**
   * A Label's rows of runs: in each row's line box, on its baseline, every
   * piece in its run's face, size and color, its background behind it (the
   * run's text height, as a span's) and its decorations; aligned as the
   * Label says. An ellipsis takes the run of the character before it.
   * @param {Item} item @param {Resolved} r @param {number} left @param {number} width @param {number} top
   */
  spanned(item, r, left, width, top) {
    const frame = this.frame;
    const fonts = this.fonts;
    const spans = /** @type {import('./scene.js').Span[]} */ (item.spans);
    const m = new Runs(fonts, spans, true);
    const rows = /** @type {string[]} */ (item.rows);
    const starts = /** @type {number[]} */ (item.starts);
    const cuts = /** @type {number[]} */ (item.cuts);
    const tops = /** @type {number[]} */ (item.tops);
    const bases = /** @type {number[]} */ (item.bases);
    const pieces = PIECES;
    for (let i = 0; i < rows.length; i++) {
      const text = rows[i];
      const at = starts[i];
      const kept = cuts[i];
      // The row's pieces: [from, to) in the row, and their runs.
      pieces.length = 0;
      const map = item.kept === null ? null : item.kept[i];
      if (map !== null) {
        // Characters kept apart in the text: each in the run of its offset there.
        for (let j = 0; j < kept; j++) {
          const k = m.at(at + map[j]);
          if (pieces.length > 0 && pieces[pieces.length - 1] === k) pieces[pieces.length - 2] = j + 1;
          else pieces.push(j, j + 1, k);
        }
      } else
        for (let k = m.at(at), pos = 0; pos < kept && k < spans.length; k++) {
          const take = k === spans.length - 1 ? kept - pos : Math.min(kept - pos, spans[k].end - (at + pos));
          if (take <= 0) continue;
          pieces.push(pos, pos + take, k);
          pos += take;
        }
      if (text.length > kept) {
        // The ellipsis, in the run of the last character kept.
        const k = m.at(textAt(item, i, Math.max(0, kept - 1)));
        if (pieces.length > 0 && pieces[pieces.length - 1] === k) pieces[pieces.length - 2] = text.length;
        else pieces.push(kept, text.length, k);
      }
      // In visual order: a right-to-left run's pieces from its right.
      const shown = seen(text, pieces, SEEN, dirOf(item, i));
      let advance = 0;
      const widths = WIDTHS;
      widths.length = 0;
      for (let p = 0; p < shown.length; p += 4) {
        const sp = spans[shown[p + 2]];
        // Each piece is a span's text on the row, as wide as Blink lays it out.
        const w = unit(fonts.width(text.slice(shown[p], shown[p + 1]), sp.size, sp.face));
        widths.push(w);
        advance += w;
      }
      const dx = r.textAlign === 1 ? (width - advance) / 2 : r.textAlign === 2 ? width - advance : 0;
      const y = top + tops[i] + bases[i];
      // Backgrounds under all the row's text.
      let x = left + dx;
      for (let p = 0; p < shown.length; p += 4) {
        const sp = spans[shown[p + 2]];
        const w = widths[p / 4];
        if (sp.bg !== -1 && w > 0) {
          const { ascent, descent } = textExtent(fonts, sp.size, sp.face);
          frame.rect(x, y - ascent, x + w, y + descent, sp.bg);
        }
        x += w;
      }
      x = left + dx;
      for (let p = 0; p < shown.length; p += 4) {
        const sp = spans[shown[p + 2]];
        const w = widths[p / 4];
        const piece = text.slice(shown[p], shown[p + 1]);
        if (shown[p + 3] === 1) this.piece(piece, x + w, y, sp.size, sp.fg, sp.face | RTL);
        else this.piece(piece, x, y, sp.size, sp.fg, sp.face);
        const thick = Math.max(1, sp.size / 14);
        if (sp.underline && w > 0) frame.figure(LINE, x, y + thick * 1.5, x + w, y + thick * 1.5, sp.fg, thick);
        if (sp.strike && w > 0) frame.figure(LINE, x, y - sp.size * 0.3, x + w, y - sp.size * 0.3, sp.fg, thick);
        x += w;
      }
    }
  }

  /**
   * Edits and actions: the text of an action, or an edit's value (its label
   * as a placeholder while empty) with its selection, composition and caret,
   * scrolled to keep the caret in view. An edit's value is measured and
   * drawn through its runs while they match it (`edited`).
   * @param {Item} item @param {number} x @param {number} top @param {number} w @param {number} bottom its snapped box
   * @param {number} cx @param {number} cy @param {number} cw @param {number} ch its content box
   */
  control(item, x, top, w, bottom, cx, cy, cw, ch) {
    const frame = this.frame;
    const theme = this.theme;
    const state = this.state;
    const fonts = this.fonts;
    const r = item.r;
    const size = r.size;
    const height = line(r);
    const edit = item.kind === EDIT;
    const multi = edit && item.lines > 1;
    frame.enter(x + r.bL, top + r.bT, x + w - r.bR, bottom - r.bB);
    if (!edit) {
      if (item.from >= 0) this.marked(item, r, cx, cy, cw, ch);
      this.caption(item.text, r, cx, cy, cw, ch);
      frame.leave();
      return;
    }
    const focused = item === state.focus;
    // A secret Edit draws a bullet for each unit of its value.
    const value = shown(item);
    const position = Math.min(value.length, Math.max(0, state.caret));
    const m = measureOf(item, fonts);
    const spans = edited(item);
    const rows = multi ? Lines(m, value, cw) : null;
    // Scrolled no further than its rows go (a value shortened, focused or not), as a textarea's.
    if (rows !== null) item.offset = Math.max(0, Math.min(item.offset, rows.length * height - ch));
    // One line sits in the middle of the box; rows start at its top, scrolled by its offset (the caret's row in view).
    const lineTop = multi ? cy - item.offset : cy + (ch - height) / 2;
    const row = rows === null ? 0 : Seek(rows, position, state.upstream);
    const start = rows === null ? 0 : rows[row].start;
    const current = rows === null ? value : rows[row].text;
    // Where each row starts in the text box, as its alignment and direction place it (`indent`).
    const indents = INDENTS;
    indents.length = 0;
    if (rows === null) indents.push(indent(r, m, value, 0, cw, 0));
    else for (let i = 0; i < rows.length; i++) indents.push(indent(r, m, rows[i].text, rows[i].start, cw, wraps(rows, i) ? 2 : 1));
    const at = focused ? indents[row] + xAt(m, current, start, position - start, r.dir) : 0;
    // The caret is 2 wide on its after side: its right, its left right to left (where it stays in the box at
    // the text's start edge). On spaces hanging past a multi-line Edit's text box, it stays at its edge, as a
    // textarea's; one line scrolls the least that shows it.
    const back = r.dir === 1;
    const low = back ? 2 : 0;
    const high = back ? cw : cw - 2;
    const advance = multi ? Math.max(low, Math.min(high, at)) : at;
    const offset = focused && rows === null ? (at > high ? at - high : at < low ? at - low : 0) : 0;
    const anchor = Math.min(value.length, Math.max(0, state.anchor));
    const left = cx - offset;
    if (focused && anchor !== position) this.span(value, rows, Math.min(anchor, position), Math.max(anchor, position), left, lineTop, height, m, RECT, item.get('selection') ?? theme.selection, indents, r.dir);
    if (value.length === 0 && item.label !== null && !(focused && state.from >= 0)) this.lines(item.label, placeholder(r), cx, cw, lineTop);
    else if (spans !== null) this.typed(spans, /** @type {Runs} */ (m), value, rows, r, left, indents, lineTop);
    else if (rows === null) this.lines(value, r, left + indents[0], cw, lineTop, 0);
    else for (let i = 0; i < rows.length; i++) this.lines(rows[i].text, r, left + indents[i], cw, lineTop + i * height, 0);
    if (focused && state.from >= 0 && state.span > 0) {
      const from = Math.min(value.length, state.from);
      this.span(value, rows, from, Math.min(value.length, from + state.span), left, lineTop + height - 2, height, m, LINE, r.fg, indents, r.dir);
    }
    if (focused) frame.rect(left + advance - (back ? 2 : 0), lineTop + row * height, left + advance + (back ? 0 : 2), lineTop + (row + 1) * height, item.get('caret') ?? theme.caret);
    frame.leave();
    // Hit: the whole box; the origin is where the text starts (for placing the caret).
    const hits = this.hits;
    for (let i = hits.n - 1; i >= 0; i--)
      if (hits.items[i] === item) {
        hits.box[i * 6 + 4] = left;
        hits.box[i * 6 + 5] = lineTop;
        break;
      }
  }

  /**
   * Marks the text between `start` and `end` of an edit value, row by row: a
   * rectangle a line high from each row's top (a selection), or a line under
   * it (a composition).
   * @param {string} value @param {import('./text.js').Row[] | null} rows @param {number} start @param {number} end
   * @param {number} left @param {number} top @param {number} height @param {import('./text.js').Measure} m what measures the value @param {number} op RECT or LINE @param {number} color
   * @param {readonly number[]} indents where each row starts (`indent`) @param {number} base the rows' direction (`order`)
   */
  span(value, rows, start, end, left, top, height, m, op, color, indents, base) {
    const frame = this.frame;
    const count = rows === null ? 1 : rows.length;
    for (let r = 0; r < count; r++) {
      const text = rows === null ? value : rows[r].text;
      const first = rows === null ? 0 : rows[r].start;
      const a = Math.max(start, first) - first;
      const b = Math.min(end, first + text.length) - first;
      if (a >= b) continue;
      const y = top + r * height;
      // A rect (or a line) for each visual run it reaches: one, left to right.
      const pairs = marks(m, text, first, a, b, MARKS, base);
      for (let k = 0; k < pairs.length; k += 2) {
        const x0 = left + indents[r] + pairs[k];
        const x1 = left + indents[r] + pairs[k + 1];
        if (op === RECT) frame.rect(x0, y, x1, y + height, color);
        else frame.figure(LINE, x0, y, x1, y, color, 1);
      }
    }
  }

  /**
   * An Edit's value in its runs, row by row on the Edit's one line height and
   * baseline (as `lines` sets its plain text): each piece in its run's face
   * and color, its background behind it (the run's ascent and descent, as a
   * span's) and its decorations; each row from where it starts (`indent`).
   * @param {import('./scene.js').Span[]} spans @param {Runs} m their measure @param {string} value
   * @param {import('./text.js').Row[] | null} rows @param {Resolved} r @param {number} left @param {readonly number[]} indents @param {number} top
   */
  typed(spans, m, value, rows, r, left, indents, top) {
    const frame = this.frame;
    const fonts = this.fonts;
    const size = r.size;
    const height = line(r);
    const base = baseline(fonts, size, height, r.face);
    const count = rows === null ? 1 : rows.length;
    const thick = Math.max(1, size / 14);
    for (let i = 0; i < count; i++) {
      const text = rows === null ? value : rows[i].text;
      const at = rows === null ? 0 : rows[i].start;
      const y = top + i * height + base;
      // The row's pieces, by run, in visual order.
      const pieces = PIECES;
      pieces.length = 0;
      let pos = 0;
      for (let k = m.at(at); pos < text.length && k < spans.length; k++) {
        const take = k === spans.length - 1 ? text.length - pos : Math.min(text.length - pos, spans[k].end - (at + pos));
        if (take <= 0) continue;
        pieces.push(pos, pos + take, k);
        pos += take;
      }
      const shown = seen(text, pieces, SEEN, r.dir);
      // Twice over the row's pieces: the backgrounds, then the text over them.
      for (let pass = 0; pass < 2; pass++) {
        let x = left + indents[i];
        for (let p = 0; p < shown.length; p += 4) {
          const sp = spans[shown[p + 2]];
          const piece = text.slice(shown[p], shown[p + 1]);
          const w = fonts.width(piece, size, sp.face);
          if (pass === 0) {
            if (sp.bg !== -1 && w > 0) {
              const metrics = textExtent(fonts, size, sp.face);
              frame.rect(x, y - metrics.ascent, x + w, y + metrics.descent, sp.bg);
            }
          } else {
            if (shown[p + 3] === 1) this.piece(piece, x + w, y, size, sp.fg, sp.face | RTL);
            else this.piece(piece, x, y, size, sp.fg, sp.face);
            if (sp.underline && w > 0) frame.figure(LINE, x, y + thick * 1.5, x + w, y + thick * 1.5, sp.fg, thick);
            if (sp.strike && w > 0) frame.figure(LINE, x, y - size * 0.3, x + w, y - size * 0.3, sp.fg, thick);
          }
          x += w;
        }
      }
    }
  }

  /**
   * A row of text in one face from `x`: its right-to-left runs (`order`)
   * in their visual places, each a piece of its own.
   * @param {string} text @param {number} x @param {number} y the baseline @param {number} size @param {number} color @param {number} face @param {number | Uint8Array} base its direction, or its levels (`order`)
   */
  row(text, x, y, size, color, face, base) {
    const runs = order(text, base);
    if (runs === null) {
      this.piece(text, x, y, size, color, face);
      return;
    }
    for (let i = 0; i < runs.length; i += 3) {
      const piece = text.slice(runs[i], runs[i + 1]);
      const w = this.fonts.width(piece, size, face);
      if (runs[i + 2] & 1) this.piece(piece, x + w, y, size, color, face | RTL);
      else this.piece(piece, x, y, size, color, face);
      x += w;
    }
  }

  /**
   * Text of one direction in a face (RTL: `x` its right edge): the
   * characters its typeface lacks in the typefaces that have them
   * (`Fonts.faces`), each such piece a text command of its own.
   * @param {string} text @param {number} x @param {number} y @param {number} size @param {number} color @param {number} face
   */
  piece(text, x, y, size, color, face) {
    const fonts = this.fonts;
    const pieces = fonts.faces === undefined ? null : fonts.faces(text, face & ~RTL);
    if (pieces === null) {
      this.frame.text(text, x, y, size, color, face);
      return;
    }
    const rtl = face & RTL;
    let from = 0;
    for (let i = 0; i < pieces.length; i += 2) {
      const part = text.slice(from, pieces[i]);
      this.frame.text(part, x, y, size, color, pieces[i + 1] | rtl);
      const w = fonts.width(part, size, pieces[i + 1]);
      x += rtl !== 0 ? -w : w;
      from = pieces[i];
    }
  }

  /** The figures of a Shape, in its content box and clipped to it. @param {Item} item @param {number} x @param {number} top @param {number} w @param {number} h */
  figures(item, x, top, w, h) {
    const frame = this.frame;
    const theme = this.theme;
    const list = item.shapes;
    frame.enter(x, top, x + w, top + h);
    if (list !== null)
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        // A filled figure's `fill`: a color in place of its color, or a gradient over its bounds.
        const fill = fillOf(f.fill);
        const color = typeof fill === 'number' ? fill : (argb(f.color) ?? theme.ink);
        const fx = x + (f.x ?? 0);
        const fy = top + (f.y ?? 0);
        const fr = x + (f.right ?? 0);
        const fb = top + (f.bottom ?? 0);
        // A stroke may be dashed (SVG's stroke-dasharray): lines, outlines, open paths.
        const stroked = f.kind === 'line' || (f.stroke ?? 0) > 0 || (f.kind === 'path' && !f.closed);
        const dashed = stroked && Array.isArray(f.dash) && f.dash.length > 0 && f.dash.every(v => typeof v === 'number' && v >= 0) && f.dash.some(v => v > 0);
        if (dashed) frame.dash(0, /** @type {number[]} */ (f.dash));
        if (fill !== null && typeof fill === 'object' && !stroked && f.kind !== 'line') {
          if (f.kind === 'path') {
            const points = f.points;
            if (points != null && points.length >= 4) {
              extent(points);
              frame.shade(x + EXTENT[0], top + EXTENT[1], x + EXTENT[2], top + EXTENT[3], fill);
            }
          } else frame.shade(fx, fy, fr, fb, fill);
        }
        switch (f.kind) {
          case 'line':
            frame.figure(LINE, fx, fy, fr, fb, color, f.stroke ?? 1);
            break;
          case 'rect':
          case 'round': {
            const radius = f.kind === 'round' ? (f.radius ?? theme.radius) : 0;
            const stroke = f.stroke ?? 0;
            // An outline centered on the edge, as SVG strokes a rect: a border half a width out.
            if (stroke > 0) frame.edge(BORDER, fx - stroke / 2, fy - stroke / 2, fr + stroke / 2, fb + stroke / 2, color, radius > 0 ? radius + stroke / 2 : 0, stroke);
            else if (radius > 0) frame.figure(ROUND, fx, fy, fr, fb, color, radius);
            else frame.rect(fx, fy, fr, fb, color);
            break;
          }
          case 'oval':
            frame.figure(OVAL, fx, fy, fr, fb, color, f.stroke ?? 0);
            break;
          case 'path': {
            const points = f.points;
            if (points == null || points.length < 4 || points.length % 2 !== 0) throw new Error('REN canv: a path needs at least two x, y points');
            frame.path(color, f.stroke ?? 0, !!f.closed, points, x, top);
            break;
          }
          default:
            throw new Error(`REN canv: unsupported shape ${f.kind}`);
        }
        if (dashed) frame.dash(0, null);
      }
    frame.leave();
  }
}

/** Normalized figure fills (a color or ren-core's Gradient), by the object given. @type {WeakMap<object, any>} */
const fills = new WeakMap();

/**
 * A Shape figure's `fill`: an ARGB color, a gradient (ren-core's, as a
 * background's), or null for none.
 * @param {unknown} fill
 * @returns {number | { radial: boolean, angle: number, stops: number[] } | null}
 */
function fillOf(fill) {
  if (fill == null) return null;
  if (typeof fill !== 'object') return argb(fill);
  let g = fills.get(fill);
  if (g === undefined) {
    g = styled({ background: /** @type {any} */ (fill) }).background;
    fills.set(fill, g);
  }
  return g;
}

/** A path's points' bounds, reused: left, top, right, bottom. */
const EXTENT = new Float64Array(4);
/** Sets EXTENT to the bounds of a path's points. @param {ArrayLike<number>} p */
function extent(p) {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (let i = 0; i + 1 < p.length; i += 2) {
    if (p[i] < l) l = p[i];
    if (p[i] > r) r = p[i];
    if (p[i + 1] < t) t = p[i + 1];
    if (p[i + 1] > b) b = p[i + 1];
  }
  EXTENT[0] = l;
  EXTENT[1] = t;
  EXTENT[2] = r;
  EXTENT[3] = b;
}

/** A row's pieces (from, to, run: flat triples), in visual order (from, to, run, rtl), and their widths, reused. @type {number[]} */
const PIECES = [];
/** @type {number[]} */
const SEEN = [];
/** @type {number[]} */
const WIDTHS = [];
/** The visual ranges of a selection on a row (`marks`), reused. @type {number[]} */
const MARKS = [];
/** Where an Edit's rows start (`indent`), reused. @type {number[]} */
const INDENTS = [];

/**
 * A row's run pieces ([from, to, run] triples, in logical order) in
 * visual order, into `out` as [from, to, run, rtl] quads: cut where the
 * row's direction changes (`order`), those of a right-to-left run in
 * reverse (rtl 1).
 * @param {string} text @param {readonly number[]} pieces @param {number[]} out @param {number | Uint8Array} base the row's direction, or its levels (`order`)
 */
function seen(text, pieces, out, base) {
  out.length = 0;
  const runs = order(text, base);
  if (runs === null) {
    for (let p = 0; p < pieces.length; p += 3) out.push(pieces[p], pieces[p + 1], pieces[p + 2], 0);
    return out;
  }
  for (let i = 0; i < runs.length; i += 3) {
    const odd = runs[i + 2] & 1;
    const mark = out.length;
    for (let p = 0; p < pieces.length; p += 3) {
      const a = Math.max(runs[i], pieces[p]);
      const b = Math.min(runs[i + 1], pieces[p + 1]);
      if (a < b) out.push(a, b, pieces[p + 2], odd);
    }
    if (odd)
      for (let lo = mark, hi = out.length - 4; lo < hi; lo += 4, hi -= 4)
        for (let k = 0; k < 4; k++) {
          const t = out[lo + k];
          out[lo + k] = out[hi + k];
          out[hi + k] = t;
        }
  }
  return out;
}

/** The resolved style of an edit's placeholder, reused. */
const muted = new Resolved();
/** Its text in the placeholder color (the style's `placeholderColor`, else the theme's muted). @param {Resolved} r */
function placeholder(r) {
  Object.assign(muted, r);
  muted.fg = r.ph;
  muted.underline = false;
  muted.strike = false;
  return muted;
}
