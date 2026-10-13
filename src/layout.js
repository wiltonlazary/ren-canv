// Layout of the scene into boxes by ren-core's portable box model: CSS flexbox
// and grid with CSS's defaults, computed by the layout engine (engine.js;
// Taffy by default), the same algorithms a browser runs on the CSS ren-dom
// writes.
//
// Before an item is laid out its style resolves (`resolve`): the theme's
// defaults for its kind, the text its parent passes down (color, size,
// weight, italic, alignment, line height, selectability, underline), its
// shorthand props, its style and the styles of its current states. `Boxes`
// keeps a layout tree beside the scene: a node per item, its style set from
// the resolved one when that changes, its children when they change, and
// text as content children sized by the font measure. It records these as
// flat commands with plain CSS boxes; where the engine runs they are applied and the page
// is laid out: in this thread (the default: boxes are read only for the
// items drawn, `fix`), or in a worker (the boxes that changed come back).
// Boxes are relative to the parent's border box.
//
// The layer needs only the items and a font measure, not a canvas or a
// document: it can run wherever the scene is.

import { overlay, Style } from 'ren-core/host';
import { VIEW, LAYOUT, SCROLL, LABEL, EDIT, ACTION, TEXT, MARKER, IMAGE, SHAPE, HOVER, PRESS, FOCUS, Item, Resolved, caption, edited, touch, strongOf } from './scene.js';
import { Wrapped, Lines, Face, Runs, BOLD, ITALIC, MONO, SLOT, baseline, unit, cased, inside, order } from './text.js';
import { levels, line as lineOfLevels } from './bidi.js';
import { down64, near64, toward64 } from './units.js';
import { Local, NEW, STYLE, KIDS, REMOVE, DEFINE, FORGET, SIZE, CONTENT, RECORD, box } from './engine.js';

/** @typedef {import('./text.js').Fonts} Fonts */
/** @typedef {import('ren-core/host').Theme} Theme */
/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').Spec} Spec */
/** @typedef {import('./engine.js').Placed} Placed */

/** Items that take part in layout. @param {Item} item */
export const active = item => !item.hidden && item.kind !== MARKER && !(item.kind === TEXT && (item.own.length === 0 || follows(item) || blank(item)));

/** Items that take no room: hidden ones, empty text, text in the run of the text before it, and a run of white space alone (as `active`'s). @param {Item} item */
const absent = item => item.hidden || (item.kind === TEXT && (item.own.length === 0 || follows(item) || blank(item)));

/** White space CSS collapses (white-space: normal): spaces, tabs and line breaks, not a no-break space. */
const SPACES = /[ \t\n\r\f]+/g;
/** The same at the ends of a run. */
const ENDS = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;
/** Only white space CSS collapses. */
const SPACE_ONLY = /^[ \t\n\r\f]*$/;

/**
 * True for a text node whose run collapses to nothing (white space alone,
 * in a View), which CSS lays out as no box at all.
 * @param {Item} item
 */
const blank = item => item.r.wrap && SPACE_ONLY.test(item.own) && runOf(item) === '';

/**
 * True for a text node inside an Action (a button's text keeps its spaces
 * and line breaks: white-space: pre, as ren-dom's button sets it).
 * @param {Item} item
 */
function kept(item) {
  for (let p = item.parent; p !== null; p = p.parent) if (p.kind === ACTION) return true;
  return false;
}

/**
 * True for a text node laid out in the run of the text before it: adjacent
 * text in a container is one anonymous box, as CSS wraps a run of text in
 * one (`<View>Count: {n}</View>` is one line, a row's gap comes once
 * around it). Markers and empty text between do not part a run.
 * @param {Item} item
 */
export function follows(item) {
  const parent = item.parent;
  if (parent === null || !holds(parent)) return false;
  for (let p = item.prev; p !== null; p = p.prev) {
    if (p.kind === MARKER || (p.kind === TEXT && p.own.length === 0)) continue;
    return p.kind === TEXT;
  }
  return false;
}

/**
 * The text of the run a text node starts: its own and the adjacent text
 * after it. In a View (white-space: normal, as the DOM's), each run of
 * white space is one space and none is left at its ends.
 * @param {Item} item
 */
export function runOf(item) {
  const parent = item.parent;
  if (parent === null || !holds(parent)) return cased(item.own, item.r.case);
  let text = item.own;
  for (let n = item.next; n !== null && (n.kind === TEXT || n.kind === MARKER); n = n.next) if (n.kind === TEXT) text += n.own;
  if (item.r.wrap) text = text.replace(SPACES, ' ').replace(ENDS, '');
  return cased(text, item.r.case);
}

/** True for items that contain children. @param {number} kind */
export const container = kind => kind === VIEW || kind === LAYOUT || kind === SCROLL;

/**
 * True for an item laid out and drawn as a container: a View, Layout or
 * Scroll, or an Action holding more than text (a DOM button holding its
 * content), which lays its children out as a View does and stays one
 * press target. An Action of text alone is a leaf that draws its caption.
 * @param {Item} item
 */
export function holds(item) {
  const k = item.kind;
  if (k !== ACTION) return k === VIEW || k === LAYOUT || k === SCROLL;
  if (item.caption !== null) return false;
  for (let c = item.first; c !== null; c = c.next) if (c.kind !== TEXT && c.kind !== MARKER) return true;
  return false;
}

/** The line height of resolved text. @param {Resolved} r */
export const line = r => lineOf(r.size, r.leading);

/**
 * A line box's height at `size` and `leading` as a browser lays it out:
 * the font size to the nearest 64th of a pixel (Blink's
 * ComputedFontSizeAsFixed: 10.4 is 10.40625), times the leading, down to
 * a 64th (a LayoutUnit), so rows stack on the DOM's 64ths. The float noise
 * of the product does not pull an exact height down.
 * @param {number} size @param {number} leading
 */
export const lineOf = (size, leading) => down64(near64(size) * leading);

/**
 * Where each row of `text` starts in it: each row is a run of the text, found
 * after the one before (past the spaces or line break between them).
 * @param {string} text @param {readonly string[]} rows
 * @returns {number[]}
 */
export function starts(text, rows) {
  const out = new Array(rows.length);
  let at = 0;
  for (let i = 0; i < rows.length; i++) {
    // An empty row (an empty paragraph) starts past the line break that ends the row before.
    if (rows[i] === '' && i > 0 && text.charCodeAt(at) === 10) at++;
    const found = rows[i] === '' ? at : text.indexOf(rows[i], at);
    out[i] = found < 0 ? at : found;
    at = out[i] + rows[i].length;
  }
  return out;
}

/** Scratch records the state styles overlay into (resolve is not reentrant). */
const A = new Style();
const B = new Style();
const C = new Style();
/** @template {number | string} T @param {T} v @param {number} d @returns {T | number} */
const n = (v, d) => (v === v ? v : d);
/** @param {number | null} v @param {number} d */
const c = (v, d) => (v === null ? d : v);
/**
 * The longest length a box keeps, as a browser's layout: its lengths stop
 * at about 2^25 px. Taffy's boxes are 32-bit floats, so a length past their
 * range (1e39, a 40-digit percent) comes back as Infinity or NaN, which
 * would reach the painter (and keep its damage from ever settling).
 */
const LONGEST = 33554428;
/** A box value from the engine, held within LONGEST; NaN as 0. @param {number} v */
const held = v => (v === v ? (v > LONGEST ? LONGEST : v < -LONGEST ? -LONGEST : v) : 0);
/** The largest scale a transform keeps: a box at LONGEST scaled by it stays finite. @param {number} v */
const scaled = v => (v > LONGEST ? LONGEST : v < -LONGEST ? -LONGEST : v);
/** An angle in degrees within a turn (as it draws): a huge one's radians stay finite. @param {number} v */
const turned = v => v % 360;
/** The largest line height, a multiple of the font size: a line at the largest font stays within LONGEST. */
const LEADING_MOST = 3355;
/** A line height, from 0 to LEADING_MOST. @param {number} v */
const leadingOf = v => (v > LEADING_MOST ? LEADING_MOST : v > 0 ? v : 0);
/** The largest font size (a browser's too): text past it is drawn at it. */
const FONT_MOST = 10000;
/** A font size, from 0 to FONT_MOST. @param {number} v */
const fontSize = v => (v > FONT_MOST ? FONT_MOST : v > 0 ? v : 0);

/**
 * A length in pixels as Blink lays it out: a LayoutUnit, whole 64ths of a
 * pixel toward zero (padding 13.2 is 13.1875), so boxes built of
 * fractional lengths land where the DOM's do. Percentages and 'auto' stay;
 * float noise does not pull an exact 64th down.
 * @template {number | string} T @param {T} v @returns {T}
 */
export const layoutUnit = v => /** @type {T} */ (typeof v === 'number' && Number.isFinite(v) ? toward64(v) : v);

/**
 * A border width as a browser computes it: whole device pixels, down,
 * and a border thinner than one device pixel as one (CSS's "snap as a
 * border width", which Blink applies with the device's zoom), so a half
 * pixel border between grouped buttons takes a pixel as the DOM's does.
 * @param {number} w @param {number} scale
 */
export const snapBorder = (w, scale) => (w > 0 ? Math.max(1, Math.floor(w * scale + 1e-6)) / scale : w);

/**
 * Resolves an item's style: the theme's defaults for its kind, the text its
 * parent passes down, its shorthand props, its style and the styles of its
 * states. Returns true when what it passes down to its children changed.
 * @param {Item} item @param {Resolved | null} parent @param {Theme} theme @param {number} [scale] device pixels a logical one (borders snap to them) @param {Fonts | null} [fonts] what measures text (the typefaces a family names)
 */
export function resolve(item, parent, theme, scale = 1, fonts = null) {
  const k = item.kind;
  const r = item.r;
  let s = item.style;
  const state = item.state;
  if (state !== 0) {
    if ((state & HOVER) !== 0 && s.hover !== null) s = overlay(s, s.hover, A);
    if ((state & PRESS) !== 0 && item.style.press !== null) s = overlay(s, item.style.press, B);
    if ((state & FOCUS) !== 0 && item.style.focus !== null) s = overlay(s, item.style.focus, C);
  }
  const box = holds(item);
  const action = k === ACTION;
  const edit = k === EDIT;
  const control = action || edit;
  const media = k === IMAGE || k === SHAPE;
  const choice = action && item.choice && !item.selected;
  // Text, first: sizes depend on it. Color, size, weight, italic,
  // alignment, line height and selectability inherit, as in CSS.
  const size = fontSize(n(s.fontSize, n(item.size, parent === null ? theme.text : parent.size)));
  const bold = s.fontWeight > 0 ? s.fontWeight >= 600 : parent !== null && parent.bold;
  const italic = s.italic >= 0 ? s.italic === 1 : parent !== null && parent.italic;
  const mono = s.fontFamily !== null ? monospaced(s.fontFamily) : parent !== null && parent.mono;
  const family = s.fontFamily !== null ? typefaceOf(fonts, s.fontFamily) : parent !== null ? parent.family : 0;
  const leading = leadingOf(n(s.lineHeight, parent === null ? theme.leading : parent.leading));
  // A disabled Edit is dimmed by the theme: its soft fill and muted text (a style still wins).
  const off = edit && item.disabled;
  const fg = c(s.color, item.color ?? (action ? (choice ? theme.ink : theme.paper) : edit ? (off ? theme.muted : theme.ink) : parent === null ? theme.ink : parent.fg));
  // The direction (HTML's dir, inherited; auto: its text's first strong character, else left to right).
  const dir = item.dir === 0 || item.dir === 1 ? item.dir : item.dir === 2 ? (strongOf(item) === 1 ? 1 : 0) : parent === null ? 0 : parent.dir;
  // The alignment inherits as the style gives it (start, center, end), but a control takes only its own (a
  // button's centered, a field's at its start), as a browser's form controls reset it; it lands on a side by
  // the item's own direction.
  const alignText = s.textAlign >= 0 ? s.textAlign : action ? 1 : edit || parent === null ? 0 : parent.alignText;
  const textAlign = dir === 1 && alignText !== 1 ? 2 - alignText : alignText;
  // A decoration reaches the text below it; selection is the text's own (buttons and fields keep theirs).
  const underline = s.underline >= 0 ? s.underline === 1 : parent !== null && parent.underline;
  const strike = s.strike >= 0 ? s.strike === 1 : parent !== null && parent.strike;
  // A Scroll's bars: its own width (scrollbar-width is not inherited), the colors inherited (scrollbar-color).
  const bar = k !== SCROLL ? 0 : s.scrollbarWidth === 2 ? 0 : s.scrollbarWidth === 1 ? theme.bar / 2 : theme.bar;
  const thumb = s.scrollbarThumb ?? (parent === null ? -1 : parent.thumb);
  const track = s.scrollbarTrack ?? (parent === null ? -1 : parent.track);
  // An inert region (its own or an ancestor's) takes no pointer and no selection, whatever its children say.
  const inert = item.inert || (parent !== null && parent.inert);
  const select = !inert && (s.select >= 0 ? s.select === 1 : control ? false : parent === null || parent.select);
  const events = !inert && (s.pointerEvents >= 0 ? s.pointerEvents === 1 : parent === null || parent.events);
  const ph = c(s.placeholderColor, parent === null ? theme.muted : parent.ph);
  // The text's case inherits, but a control takes only its own, as a browser's form controls reset it.
  const cases = s.textTransform >= 0 ? s.textTransform : control || parent === null ? 0 : parent.case;
  // No box (a container's display: contents): its children lay out as its parent's, so they run along its parent's axis.
  const contents = s.display === 2 && (k === VIEW || k === LAYOUT || k === SCROLL);
  const row = contents ? parent !== null && parent.row : s.direction >= 0 ? s.direction === 1 : item.row === 1;
  const grid = contents ? parent !== null && parent.grid : box && s.display === 1;
  const passed = r.fg !== fg || r.size !== size || r.bold !== bold || r.italic !== italic || r.mono !== mono || r.family !== family || r.leading !== leading || r.alignText !== alignText || r.dir !== dir || r.underline !== underline || r.strike !== strike || r.select !== select || r.events !== events || r.inert !== inert || r.thumb !== thumb || r.track !== track || r.ph !== ph || r.case !== cases || (contents && (r.row !== row || r.grid !== grid));
  r.fg = fg;
  r.size = size;
  r.bold = bold;
  r.italic = italic;
  r.mono = mono;
  r.family = family;
  r.face = (bold ? BOLD : 0) | (italic ? ITALIC : 0) | (mono ? MONO : 0) | (family << SLOT);
  r.leading = leading;
  r.alignText = alignText;
  r.textAlign = textAlign;
  r.dir = dir;
  r.underline = underline;
  r.strike = strike;
  r.select = select;
  r.events = events;
  r.inert = inert;
  r.bar = bar;
  r.thumb = thumb;
  r.track = track;
  r.fit = s.objectFit > 0 ? s.objectFit : 0;
  r.ph = ph;
  r.case = cases;
  r.touch = s.touchAction;
  r.contents = contents;
  if (item.spans !== null) spanned(item, r, fonts);
  // The box.
  r.grid = grid;
  r.row = row;
  // A clamped Label wraps. A View's bare text wraps and collapses its white
  // space (white-space: normal, the DOM's); an Action's keeps it (pre).
  r.wrap = k === TEXT ? !kept(item) : (k === LABEL && item.clamp > 0) || (s.wrap >= 0 ? s.wrap === 1 : item.wrap >= 0 ? item.wrap === 1 : box && item.row === 1);
  const gap = n(s.gap, n(item.gap, 0));
  r.colGap = layoutUnit(n(s.columnGap, gap));
  r.rowGap = layoutUnit(n(s.rowGap, gap));
  r.columns = s.columns;
  r.rows = s.rows;
  r.column = s.column;
  r.rowLine = s.row;
  const inset = control ? theme.inset : 0;
  const pad = item.pad;
  const edge = edit ? 1 : 0;
  r.bT = snapBorder(n(s.borderTop, edge), scale);
  r.bR = snapBorder(n(s.borderRight, edge), scale);
  r.bB = snapBorder(n(s.borderBottom, edge), scale);
  r.bL = snapBorder(n(s.borderLeft, edge), scale);
  r.bw = Math.max(r.bT, r.bR, r.bB, r.bL);
  // The rows of a multi-line Edit start where a one-line field's text sits.
  const block = edit && item.lines > 1 ? Math.max(0, (theme.field - lineOf(size, leading)) / 2 - r.bT) : 0;
  // Lengths as LayoutUnits, as Blink lays them out.
  r.pt = layoutUnit(n(s.paddingTop, n(pad, block)));
  r.pr = layoutUnit(n(s.paddingRight, n(pad, inset)));
  r.pb = layoutUnit(n(s.paddingBottom, n(pad, block)));
  r.pl = layoutUnit(n(s.paddingLeft, n(pad, inset)));
  r.mt = layoutUnit(n(s.marginTop, 0));
  r.mr = layoutUnit(n(s.marginRight, 0));
  r.mb = layoutUnit(n(s.marginBottom, 0));
  r.ml = layoutUnit(n(s.marginLeft, 0));
  // A multi-line Edit is its rows high: a field, and a line per row past the first; one that grows is between its rows and its autosize.
  const multi = edit && item.lines > 1;
  const grows = multi && item.autosize > 0;
  const extra = multi ? theme.field + (item.lines - 1) * lineOf(size, leading) : NaN;
  r.width = layoutUnit(n(s.width, item.width ?? (media ? theme.media : NaN)));
  r.height = layoutUnit(n(s.height, item.height ?? (media ? theme.media : k === SCROLL ? theme.region : grows ? NaN : extra)));
  // Minimums: CSS's automatic one (NaN), but a field's height and an Edit's entry width.
  // A Label with a clamp or an ellipsis clips its text, so it may shrink to nothing (CSS's automatic minimum of a clipping box).
  r.minW = layoutUnit(n(s.minWidth, n(item.min, edit && r.width !== r.width ? theme.entry : k === LABEL && (item.clamp > 0 || item.ellipsis) ? 0 : NaN)));
  r.maxW = layoutUnit(n(s.maxWidth, Infinity));
  r.minH = layoutUnit(n(s.minHeight, grows ? extra : control ? theme.field : NaN));
  r.maxH = layoutUnit(n(s.maxHeight, grows && item.autosize < Infinity ? theme.field + (Math.max(item.lines, item.autosize) - 1) * lineOf(size, leading) : Infinity));
  r.ratio = s.aspectRatio;
  r.abs = s.position === 1;
  // Sticky: in the flow where it is (its insets hold it in its scrollport as it paints).
  r.sticky = s.position === 2;
  // Fixed: out of the flow, placed against the viewport as it paints.
  r.fixed = s.position === 3;
  r.top = layoutUnit(n(s.top, NaN));
  r.right = layoutUnit(n(s.right, NaN));
  r.bottom = layoutUnit(n(s.bottom, NaN));
  r.left = layoutUnit(n(s.left, NaN));
  r.z = s.zIndex;
  r.grow = n(s.grow, 0);
  r.shrink = n(s.shrink, 1);
  r.align = s.align >= 0 ? s.align : 3;
  r.self = s.self;
  // A button centers what it holds; unset is CSS's normal (a grid's auto tracks stretch).
  r.justify = s.justify >= 0 ? s.justify : action && box ? 1 : -1;
  r.clip = s.overflow === 1 || k === SCROLL;
  // Paint.
  const bg = s.background;
  r.grad = bg !== null && typeof bg === 'object' ? bg : null;
  r.bg = r.grad !== null ? -1 : c(/** @type {number | null} */ (bg), item.fill ?? (action ? (choice ? theme.soft : theme.accent) : edit ? (off ? theme.soft : theme.paper) : -1));
  r.opacity = n(s.opacity, 1);
  const ink = edit ? (item.invalid ? theme.danger : theme.border) : fg;
  r.bc = c(s.borderTopColor, ink);
  r.cR = c(s.borderRightColor, ink);
  r.cB = c(s.borderBottomColor, ink);
  r.cL = c(s.borderLeftColor, ink);
  r.bs = s.borderStyle >= 0 ? s.borderStyle : 0;
  const round = control ? theme.radius : 0;
  r.rtl = n(s.radiusTopLeft, round);
  r.rtr = n(s.radiusTopRight, round);
  r.rbr = n(s.radiusBottomRight, round);
  r.rbl = n(s.radiusBottomLeft, round);
  r.radius = Math.max(r.rtl, r.rtr, r.rbr, r.rbl);
  // A transform: painted and hit, not laid out.
  r.sx = scaled(n(s.scaleX, 1));
  r.sy = scaled(n(s.scaleY, 1));
  r.rot = turned(n(s.rotate, 0));
  r.kx = turned(n(s.skewX, 0));
  r.ky = turned(n(s.skewY, 0));
  r.tx = n(s.translateX, 0);
  r.ty = n(s.translateY, 0);
  r.ox = s.originX === s.originX ? s.originX : '50%';
  r.oy = s.originY === s.originY ? s.originY : '50%';
  r.tf = r.sx !== 1 || r.sy !== 1 || r.rot !== 0 || r.kx !== 0 || r.ky !== 0 || r.tx !== 0 || r.ty !== 0;
  r.shColor = c(s.shadowColor, -1);
  r.shX = n(s.shadowX, 0);
  r.shY = n(s.shadowY, 0);
  r.shBlur = n(s.shadowBlur, 0);
  if (contents) unbox(r);
  item.stale = false;
  return passed;
}

/**
 * Drops what a box without one would have (display: contents): its
 * padding, border, margin, sizes, placement, paint, transform, opacity and
 * clip; what it passes down (text) stays.
 * @param {Resolved} r
 */
function unbox(r) {
  r.pt = r.pr = r.pb = r.pl = 0;
  r.mt = r.mr = r.mb = r.ml = 0;
  r.bT = r.bR = r.bB = r.bL = r.bw = 0;
  r.width = r.height = r.minW = r.minH = NaN;
  r.maxW = r.maxH = Infinity;
  r.ratio = NaN;
  r.abs = r.sticky = r.fixed = false;
  r.top = r.right = r.bottom = r.left = NaN;
  r.z = NaN;
  r.clip = false;
  r.bg = -1;
  r.grad = null;
  r.opacity = 1;
  r.shColor = -1;
  r.radius = r.rtl = r.rtr = r.rbr = r.rbl = 0;
  r.tf = false;
}

/**
 * Resolves a Label's runs: each run's style over the Label's text (color,
 * size, weight, italic, family and decorations inherit, as a span's in
 * CSS; a background is a color). Its rows follow. An Edit's runs keep its
 * size and family (one font, one line height), as ren-dom's field does.
 * @param {Item} item @param {Resolved} r @param {Fonts | null} fonts
 */
function spanned(item, r, fonts) {
  const spans = /** @type {import('./scene.js').Span[]} */ (item.spans);
  const edit = item.kind === EDIT;
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const s = sp.style;
    sp.size = edit ? r.size : fontSize(n(s.fontSize, r.size));
    const bold = s.fontWeight > 0 ? s.fontWeight >= 600 : r.bold;
    const italic = s.italic >= 0 ? s.italic === 1 : r.italic;
    const named = edit ? null : s.fontFamily;
    const mono = named !== null ? monospaced(named) : r.mono;
    const family = named !== null ? typefaceOf(fonts, named) : r.family;
    sp.face = (bold ? BOLD : 0) | (italic ? ITALIC : 0) | (mono ? MONO : 0) | (family << SLOT);
    sp.fg = c(s.color, r.fg);
    sp.bg = typeof s.background === 'number' ? s.background : -1;
    sp.underline = s.underline >= 0 ? s.underline === 1 : r.underline;
    sp.strike = s.strike >= 0 ? s.strike === 1 : r.strike;
  }
  item.spanGen++;
}

/**
 * What measures an item's text: its runs (an Edit's while they match its
 * value), or its one face and size.
 * @param {Item} item @param {Fonts} fonts @returns {import('./text.js').Measure}
 */
export function measureOf(item, fonts) {
  const spans = item.kind === EDIT ? edited(item) : item.spans;
  return spans !== null ? new Runs(fonts, spans, item.kind !== EDIT) : new Face(fonts, item.r.size, item.r.face);
}

/**
 * The width of an item's row `i` as drawn: with runs, its characters from
 * the text in theirs, and an ellipsis in the run of the last one kept.
 * @param {Item} item @param {import('./text.js').Measure} m @param {number} i
 */
export function rowWidth(item, m, i) {
  const row = /** @type {string[]} */ (item.rows)[i];
  const at = /** @type {number[]} */ (item.starts)[i];
  const kept = item.cuts === null ? row.length : item.cuts[i];
  m = rowMeasure(item, m, i);
  const w = kept >= row.length ? m.width(row, at) : m.width(row.slice(0, kept), at) + m.width(row.slice(kept), at + Math.max(0, kept - 1));
  // Snapped runs paint the row's last piece up to its 64th too (a span cut by the row's end, its ellipsis with it).
  return m instanceof Runs && m.snap ? unit(w) : w;
}

/**
 * The measure of an item's row `i` as drawn, through offsets from its
 * start (`starts`): `m`, unless the row keeps characters of its runs apart
 * in the text (`kept`), then runs over the row itself, each character in
 * its run in the text.
 * @param {Item} item @param {import('./text.js').Measure} m @param {number} i
 * @returns {import('./text.js').Measure}
 */
export function rowMeasure(item, m, i) {
  const map = item.kept === null ? null : item.kept[i];
  if (map === null || !(m instanceof Runs)) return m;
  const at = /** @type {number[]} */ (item.starts)[i];
  /** @type {import('./text.js').Run[]} */
  const runs = [];
  let last = -1;
  for (let j = 0; j < map.length; j++) {
    const k = m.at(at + map[j]);
    if (k === last) runs[runs.length - 1].end = at + j + 1;
    else runs.push({ start: at + j, end: at + j + 1, size: m.runs[k].size, face: m.runs[k].face });
    last = k;
  }
  return new Runs(m.fonts, runs, m.snap);
}

/**
 * The direction row `i` of an item is laid out in (`order`): the item's,
 * or the levels of a row cut with an ellipsis (`levels`).
 * @param {Item} item @param {number} i
 * @returns {number | Uint8Array}
 */
export const dirOf = (item, i) => (item.levels === null ? item.r.dir : (item.levels[i] ?? item.r.dir));

/**
 * The offset in an item's text of the character at `j` in its row `i` (at
 * the row's kept end or past it, its ellipsis: after the last one kept).
 * @param {Item} item @param {number} i @param {number} j
 */
export function textAt(item, i, j) {
  const at = /** @type {number[]} */ (item.starts)[i];
  const map = item.kept === null ? null : item.kept[i];
  if (map === null) return at + j;
  return at + (j < map.length ? map[j] : map.length === 0 ? 0 : map[map.length - 1] + 1);
}

/**
 * Where an offset of an item's text falls in its row `i`: the index of the
 * first character the row keeps at or after it (from the row's start;
 * below 0 before it).
 * @param {Item} item @param {number} i @param {number} offset
 */
export function rowIndex(item, i, offset) {
  const at = /** @type {number[]} */ (item.starts)[i];
  const map = item.kept === null ? null : item.kept[i];
  if (map === null || offset <= at) return offset - at;
  let j = 0;
  while (j < map.length && at + map[j] < offset) j++;
  return j;
}

/**
 * Where an Edit's row `text` (at `at` in its value) starts in its text
 * box `room` wide, as a field aligns it (`textAlign`, by its
 * direction). `kind` 0: a one-line Edit's value, which starts at its
 * start edge (the right, right to left) when it is wider than the box, as
 * CSS aligns text that overflows. 2: a multi-line Edit's row a soft wrap
 * ends, whose last spaces hang past the box (at its right left to right,
 * at its left right to left, where they are laid) and are not aligned. 1:
 * another row.
 * @param {Resolved} r @param {import('./text.js').Measure} m @param {string} text @param {number} at @param {number} room @param {number} kind
 */
export function indent(r, m, text, at, room, kind) {
  const align = r.textAlign;
  if (align === 0 && r.dir === 0) return 0;
  if (kind === 0) {
    const w = m.width(text, at);
    return w > room ? (r.dir === 1 ? room - w : 0) : align === 0 ? 0 : align === 1 ? (room - w) / 2 : room - w;
  }
  const kept = kind === 2 ? text.replace(/ +$/, '') : text;
  const w = m.width(kept, at);
  const hang = r.dir === 1 && kept.length < text.length ? m.width(text, at) - w : 0;
  return (align === 0 ? 0 : align === 1 ? (room - w) / 2 : room - w) - hang;
}

/** The row of an item's text at `dy` from its top, clamped. @param {Item} item @param {number} dy */
export function rowAt(item, dy) {
  const rows = /** @type {string[]} */ (item.rows);
  const tops = item.tops;
  if (tops === null) return Math.max(0, Math.min(rows.length - 1, Math.floor(dy / line(item.r))));
  let i = 0;
  while (i < rows.length - 1 && tops[i + 1] <= dy) i++;
  return i;
}

/** The height of an item's first `count` rows: its runs' line boxes, else a line each. @param {Item} item @param {number} count */
export const high = (item, count) => (item.tops !== null ? item.tops[Math.min(count, item.tops.length - 1)] : count * line(item.r));

/**
 * With runs, each row's line box as CSS sets it: every run in the row (and
 * the Label's own text, its strut) has its own leading around its ascent and
 * descent on one baseline; the row is as high as the highest above it and
 * the deepest below it. Into `item.tops` (one more: the bottom) and
 * `item.bases` (each baseline from its row's top).
 * @param {Item} item @param {Fonts} fonts
 */
function boxes(item, fonts) {
  const rows = /** @type {string[]} */ (item.rows);
  const starts = /** @type {number[]} */ (item.starts);
  const cuts = /** @type {number[]} */ (item.cuts);
  const spans = /** @type {import('./scene.js').Span[]} */ (item.spans);
  const r = item.r;
  const leading = r.leading;
  /** Above and below the baseline of text in a face and size, its half leading included. @param {number} size @param {number} f */
  const reach = (size, f) => {
    const height = lineOf(size, leading);
    const above = baseline(fonts, size, height, f);
    return [above, height - above];
  };
  const [sa, sd] = reach(r.size, r.face);
  const tops = [0];
  const bases = [];
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    const from = starts[i];
    const to = from + cuts[i];
    const map = item.kept === null ? null : item.kept[i];
    // The last character kept, whose run the ellipsis takes.
    const end = map === null ? Math.max(from, to - 1) : from + (map.length === 0 ? 0 : map[map.length - 1]);
    let above = sa;
    let below = sd;
    for (let k = 0; k < spans.length; k++) {
      const sp = spans[k];
      // Its characters in the row, or the ellipsis that takes its run.
      const inside = (map === null ? Math.max(from, sp.start) < Math.min(to, sp.end) : map.some(o => sp.start <= from + o && from + o < sp.end)) || (cuts[i] < rows[i].length && sp.start <= end && end < sp.end);
      if (!inside) continue;
      const [a, b] = reach(sp.size, sp.face);
      if (a > above) above = a;
      if (b > below) below = b;
    }
    bases.push(above);
    y += above + below;
    tops.push(y);
  }
  item.tops = tops;
  item.bases = bases;
}

/**
 * The nodes of a container's children in the layout tree, into `out`: a
 * child with no box (`flat`) gives its own children's in its place.
 * @param {Item} item @param {number[]} out
 */
function gather(item, out) {
  for (let ch = item.first; ch !== null; ch = ch.next) {
    if (ch.kind === MARKER) continue;
    if (ch.flat) gather(ch, out);
    else out.push(ch.node);
  }
  return out;
}

/** Marks every item below `item` for resolving and layout (what it passes down changed). @param {Item} item */
function down(item) {
  for (let ch = item.first; ch !== null; ch = ch.next) {
    ch.stale = true;
    ch.dirty = true;
    down(ch);
  }
}

// ---------------------------------------------------------------------------
// Layout styles

const ALIGN = /** @type {const} */ (['start', 'center', 'end', 'stretch']);
const JUSTIFY = /** @type {const} */ (['start', 'center', 'end', 'between', 'around', 'evenly']);

/** A length as CSS's: NaN (and an endless max) is 'auto'; a percentage stays. @param {number | string} v */
const dim = v => (v === v && v !== Infinity ? v : 'auto');

/**
 * The minimum size of a leaf whose content has one size (text on one line,
 * an Action, an Edit), written on the leaf itself: CSS's automatic minimum
 * is that content (capped by a set size), and a set minimum, never below
 * it (the leaf keeps a content child otherwise), is at least that. A set
 * maximum caps the content first, as CSS clamps a size by its max (a
 * Label of one line 420 wide at most is 420 wide, its text past it).
 * @param {number} min the set minimum (NaN: automatic) @param {number} content its border-box content size @param {number} size a set size (NaN: none) @param {number | string} max a set maximum (NaN or Infinity: none)
 */
function floor(min, content, size, max) {
  const most = typeof max === 'number' && max === max ? Math.min(content, max) : content;
  return min === min ? Math.max(min, most) : size === size ? Math.min(most, size) : most;
}

/**
 * How long a direct leaf is across its parent (a row: its height), as its
 * minimum there holds it: its content's border box, and its margins.
 * @param {Item} item @param {boolean} row its parent lays children in a row
 */
const crossOf = (item, row) => (row ? item.sh + item.r.mt + item.r.mb : item.sw + item.r.ml + item.r.mr);

/** A track length in pixels ('0', '12px', '12'), else NaN. @param {string} t */
const pixels = t => (/^\d*\.?\d+(px)?$/.test(t) ? parseFloat(t) : NaN);

/**
 * The width a grid's column tracks keep at their minimums, gaps included,
 * when some track is flexible (`fr`) and every track's minimum is a length:
 * `minmax(0, 1fr)`, `minmax(80px, 2fr)`, `120px`, a `repeat(n, ...)` of them.
 * -1 otherwise: no flexible track, a minimum its content sets ('auto', a
 * bare `1fr`, min-content), a percentage, or a track count the width sets
 * (auto-fill).
 * @param {string | null} columns @param {number} gap
 */
function trackFloor(columns, gap) {
  if (columns === null || columns.indexOf('fr') < 0) return -1;
  let sum = 0;
  let count = 0;
  let flexible = false;
  /** @param {string} t @param {number} times */
  const one = (t, times) => {
    const m = /^minmax\(([^,]+),([^)]+)\)$/.exec(t);
    const min = pixels((m === null ? t : m[1]).trim());
    if (m !== null && m[2].trim().endsWith('fr')) flexible = true;
    if (min !== min) return false;
    sum += min * times;
    count += times;
    return true;
  };
  let depth = 0;
  let current = '';
  /** @type {string[]} */
  const list = [];
  for (const ch of columns.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '\n')) {
      if (current !== '') list.push(current);
      current = '';
    } else current += ch;
  }
  if (current !== '') list.push(current);
  for (const t of list) {
    const r = /^repeat\(\s*(\d+)\s*,(.*)\)$/.exec(t);
    if (r === null) {
      if (!one(t.replace(/\s+/g, ''), 1)) return -1;
      continue;
    }
    // Inside a repeat, its tracks split at the spaces outside parentheses.
    const inner = r[2].trim().match(/minmax\([^)]*\)|[^\s]+/g) ?? [];
    for (const u of inner) if (!one(u.replace(/\s+/g, ''), Number(r[1]))) return -1;
  }
  return flexible && count > 0 ? sum + gap * (count - 1) : -1;
}

/**
 * A fixed item's border-box length on an axis where both insets are set
 * and its size is not: the viewport's `view` less the insets (percentages
 * of it) and the margins, as CSS's; NaN otherwise (or with no viewport).
 * @param {number | string} size @param {number | string} a @param {number | string} b @param {number} ma @param {number} mb @param {number} view
 */
function span(size, a, b, ma, mb, view) {
  if (size === size || a !== a || b !== b || !(view >= 0)) return NaN;
  return Math.max(0, view - (typeof a === 'string' ? (parseFloat(a) / 100) * view : a) - (typeof b === 'string' ? (parseFloat(b) / 100) * view : b) - ma - mb);
}

/**
 * What decides an item's layout style, as a string: items with equal keys
 * share one converted style (a thousand rows, a handful of styles).
 * @param {Item} item @param {boolean} across its parent lays children in a row @param {number} top it is laid out on its own: 1 a page, 2 the overlay (0: neither) @param {number} fw @param {number} fh a fixed item's size between its insets (`span`)
 */
function keyOf(item, across, top, fw, fh) {
  const r = item.r;
  return `${r.fixed ? `F${fw},${fh}` : ''}${top === 0 ? '' : top === 1 ? 'R' : 'O'}${item.kind}${item.kind === ACTION && holds(item) ? 'h' : ''}|${item.direct ? (across ? 'D' : 'd') : '-'}|${absent(item) ? 1 : 0}|${r.grid ? 1 : 0}|${r.row ? 1 : 0}|${r.wrap ? 1 : 0}|${r.colGap}|${r.rowGap}|${r.pt},${r.pr},${r.pb},${r.pl}|${r.bT},${r.bR},${r.bB},${r.bL}|${r.mt},${r.mr},${r.mb},${r.ml}|${r.width},${r.height}|${r.minW},${r.minH}|${r.maxW},${r.maxH}|${r.ratio}|${r.abs ? 1 : r.sticky ? 2 : r.fixed ? 3 : 0}|${r.top},${r.right},${r.bottom},${r.left}|${r.grow}|${r.shrink}|${r.align}|${r.self}|${r.justify}|${r.clip ? 1 : 0}|${item.kind === SCROLL ? item.axis : ''}|${r.columns}|${r.rows}|${r.column}|${r.rowLine}|${item.fitW}|${r.dir}`;
}

/**
 * The layout style of a resolved item, as a CSS Box. A leaf whose content
 * has one size takes it as its flex basis along its parent's main axis
 * (CSS's `auto` basis is the content). A root without a width fills the
 * width it is laid out at (the viewport's), or takes its content's when
 * that is open. The overlay without a height is as high as the viewport,
 * as a portal layer covering it is on the DOM.
 * A fixed item between two insets on an axis without a size is as long as
 * the viewport between them (`fw`, `fh`: `span`), as CSS sizes it.
 * @param {Item} item @param {Theme} theme @param {boolean} across the parent lays its children in a row @param {number} top 1 a page, 2 the overlay, 0 neither @param {number} fw @param {number} fh
 * @returns {import('./engine.js').Box}
 */
function boxOf(item, theme, across, top, fw, fh) {
  const root = top !== 0;
  const r = item.r;
  const k = item.kind;
  const scroll = k === SCROLL;
  const held = holds(item);
  // Wrapping text's leaf holds its content child in a column, stretched to
  // the leaf's width: Taffy sizes a row that does not wrap, sized to fit its
  // content, at its max-content width.
  const wrapping = !held && (k === LABEL || k === TEXT) && r.wrap;
  return box({
    display: absent(item) ? 'none' : r.grid ? 'grid' : 'flex',
    position: r.abs || r.fixed ? 'absolute' : 'relative',
    inset: r.sticky || r.fixed ? ['auto', 'auto', 'auto', 'auto'] : [dim(r.top), dim(r.right), dim(r.bottom), dim(r.left)],
    // A leaf holds its content child in a row (wrapping text in a column).
    direction: wrapping || (held && !r.row) ? 'column' : 'row',
    wrap: held && r.wrap,
    columnGap: r.colGap,
    rowGap: r.rowGap,
    padding: [r.pt, r.pr, r.pb, r.pl],
    border: [r.bT, r.bR, r.bB, r.bL],
    margin: [r.mt, r.mr, r.mb, r.ml],
    // A box fitted to the room it was found to have (`fits`) is as wide as that.
    width: fw === fw ? fw : item.fitW !== Infinity ? item.fitW : root && r.width !== r.width ? '100%' : dim(r.width),
    height: fh === fh ? fh : top === 2 && r.height !== r.height ? '100%' : dim(r.height),
    // A leaf sized by its content gets its minimums and basis per node (SIZE).
    minWidth: item.direct ? 'auto' : dim(r.minW),
    minHeight: item.direct ? 'auto' : dim(r.minH),
    maxWidth: dim(r.maxW),
    maxHeight: dim(r.maxH),
    ratio: r.ratio === r.ratio ? r.ratio : null,
    basis: 'auto',
    grow: r.grow,
    shrink: r.shrink,
    align: held ? ALIGN[r.align] : wrapping ? 'stretch' : 'start',
    self: r.self < 0 ? 'auto' : ALIGN[r.self],
    justify: r.justify < 0 ? 'normal' : JUSTIFY[r.justify],
    // A Scroll scrolls along its axis (its bar's room kept), clipping the other.
    overflowX: scroll && item.axis !== 0 ? 'scroll' : r.clip ? 'hidden' : 'visible',
    overflowY: scroll && item.axis !== 1 ? 'scroll' : r.clip ? 'hidden' : 'visible',
    scrollbar: scroll ? r.bar : 0,
    columns: r.columns,
    rows: r.rows,
    column: r.column,
    row: r.rowLine,
    dir: r.dir === 1 ? 'rtl' : 'ltr',
  });
}

// ---------------------------------------------------------------------------
// The tree

/** The face resolved text is set in (Fonts.width). @param {Resolved} r */
const face = r => r.face;

/** The typeface slots of family lists, by the fonts that gave them. @type {WeakMap<Fonts, Map<string, number>>} */
const TYPEFACES = new WeakMap();

/**
 * The slot of the typeface a CSS family list names, as the fonts give it
 * (`Fonts.typeface`), asked once per list; 0 (the root face) for fonts
 * without named typefaces.
 * @param {Fonts | null} fonts @param {string} family
 */
function typefaceOf(fonts, family) {
  if (fonts === null || typeof fonts.typeface !== 'function') return 0;
  let known = TYPEFACES.get(fonts);
  if (known === undefined) TYPEFACES.set(fonts, (known = new Map()));
  let slot = known.get(family);
  if (slot === undefined) {
    slot = fonts.typeface(family) | 0;
    known.set(family, slot);
  }
  return slot;
}

/** True for a CSS family list naming monospace. @param {string} family */
const monospaced = family => family.split(',').some(f => f.trim().replace(/^["']|["']$/g, '').toLowerCase() === 'monospace');

/** The width of the widest line of an item's `text`. @param {Item} item @param {Fonts} fonts @param {string} text */
function widest(item, fonts, text) {
  if (text.length === 0) return 0;
  const m = measureOf(item, fonts);
  if (text.indexOf('\n') < 0) return unit(m.width(text, 0));
  let w = 0;
  let at = 0;
  for (const part of text.split('\n')) {
    w = Math.max(w, m.width(part, at));
    at += part.length + 1;
  }
  return unit(w);
}

/** The width of the widest word of an item's `text` (its min-content when it wraps). @param {Item} item @param {Fonts} fonts @param {string} text */
function longest(item, fonts, text) {
  const m = measureOf(item, fonts);
  let w = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = i === text.length ? 32 : text.charCodeAt(i);
    if (ch !== 32 && ch !== 10) continue;
    if (i > start) w = Math.max(w, m.width(text.slice(start, i), start));
    start = i + 1;
  }
  return unit(w);
}

/** The most pieces wrapping text is cut into (a longer text's pieces are wider than its longest word). */
const PIECES = 64;

/**
 * The widths of the pieces wrapping text lays out as, in a wrapping row:
 * CSS text's intrinsic sizes, with no measuring callback. Side by side
 * they are its max-content width (`most`); the widest is its longest word
 * (`least`), its min-content width.
 * @param {number} most @param {number} least @returns {number[]}
 */
function piecesOf(most, least) {
  if (!(most > 0)) return [];
  if (!(least > 0) || least >= most) return [most];
  const n = Math.min(PIECES, Math.ceil((most - least) / least));
  const rest = (most - least) / n;
  const out = [least];
  for (let i = 0; i < n; i++) out.push(rest);
  return out;
}

/**
 * Room for rounding: the layout keeps sizes as 32-bit floats, a hair below
 * the text they were measured from (a Label shrunk to its longest word).
 */
const SLACK = 1 / 64;

/**
 * The rows of a Label's text at a content width (-1: not wrapped), kept on
 * the item until its text, size, room or cut change. With a cut (the
 * content width of a Label with `lines` or `ellipsis`), rows past its
 * clamp go, and the last row kept (or, on one line, each row too wide)
 * ends with an ellipsis within the cut, as CSS's line clamp and
 * text-overflow draw it.
 * @param {Item} item @param {Fonts} fonts @param {string} text @param {number} room @param {number} [cut]
 */
function rowsOf(item, fonts, text, room, cut = -1) {
  const r = item.r;
  if (item.rows !== null && item.rowsOf === text && item.rowsRoom === room && item.rowsCut === cut && item.rowsSize === r.size && item.rowsFace === face(r) && item.rowsGen === item.spanGen && item.rowsDir === r.dir) return item.rows;
  const m = measureOf(item, fonts);
  let rows = text.length === 0 ? [] : room >= 0 ? Wrapped(m, text, Math.max(1, room) + SLACK) : text.indexOf('\n') < 0 ? [text] : text.split('\n');
  const at = starts(text, rows);
  item.starts = at;
  // With runs, how many characters of each row are the text's (the rest, an ellipsis).
  const cuts = item.spans !== null ? rows.map(row => row.length) : null;
  /** @type {(Int32Array | null)[] | null} */
  let kept = null;
  /** @type {(Uint8Array | null)[] | null} */
  let cutLevels = null;
  /** Cuts row `i` to end with the ellipsis. @param {number} i @param {boolean} more */
  const cutRow = (i, more) => {
    if (more) {
      // The spaces it wrapped at hang at its end, before the ellipsis.
      let end = at[i] + rows[i].length;
      while (text.charCodeAt(end) === 32) end++;
      rows[i] = text.slice(at[i], end);
    }
    const keep = ellipsize(m, rows[i], at[i], cut, more, r.dir);
    if (keep === null) return;
    const row = rows[i];
    let shown = '';
    for (let k = 0; k < keep.length; k++) shown += row[keep[k]];
    rows[i] = shown + ELLIPSIS;
    if (cuts !== null) cuts[i] = keep.length;
    // With right-to-left text, what it keeps stays where the whole row put it: its levels go with it.
    if (order(row, r.dir) !== null) {
      const whole = lineOfLevels(levels(row, r.dir), row, 0, row.length, r.dir);
      const out = new Uint8Array(keep.length + 1);
      for (let k = 0; k < keep.length; k++) out[k] = whole[keep[k]];
      out[keep.length] = r.dir;
      cutLevels ??= rows.map(() => null);
      cutLevels[i] = out;
    }
    // Kept after its first ones: the offsets go with the row.
    if (keep.length > 0 && keep[keep.length - 1] !== keep.length - 1) {
      kept ??= rows.map(() => null);
      kept[i] = keep;
    }
  };
  if (cut >= 0 && rows.length > 0) {
    if (item.clamp > 0) {
      if (rows.length > item.clamp) {
        rows = rows.slice(0, item.clamp);
        if (cuts !== null) cuts.length = rows.length;
        // The last row kept stands for the text after it: it ends with the ellipsis.
        cutRow(rows.length - 1, true);
      }
    } else for (let i = 0; i < rows.length; i++) cutRow(i, false);
  }
  item.rows = rows;
  item.cuts = cuts;
  item.kept = kept;
  item.levels = cutLevels;
  item.rowsGen = item.spanGen;
  if (cuts !== null) boxes(item, fonts);
  else item.tops = item.bases = null;
  item.rowsOf = text;
  item.rowsRoom = room;
  item.rowsCut = cut;
  item.rowsSize = r.size;
  item.rowsFace = face(r);
  item.rowsDir = r.dir;
  return item.rows;
}

/** The ellipsis a cut row ends with. */
const ELLIPSIS = '\u2026';

/** The offsets an ellipsis cut keeps, reused while a row is cut (`ellipsize`). @type {number[]} */
const KEEP = [];

/**
 * Where a row (at `at` in the text) is cut to fit `room` with an ellipsis,
 * as a browser cuts a line it truncates: laid out in its direction `base`
 * (its runs in visual order, `order`) from its start edge, the characters
 * that reach past `room` less the ellipsis go, and the ellipsis follows
 * those kept on their end side (so a right-to-left run in a left-to-right
 * row keeps its last characters, and a row of mixed directions may keep
 * runs apart in the text). Spaces are kept as any character. Null when it
 * fits whole and nothing follows it (`more`), else the offsets kept in the
 * row, ascending. The ellipsis takes the run of the last character kept.
 * @param {import('./text.js').Measure} m @param {string} row @param {number} at @param {number} room @param {boolean} more text follows the row @param {number} base
 * @returns {Int32Array | null}
 */
function ellipsize(m, row, at, room, more, base) {
  if (!more && m.width(row, at) <= room) return null;
  // The ellipsis in the run of the row's last character, then of the last one kept if that differs.
  let width = m.width(ELLIPSIS, at + Math.max(0, row.length - 1));
  let keep = keeping(m, row, at, room - width, base);
  if (m instanceof Runs && keep.length > 0) {
    const last = m.width(ELLIPSIS, at + keep[keep.length - 1]);
    if (last !== width) {
      width = last;
      keep = keeping(m, row, at, room - width, base);
    }
  }
  return keep;
}

/**
 * The offsets of a row kept within `room` from its start edge, ascending:
 * whole runs (in visual order from that edge) while they fit, then of the
 * run that does not, as much as fits from the side that edge meets (its
 * first characters when it runs the row's way, else its last), never
 * splitting a surrogate pair.
 * @param {import('./text.js').Measure} m @param {string} row @param {number} at @param {number} room @param {number} base
 */
function keeping(m, row, at, room, base) {
  const runs = row.length === 0 ? null : order(row, base);
  const count = runs === null ? 1 : runs.length / 3;
  KEEP.length = 0;
  let used = 0;
  for (let n = 0; n < count; n++) {
    // From the start edge: the left's run first left to right, the right's right to left.
    const i = (base === 1 ? count - 1 - n : n) * 3;
    const start = runs === null ? 0 : runs[i];
    const end = runs === null ? row.length : runs[i + 1];
    const level = runs === null ? 0 : runs[i + 2];
    const w = m.width(row.slice(start, end), at + start);
    if (used + w <= room) {
      for (let k = start; k < end; k++) KEEP.push(k);
      used += w;
      continue;
    }
    const left = room - used;
    if ((level & 1) === base) {
      // Its first characters: the longest prefix that fits.
      let low = start;
      let high = end;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (m.width(row.slice(start, middle), at + start) <= left) low = middle;
        else high = middle - 1;
      }
      if (inside(row, low)) low--;
      for (let k = start; k < low; k++) KEEP.push(k);
    } else {
      // Its last characters: the longest suffix that fits.
      let low = start;
      let high = end;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (m.width(row.slice(middle, end), at + middle) <= left) high = middle;
        else low = middle + 1;
      }
      if (inside(row, low)) low++;
      for (let k = low; k < end; k++) KEEP.push(k);
    }
    break;
  }
  KEEP.sort((a, b) => a - b);
  return Int32Array.from(KEEP);
}

/**
 * The layout tree beside a scene: a node per item, kept in step with the
 * scene as commands for the engine (engine.js), laid out on demand. One per
 * Document.
 */
export class Boxes {
  /** @param {Fonts} fonts @param {Theme} theme @param {Engine} [engine] where the engine runs (this thread by default) */
  constructor(fonts, theme, engine) {
    this.engine = engine ?? new Local();
    this.fonts = fonts;
    this.theme = theme;
    /** Device pixels a logical one: borders resolve to whole ones. */
    this.scale = 1;
    /** The layout the items' boxes come from; an item reads its box when its `gen` differs. */
    this.gen = 0;
    /** The wrapping text in the tree, whose heights follow their widths after a layout. @type {Set<Item>} */
    this.wrapping = new Set();
    /** The containers with direct leaves stretched across them, checked for room after a layout (`reach`). @type {Set<Item>} */
    this.reaching = new Set();
    /** The grids with flexible columns and no width of their own, fitted to their room after a layout (`fits`). @type {Set<Item>} */
    this.fitting = new Set();
    /** Items removed from the scene; their nodes go unless they come back. @type {Item[]} */
    this.dropped = [];
    /** Style ids by key, shared by the items whose styles are equal. @type {Map<string, number>} */
    this.keys = new Map();
    /** The commands not sent yet: words, and the props of the styles they define. @type {Int32Array} */
    this.ops = new Int32Array(1024);
    this.n = 0;
    /** @type {any[]} */
    this.side = [];
    /** Node ids: the last given, and those given back. */
    this.last = 0;
    /** @type {number[]} */
    this.spare = [];
    /** Items by node id, for the boxes a worker sends. @type {(Item | undefined)[]} */
    this.items = [];
    /** The overlay layer, laid out as high as the viewport. @type {Item | null} */
    this.layer = null;
    /** The items whose pushed boxes changed, for a scene that writes them out (null: not kept). @type {Set<Item> | null} */
    this.moved = null;
    /** The viewport fixed items are sized against: its width in the overlay and in the page (less the page's scrollbar), its height (NaN: none, as a Flow's). */
    this.viewW = NaN;
    this.pageW = NaN;
    this.viewH = NaN;
    /** True while the overlay is being brought in step (its fixed items take the whole viewport's width). */
    this.over = false;
    /** The fixed items, sized again when the viewport changes. @type {Set<Item>} */
    this.pinned = new Set();
  }

  /** Room for `words` more command words. @param {number} words */
  room(words) {
    if (this.n + words <= this.ops.length) return this.ops;
    let length = Math.max(64, this.ops.length * 2);
    while (length < this.n + words) length *= 2;
    const ops = new Int32Array(length);
    ops.set(this.ops.subarray(0, this.n));
    return (this.ops = ops);
  }

  /** A new node's id and its command. @param {number} flags */
  make(flags) {
    const id = this.spare.length > 0 ? /** @type {number} */ (this.spare.pop()) : ++this.last;
    const ops = this.room(3);
    ops[this.n++] = NEW;
    ops[this.n++] = id;
    ops[this.n++] = flags;
    return id;
  }

  /** Sets a node's style: the id of a key, defined on first use. @param {number} node @param {string} key @param {() => any} props */
  shape(node, key, props) {
    const id = this.style(key, props);
    const ops = this.room(3);
    ops[this.n++] = STYLE;
    ops[this.n++] = node;
    ops[this.n++] = id;
  }

  /** The id of a style key, defined on first use. @param {string} key @param {() => any} props */
  style(key, props) {
    let id = this.keys.get(key);
    if (id === undefined) {
      if (this.keys.size >= 1024) {
        this.room(1)[this.n++] = FORGET;
        this.keys.clear();
      }
      id = this.keys.size + 1;
      this.keys.set(key, id);
      const ops = this.room(2);
      ops[this.n++] = DEFINE;
      ops[this.n++] = id;
      this.side.push(props());
    }
    return id;
  }

  /**
   * A leaf sized by its content: its content's border-box size is its
   * minimum (CSS's automatic one, capped by a set size; a set minimum is at
   * least that) and its basis along its parent's main axis, sent per node
   * over the style it shares.
   * @param {Item} item @param {boolean} across
   */
  sizes(item, across) {
    const r = item.r;
    const inset = r.pl + r.pr + r.bL + r.bR;
    const block = r.pt + r.pb + r.bT + r.bB;
    // A leaf is direct only with sizes in pixels (content()).
    const minW = floor(/** @type {number} */ (r.minW), item.cw + inset, /** @type {number} */ (r.width), r.maxW);
    const minH = floor(/** @type {number} */ (r.minH), item.ch + block, /** @type {number} */ (r.height), r.maxH);
    const basis = across ? (r.width === r.width ? NaN : item.cw + inset) : r.height === r.height ? NaN : item.ch + block;
    if (minW === item.sw && minH === item.sh && Object.is(basis, item.sb)) return false;
    item.sw = minW;
    item.sh = minH;
    item.sb = basis;
    return true;
  }

  /** @param {number} node @param {readonly number[]} kids */
  children(node, kids) {
    const ops = this.room(3 + kids.length);
    ops[this.n++] = KIDS;
    ops[this.n++] = node;
    ops[this.n++] = kids.length;
    for (let i = 0; i < kids.length; i++) ops[this.n++] = kids[i];
  }

  /** @param {number} node */
  unmake(node) {
    const ops = this.room(2);
    ops[this.n++] = REMOVE;
    ops[this.n++] = node;
    this.items[node] = undefined;
    this.spare.push(node);
  }

  /** An item's node, made on first use. @param {Item} item */
  node(item) {
    if (item.node !== 0 && item.tree === this) return item.node;
    const node = this.make(0);
    this.items[node] = item;
    item.node = node;
    item.tree = this;
    item.boxKey = '';
    item.inner = 0;
    item.innerKey = '';
    item.hasInner = false;
    item.pieces = [];
    item.piecesKey = '';
    item.wrapAt = -1;
    item.gen = -1;
    item.kids = true;
    item.lays = -1;
    item.over = false;
    item.fitW = Infinity;
    return node;
  }

  /**
   * Brings the tree in step with a changed subtree: resolves styles, sets
   * those that changed, the children of containers whose children changed,
   * and the content of leaves whose content changed.
   * @param {Item} item @param {Resolved | null} parent @param {number} depth
   */
  sync(item, parent, depth) {
    if (depth > 256) throw new Error('REN canv: nesting exceeds 256');
    const node = this.node(item);
    // What an item passes down changing matters to children it had before;
    // a new item's children are new too.
    if (item.stale && resolve(item, parent, this.theme, this.scale, this.fonts) && item.boxKey !== '') down(item);
    // A leaf's content first: its size is part of the leaf's style.
    const box = holds(item);
    if (box) item.direct = false;
    const r = item.r;
    // Its basis runs along its parent's main axis: across in a flex row.
    const across = parent !== null && parent.row && !parent.grid;
    // A flex item stretched across its parent (its size and minimum there
    // automatic) may be narrower (or lower) there than its content: CSS's
    // automatic minimum is along the main axis only. Direct, its content is
    // its minimum on both axes; one found longer than its parent's room
    // after a layout (`wraps`) keeps its content as a child instead (its
    // intrinsic size, with no minimum across).
    item.stretch = parent !== null && !parent.grid && !r.abs && !r.fixed && (r.self >= 0 ? r.self : parent.align) === 3 && (across ? r.height !== r.height && r.minH !== r.minH : r.width !== r.width && r.minW !== r.minW);
    // Commands from here on: its content changed (a fitted box measures it again).
    let mark = this.n;
    const inner = box ? 0 : this.content(item, item.stretch && item.over);
    // A box sized to fit its content (no width of its own, not stretched
    // across a column, or absolute) may take its max-content width in Taffy
    // where CSS fits it to the room it has (fit-content): a grid with
    // flexible columns, a row that does not wrap (or a box holding one), an
    // absolute box (Taffy fits it to its whole containing block, not to the
    // room its insets leave it). `fits` finds the room after a layout.
    item.floor = r.grid && typeof r.colGap === 'number' ? trackFloor(r.columns, r.colGap) : -1;
    const wraps = (item.kind === LABEL || item.kind === TEXT) && r.wrap;
    item.fit = r.width !== r.width && typeof r.maxW === 'number' && !r.fixed && !r.contents && parent !== null && (r.abs ? (r.left !== r.left || r.right !== r.right) && (box || wraps) : box && !parent.row && !parent.grid && (r.self >= 0 ? r.self : parent.align) !== 3);
    if (item.fit) this.fitting.add(item);
    else {
      this.fitting.delete(item);
      item.fitW = Infinity;
    }
    const root = parent === null ? (item === this.layer ? 2 : 1) : 0;
    let fw = NaN;
    let fh = NaN;
    if (r.fixed) {
      this.pinned.add(item);
      fw = span(r.width, r.left, r.right, r.ml, r.mr, this.over ? this.viewW : this.pageW);
      fh = span(r.height, r.top, r.bottom, r.mt, r.mb, this.viewH);
    }
    const key = keyOf(item, across, root, fw, fh);
    if (item.direct) {
      if (this.sizes(item, across) || key !== item.boxKey) {
        const id = this.style(key, () => boxOf(item, this.theme, across, root, fw, fh));
        const ops = this.room(3);
        ops[this.n++] = SIZE;
        ops[this.n++] = node;
        ops[this.n++] = id;
        this.side.push(item.sw, item.sh, item.sb);
        item.boxKey = key;
      }
    } else if (key !== item.boxKey) {
      this.shape(node, key, () => boxOf(item, this.theme, across, root, fw, fh));
      item.boxKey = key;
    }
    if (box) {
      mark = this.n;
      // What the painter needs to know of the children: whether one may be
      // drawn out of the flow's order, and whether a negative stacking
      // context below belongs to this item's context.
      let placed = false;
      let sunk = false;
      let pins = false;
      // A child with no box whose children changed, or that went flat or back.
      let relist = false;
      // How long its direct stretched leaves are across it.
      let reach = 0;
      // How it lays its children out changed: whether one is stretched, or along which axis its basis runs.
      const lays = r.align * 4 + (r.row ? 1 : 0) + (r.grid ? 2 : 0);
      const relay = lays !== item.lays;
      item.lays = lays;
      for (let ch = item.first; ch !== null; ch = ch.next) {
        if (ch.kind === MARKER) continue;
        if (relay) ch.dirty = true;
        // A run of text is laid out by its first text node: it follows the others' text, and they take no room.
        if (ch.kind === TEXT) {
          const after = follows(ch);
          if (after !== ch.followed || (!after && runOf(ch) !== ch.text)) ch.dirty = true;
          ch.followed = after;
        }
        // A child with no box runs its children along this item's axis: they follow it.
        if (ch.r.contents && (ch.r.row !== item.r.row || ch.r.grid !== item.r.grid)) ch.stale = ch.dirty = true;
        if (ch.dirty || ch.stale || ch.node === 0 || ch.tree !== this) this.sync(ch, item.r, depth + 1);
        if (ch.relist) {
          relist = true;
          ch.relist = false;
        }
        if (absent(ch)) continue;
        const cr = ch.r;
        if (ch.direct && ch.stretch) reach = Math.max(reach, crossOf(ch, r.row));
        const z = cr.z;
        if (cr.fixed || ch.pins) pins = true;
        if (ch.placed || ch.pins || cr.abs || cr.fixed || cr.tf || z === z || cr.top === cr.top || cr.right === cr.right || cr.bottom === cr.bottom || cr.left === cr.left) placed = true;
        if (z < 0 || (ch.sunk && z !== z && !(cr.opacity < 1) && !cr.tf)) sunk = true;
      }
      item.placed = placed;
      item.sunk = sunk;
      item.pins = pins;
      // A row as high as its content, not stretched from outside, is never too low for a line of it.
      if (r.row && r.height !== r.height && r.maxH === Infinity && parent !== null && !parent.row && !parent.grid) reach = 0;
      item.reach = reach;
      if (reach > 0) this.reaching.add(item);
      else this.reaching.delete(item);
      // With no box (display contents, shown) its children are its parent's
      // nodes: its own lists none, and its parent lists them again when they
      // change. Otherwise the children's nodes are listed only when they
      // (or those of a child with no box) changed.
      const flat = item.r.contents && !item.hidden;
      if (flat) {
        if (!item.flat) this.children(node, []);
        if (item.kids || relist || !item.flat) item.relist = true;
        item.kids = false;
      } else if (item.kids || relist || item.flat) {
        if (item.flat) item.relist = true;
        this.children(node, gather(item, []));
        item.kids = false;
      }
      item.flat = flat;
    } else {
      if (item.kids || (inner !== 0) !== item.hasInner) {
        this.children(node, inner === 0 ? [] : [inner]);
        item.kids = false;
        item.hasInner = inner !== 0;
      }
      if (((item.kind === LABEL || item.kind === TEXT) && item.r.wrap) || (item.kind === EDIT && item.lines > 1 && item.autosize > 0)) this.wrapping.add(item);
    }
    // A fitted box whose content changed is laid out at its max-content
    // again, and fitted after (`fits`): it may want less room now.
    if (item.fitW !== Infinity && this.n > mark) {
      item.fitW = Infinity;
      const again = keyOf(item, across, root, fw, fh);
      this.shape(node, again, () => boxOf(item, this.theme, across, root, fw, fh));
      item.boxKey = again;
    }
    item.dirty = false;
    // Its drawn text follows at the next `fix`, whether or not boxes moved.
    item.gen = -1;
  }

  /**
   * Brings the tree in step with the scene below the page and the overlay,
   * and lets go of the nodes of items that left it. Returns true when
   * commands wait for the engine. The viewport (`width`, the page's `page`
   * less its scrollbar, `height`) sizes the fixed items set between two
   * insets; they are sized again when it changes.
   * @param {Item} root @param {Item} overlay @param {number} [width] @param {number} [page] @param {number} [height]
   */
  prepare(root, overlay, width = NaN, page = width, height = NaN) {
    this.layer = overlay;
    if (!Object.is(width, this.viewW) || !Object.is(page, this.pageW) || !Object.is(height, this.viewH)) {
      this.viewW = width;
      this.pageW = page;
      this.viewH = height;
      for (const item of this.pinned) {
        if (item.tree !== this || item.parent === null || !item.r.fixed) {
          this.pinned.delete(item);
          continue;
        }
        for (let n = /** @type {Item | null} */ (item); n !== null; n = n.parent) n.dirty = true;
      }
    }
    this.over = false;
    if (root.dirty || root.stale || root.node === 0 || root.tree !== this) this.sync(root, null, 0);
    this.over = true;
    if (overlay.dirty || overlay.stale || overlay.node === 0 || overlay.tree !== this) this.sync(overlay, null, 0);
    this.over = false;
    this.free();
    return this.n > 0;
  }

  /**
   * Sends the commands and lays the page out (`spec`); `done` runs once the
   * boxes can be read: at once in this thread, when the answer comes from a
   * worker.
   * @param {Spec} spec @param {(placed: Placed) => void} done
   */
  arrange(spec, done) {
    const engine = this.engine;
    const ops = this.ops;
    const n = this.n;
    const side = this.side;
    this.n = 0;
    this.side = [];
    const back = engine.send(ops, n, side, spec, (placed, records, count) => {
      this.gen++;
      if (engine.pushed) this.apply(records, count);
      done(placed);
    });
    // A worker holds the buffer until it answers; this thread's engine
    // gives it back (and `done` may have written more to it already).
    if (back !== ops) this.ops = back;
  }

  /** Places the boxes a worker sent. @param {Float32Array} records @param {number} count */
  apply(records, count) {
    const items = this.items;
    for (let i = 0, o = 0; i < count; i++, o += RECORD) {
      const item = items[records[o]];
      if (item === undefined) continue;
      if (this.moved !== null) this.moved.add(item);
      item.x = held(records[o + 1]);
      item.y = held(records[o + 2]);
      item.w = held(records[o + 3]);
      item.h = held(records[o + 4]);
      item.content = held(records[o + 5]);
      item.contentW = held(records[o + 6]);
    }
  }

  /**
   * A leaf's content, for the engine: a hidden child sized as the content, so
   * CSS's own rules give the leaf its max-content and min-content
   * sizes, basis and minimum, with no callback. Text on one line (a Label, an
   * Action) is a box its size; wrapping text is as wide as its text at most
   * (its basis), shrinks to its longest word, and is as high as its rows at
   * the width it last got (`wraps` brings that up to date after a layout);
   * an Edit's content is one line high. Images, Shapes and empty containers
   * have none.
   * @param {Item} item @param {boolean} [kept] it keeps a content child (stretched across a parent too short for its content)
   * @returns {number} the content node, or 0
   */
  content(item, kept = false) {
    const k = item.kind;
    item.direct = false;
    if (k !== LABEL && k !== TEXT && k !== ACTION && k !== EDIT) return 0;
    const r = item.r;
    const fonts = this.fonts;
    const height = line(r);
    // Content of one size goes on the leaf itself (its minimum), unless it is
    // stretched across a parent too short for it there, or a set minimum
    // below it needs a content child to keep CSS's basis.
    const wraps = (k === LABEL || k === TEXT) && r.wrap;
    if (!wraps) {
      const text = k === EDIT ? '' : k === TEXT ? (item.text = runOf(item)) : caption(item);
      item.cw = k === EDIT ? 0 : widest(item, fonts, text);
      // Runs: their rows' line boxes.
      item.ch = k === EDIT ? height : text.length === 0 ? 0 : item.spans !== null ? high(item, rowsOf(item, fonts, text, -1).length) : (text.indexOf('\n') < 0 ? 1 : text.split('\n').length) * height;
      const across = r.pl + r.pr + r.bL + r.bR;
      const along = r.pt + r.pb + r.bT + r.bB;
      // A percentage (of the parent) needs the engine's own minimum: a content child.
      const known = typeof r.width === 'number' && typeof r.height === 'number' && typeof r.minW === 'number' && typeof r.minH === 'number';
      if (known && !kept && !item.ellipsis && !(k === EDIT && item.lines > 1 && item.autosize > 0) && !(/** @type {number} */ (r.minW) < item.cw + across) && !(/** @type {number} */ (r.minH) < item.ch + along)) {
        item.direct = true;
        return 0;
      }
    }
    /** @type {() => any} */
    let props;
    let key;
    // Wrapping text's widest and least widths (-1: it does not wrap).
    let wide = -1;
    let least = -1;
    if (k === EDIT) {
      // An Edit that grows is as high as its value's rows at the width it last got (`wraps` brings that up to date; before, its paragraphs).
      const rows = item.lines > 1 && item.autosize > 0 ? Math.max(1, Lines(measureOf(item, fonts), item.draft, item.wrapAt >= 0 ? Math.max(1, item.wrapAt) : Infinity).length) : 1;
      key = `e|${rows * height}`;
      props = () => box({ width: 0, height: rows * height, shrink: 0 });
    } else {
      const text = k === TEXT ? (item.text = runOf(item)) : caption(item);
      const most = widest(item, fonts, text);
      if (k === LABEL || k === TEXT ? r.wrap : false) {
        least = longest(item, fonts, text);
        wide = most;
        const room = item.wrapAt >= 0 ? item.wrapAt : most;
        const count = text.length === 0 ? 0 : rowsOf(item, fonts, text, room).length;
        const rows = item.clamp > 0 ? Math.min(count, item.clamp) : count;
        const tall = text.length === 0 ? 0 : high(item, rows);
        // A wrapping row of pieces: as wide as the text at most (its
        // max-content), its longest word at least (its min-content).
        key = `w|${least}|${tall}`;
        props = () => box({ direction: 'row', wrap: true, minWidth: least, height: tall, align: 'start' });
      } else {
        const tall = text.length === 0 ? 0 : item.spans !== null ? high(item, rowsOf(item, fonts, text, -1).length) : text.split('\n').length * height;
        key = `t|${most}|${tall}`;
        props = () => box({ width: most, height: tall, shrink: 0 });
      }
    }
    let node = item.inner;
    if (node === 0 || item.tree !== this) {
      node = this.make(CONTENT);
      item.inner = node;
      item.innerKey = '';
      item.pieces = [];
      item.piecesKey = '';
    }
    if (key !== item.innerKey) {
      this.shape(node, key, props);
      item.innerKey = key;
    }
    this.cut(item, node, wide < 0 ? [] : piecesOf(wide, least));
    return node;
  }

  /**
   * Gives a content child its pieces (wrapping text's), as nodes of those
   * widths and no height, made and dropped as their count changes.
   * @param {Item} item @param {number} node @param {number[]} widths
   */
  cut(item, node, widths) {
    const key = widths.join(',');
    if (key === item.piecesKey) return;
    const list = item.pieces;
    while (list.length > widths.length) this.unmake(/** @type {number} */ (list.pop()));
    while (list.length < widths.length) list.push(this.make(CONTENT));
    for (let i = 0; i < widths.length; i++) {
      const w = widths[i];
      this.shape(list[i], `p|${w}`, () => box({ width: w, height: 0, shrink: 0 }));
    }
    this.children(node, list);
    item.piecesKey = key;
  }

  /** An item's laid-out width. @param {Item} item */
  width(item) {
    const read = this.engine.read;
    return read === undefined ? item.w : read.call(this.engine, item.node)[2];
  }

  /**
   * Brings wrapping text up to date with the widths it got: its rows at its
   * content width, and its content child's height from them. Returns
   * whether any height changed (the page is laid out again).
   */
  wraps() {
    let changed = false;
    for (const item of this.wrapping) {
      if (item.node === 0 || item.tree !== this || item.parent === null) {
        this.wrapping.delete(item);
        continue;
      }
      const r = item.r;
      const room = Math.max(0, this.width(item) - r.pl - r.pr - r.bL - r.bR);
      if (room === item.wrapAt) continue;
      item.wrapAt = room;
      const before = item.innerKey;
      this.content(item);
      if (item.innerKey !== before) changed = true;
    }
    if (this.reaching.size > 0 && this.reach()) changed = true;
    if (this.fitting.size > 0 && this.fits()) changed = true;
    return changed;
  }

  /**
   * Fits the boxes sized to fit their content to the room they have, as
   * CSS's fit-content: Taffy lays some out at their max-content, past the
   * room they have (a grid with flexible columns, a row that does not wrap,
   * a box holding one, wherever nothing stretches it), and an absolute box
   * in its whole containing block, not in the room its insets leave it. A
   * box found wider than its room after a layout is as wide as that room
   * (its min-content when that is more: `least`) from the next layout, as
   * CSS makes a box whose max-content is more; it follows the room, up to
   * that max-content (`most`), and is laid out at its max-content again
   * when its content changes (`sync`). Returns whether one changed.
   */
  fits() {
    let changed = false;
    for (const item of this.fitting) {
      if (item.node === 0 || item.tree !== this || item.parent === null || !item.fit) {
        this.fitting.delete(item);
        continue;
      }
      this.fix(item);
      const room = this.roomOf(item);
      if (item.fitW === Infinity && !(item.w > room + SLACK)) continue;
      const least = room === Infinity ? -1 : this.least(item);
      let width = least < 0 ? Infinity : Math.max(room, least);
      if (item.fitW === Infinity) {
        if (item.w <= width + SLACK) continue;
        // Its max-content, as the engine laid it out.
        item.most = item.w;
      } else if (width > item.most) width = item.most;
      if (width === item.fitW || Math.abs(width - item.fitW) <= SLACK) continue;
      item.fitW = width;
      touch(item);
      changed = true;
    }
    return changed;
  }

  /**
   * An item's min-content width (its border box) as CSS finds it, from
   * what is known here: a set width, a grid's tracks' minimums, a flex
   * container's items' (summed along a row that does not wrap, its gaps
   * with them; the widest otherwise), text's longest word when it wraps
   * and its whole width when not, clamped by its minimum and maximum. -1
   * where it is not known here (a percentage, a grid's track sized by its
   * content, clipped text).
   * @param {Item} item
   * @returns {number}
   */
  least(item) {
    const r = item.r;
    const k = item.kind;
    if (typeof r.width !== 'number' || typeof r.minW !== 'number' || typeof r.maxW !== 'number') return -1;
    let w = r.width;
    if (w !== w) {
      const inset = r.pl + r.pr + r.bL + r.bR;
      if (holds(item)) {
        if (r.grid) w = item.floor < 0 ? -1 : item.floor + inset;
        else {
          const inner = this.leastIn(item, r.row && !r.wrap);
          w = inner < 0 ? -1 : inner + inset + (k === SCROLL && item.axis !== 1 ? r.bar : 0);
        }
      } else if (k === LABEL || k === TEXT) {
        if (item.ellipsis || item.clamp > 0) return -1;
        const text = k === TEXT ? runOf(item) : caption(item);
        w = (r.wrap ? longest(item, this.fonts, text) : widest(item, this.fonts, text)) + inset;
      } else if (k === ACTION) w = widest(item, this.fonts, caption(item)) + inset;
      else if (k === EDIT) w = inset;
      if (w < 0) return -1;
    }
    if (r.maxW < w) w = r.maxW;
    if (r.minW > w) w = r.minW;
    return w;
  }

  /**
   * The min-content width of a flex container's content: its items' (a
   * box's with no box of its own, its children's), with their margins,
   * summed with the gaps between (`sum`: a row that does not wrap) or the
   * widest; -1 where one is not known.
   * @param {Item} item @param {boolean} sum
   */
  leastIn(item, sum) {
    const gap = item.r.colGap;
    if (sum && typeof gap !== 'number') return -1;
    const items = this.flowOf(item, []);
    if (items === null) return -1;
    let total = 0;
    for (const m of items) total = sum ? total + m : Math.max(total, m);
    return sum ? total + /** @type {number} */ (gap) * Math.max(0, items.length - 1) : total;
  }

  /**
   * The min-content widths of a container's items in its flow, margins
   * included, into `out` (a child with no box gives its children's); null
   * where one is not known.
   * @param {Item} item @param {number[]} out
   * @returns {number[] | null}
   */
  flowOf(item, out) {
    for (let ch = item.first; ch !== null; ch = ch.next) {
      if (ch.kind === MARKER || absent(ch) || ch.r.abs || ch.r.fixed) continue;
      if (ch.flat) {
        if (this.flowOf(ch, out) === null) return null;
        continue;
      }
      const m = this.least(ch);
      const ml = ch.r.ml;
      const mr = ch.r.mr;
      if (m < 0 || typeof ml !== 'number' || typeof mr !== 'number') return null;
      out.push(m + ml + mr);
    }
    return out;
  }

  /**
   * The width an item's parent gives it, its margins out, as CSS lays the
   * parent out (not as wide as the content that overflows it): a column's
   * content width, a row's less its other items and gaps; an absolute
   * box's, its containing block's padding box less its insets (its start at
   * the static position when neither is set). Infinity where that is not
   * known here: in a grid's track, or below a fixed box.
   * @param {Item} item
   * @returns {number}
   */
  roomOf(item) {
    let host = item.parent;
    while (host !== null && host.flat) host = host.parent;
    if (host === null || host.r.grid) return Infinity;
    const inner = this.innerOf(host);
    if (inner === Infinity) return Infinity;
    const hr = host.r;
    const r = item.r;
    if (typeof r.ml !== 'number' || typeof r.mr !== 'number') return Infinity;
    let room = inner - r.ml - r.mr;
    if (r.abs) {
      const block = inner + hr.pl + hr.pr;
      /** @param {number | string} v */
      const at = v => (typeof v === 'string' ? (parseFloat(v) / 100) * block : v);
      const left = r.left === r.left ? at(r.left) : r.right === r.right ? 0 : hr.pl;
      const right = r.right === r.right ? at(r.right) : 0;
      return Math.max(0, block - left - right - r.ml - r.mr);
    }
    if (hr.row && !hr.wrap) {
      // The other items of the row take theirs (its flat children's run in it too, so only a plain row).
      if (item.parent !== host) return Infinity;
      let n = 0;
      for (let ch = host.first; ch !== null; ch = ch.next) {
        if (ch.kind === MARKER || absent(ch) || ch.r.abs || ch.r.fixed || ch.r.contents || (ch.kind === TEXT && follows(ch))) continue;
        n++;
        if (ch === item) continue;
        this.fix(ch);
        room -= ch.w + /** @type {number} */ (ch.r.ml) + /** @type {number} */ (ch.r.mr);
      }
      room -= /** @type {number} */ (typeof hr.colGap === 'number' ? hr.colGap : 0) * Math.max(0, n - 1);
    }
    return Math.max(0, room);
  }

  /**
   * The content width a box lays its children out in, as CSS sizes it: its
   * own width when set (a page's, the viewport's), else no wider than its
   * parent gives it (`roomOf`) nor less than its minimum; Infinity below a
   * fixed box.
   * @param {Item} item
   * @returns {number}
   */
  innerOf(item) {
    this.fix(item);
    const r = item.r;
    let w = item.w;
    if (item.parent !== null && !(typeof r.width === 'number' && r.width === r.width)) {
      if (r.fixed) return Infinity;
      const outer = this.roomOf(item);
      if (outer !== Infinity) w = Math.min(w, outer);
      if (typeof r.minW === 'number' && r.minW === r.minW) w = Math.max(w, r.minW);
    }
    const scroll = item.kind === SCROLL && item.axis !== 1 ? r.bar : 0;
    return w - r.pl - r.pr - r.bL - r.bR - scroll;
  }

  /**
   * Finds the direct leaves stretched across a container too short for
   * their content there (a long Label in a narrow column, a line in a row
   * less high): their content as their minimum held them longer than CSS
   * does, so they keep their content as a child from now on (the next
   * layout). Returns whether one did.
   */
  reach() {
    let changed = false;
    for (const item of this.reaching) {
      if (item.node === 0 || item.tree !== this || item.reach <= 0) {
        this.reaching.delete(item);
        continue;
      }
      // With no box, its children are laid out in its nearest ancestor's.
      let host = item;
      while (host.flat && host.parent !== null) host = host.parent;
      const r = host.r;
      const row = item.r.row;
      // Its box as drawn: read once for this layout, so painting reads it no more.
      this.fix(host);
      const scroll = host.kind === SCROLL && host.axis !== (row ? 0 : 1) ? r.bar : 0;
      const room = row ? host.h - r.pt - r.pb - r.bT - r.bB - scroll : host.w - r.pl - r.pr - r.bL - r.bR - scroll;
      if (item.reach <= room + SLACK) continue;
      for (let ch = item.first; ch !== null; ch = ch.next) {
        if (!ch.direct || !ch.stretch || ch.over || absent(ch) || crossOf(ch, row) <= room + SLACK) continue;
        ch.over = true;
        touch(ch);
        changed = true;
      }
    }
    return changed;
  }


  /**
   * Brings an item's box up to date with the last layout, when it has not
   * yet: in this thread its place in its parent, its size and a Scroll's
   * content height are read from the engine; a Label's rows follow its width.
   * @param {Item} item
   */
  fix(item) {
    if (item.gen === this.gen || item.node === 0) return;
    item.gen = this.gen;
    const read = this.engine.read;
    if (read !== undefined) {
      const box = read.call(this.engine, item.node);
      item.x = held(box[0]);
      item.y = held(box[1]);
      item.w = held(box[2]);
      item.h = held(box[3]);
      item.content = held(box[4]);
      item.contentW = held(box[5]);
    }
    // No box: at its parent's corner, empty (its node is out of the tree).
    if (item.flat) item.x = item.y = item.w = item.h = item.content = item.contentW = 0;
    const k = item.kind;
    if (k === LABEL || k === TEXT || k === ACTION) {
      item.text = k === TEXT ? runOf(item) : caption(item);
      if (k !== ACTION) {
        const r = item.r;
        const room = Math.max(0, item.w - r.pl - r.pr - r.bL - r.bR);
        rowsOf(item, this.fonts, item.text, r.wrap ? room : -1, item.clamp > 0 || item.ellipsis ? room : -1);
      }
    }
    if (k === SCROLL) {
      item.offset = Math.min(item.offset, Math.max(0, item.content - item.clientHeight));
      item.offsetX = Math.min(item.offsetX, Math.max(0, item.contentW - item.clientWidth));
    }
  }

  /** An item left the scene: its nodes go at the next layout unless it comes back. @param {Item} item */
  drop(item) {
    if (item.node !== 0) this.dropped.push(item);
  }

  /** Frees the nodes of dropped items that did not come back. */
  free() {
    const dropped = this.dropped;
    if (dropped.length === 0) return;
    this.dropped = [];
    for (const item of dropped) if (item.parent === null) this.release(item);
  }

  /** @param {Item} item */
  release(item) {
    for (let ch = item.first; ch !== null; ch = ch.next) this.release(ch);
    if (item.tree === this) {
      if (item.node !== 0) this.unmake(item.node);
      if (item.inner !== 0) this.unmake(item.inner);
      for (const piece of item.pieces) this.unmake(piece);
    }
    this.wrapping.delete(item);
    this.reaching.delete(item);
    this.fitting.delete(item);
    item.node = 0;
    item.inner = 0;
    item.pieces = [];
    item.piecesKey = '';
    item.tree = null;
  }

  close() {
    this.engine.close();
  }
}
