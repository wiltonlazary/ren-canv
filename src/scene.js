// The retained scene of a canvas document: host nodes as fixed-shape records
// linked as a tree (parent, first/last child, prev/next sibling). Properties
// of the portable ren-core vocabulary are record fields; a change marks the node
// and its ancestors for layout, or only damages the frame when it is visual.
// An item's portable style (ren-core's `styled`) and its shorthand props
// resolve, at layout, into `r`: the concrete box, paint and text it is drawn
// with (layout.js).

import { Style, styled, argb, development, diagnose } from 'ren-core/host';
import { cased } from './text.js';
import { direction } from './bidi.js';

/** Integer kinds of scene items. */
export const VIEW = 0;
export const LAYOUT = 1;
export const SCROLL = 2;
export const LABEL = 3;
export const EDIT = 4;
export const ACTION = 5;
export const IMAGE = 6;
export const SHAPE = 7;
export const TEXT = 8;
export const MARKER = 9;

/** The ren-core primitive tags and their kinds. */
const KINDS = /** @type {Record<string, number>} */ ({
  View: VIEW,
  Layout: LAYOUT,
  Scroll: SCROLL,
  Label: LABEL,
  Edit: EDIT,
  Action: ACTION,
  Image: IMAGE,
  Shape: SHAPE,
});

/** The kind of a primitive tag, or -1. @param {string} tag */
export function kindOf(tag) {
  const kind = KINDS[tag];
  return kind === undefined ? -1 : kind;
}

/** A length that may be a percentage of `size`. @param {number | string} v @param {number} size */
export const part = (v, size) => (typeof v === 'string' ? (parseFloat(v) / 100) * size : v);

/** `a` after `b`: the transform applying `b`, then `a`. @param {Float64Array} a @param {Float64Array} b */
export function compose(a, b) {
  return Float64Array.of(a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]);
}

/**
 * An item's transform (`scale`, `rotate`, `translate` about its
 * `transformOrigin`, as CSS's translate, rotate and scale, then its skews,
 * as CSS's `transform: skew()` after them) for its border box at `x`,
 * `top`, `w` × `h`: a, b, c, d, e, f as a canvas's transform().
 * @param {Resolved} r @param {number} x @param {number} top @param {number} w @param {number} h
 */
export function transformOf(r, x, top, w, h) {
  const ox = x + part(r.ox, w);
  const oy = top + part(r.oy, h);
  const turn = (r.rot * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const m = new Float64Array(6);
  // Rotate and scale, then the skew [1, tan y; tan x, 1] (CSS's skew(x, y)).
  const a = r.sx * cos;
  const b = r.sx * sin;
  const c = 0 - r.sy * sin;
  const d = r.sy * cos;
  const kx = r.kx === 0 ? 0 : Math.tan((r.kx * Math.PI) / 180);
  const ky = r.ky === 0 ? 0 : Math.tan((r.ky * Math.PI) / 180);
  m[0] = a + c * ky;
  m[1] = b + d * ky;
  m[2] = a * kx + c;
  m[3] = b * kx + d;
  m[4] = ox + part(r.tx, w) - (m[0] * ox + m[2] * oy);
  m[5] = oy + part(r.ty, h) - (m[1] * ox + m[3] * oy);
  return m;
}

/** A fixed or sticky item's place, reused (`pinAt`, `stickAt`). */
export const PLACE = new Float64Array(2);

/** A sticky item's containing block, reused (`holdOf`). */
const HOLD = new Float64Array(4);

/**
 * Where a fixed item's border box goes, into PLACE: placed by its insets
 * (and margins) against a viewport `width` × `height`, as CSS's; along an
 * axis without an inset, where the flow put it (`x0`, `y0`).
 * @param {Item} item @param {number} width @param {number} height @param {number} x0 @param {number} y0
 */
export function pinAt(item, width, height, x0, y0) {
  const r = item.r;
  PLACE[0] = r.left === r.left ? part(r.left, width) + r.ml : r.right === r.right ? width - part(r.right, width) - r.mr - item.w : x0;
  PLACE[1] = r.top === r.top ? part(r.top, height) + r.mt : r.bottom === r.bottom ? height - part(r.bottom, height) - r.mb - item.h : y0;
}

/**
 * Where a sticky item's border box goes, into PLACE: where the flow put it
 * (`x0`, `y0`), moved as little as keeps it its insets (px, or percentages
 * of the scrollport) inside the scrollport `port`, and its margin box
 * inside its containing block `hold`, as CSS's sticky. Where both insets
 * of an axis cannot hold, its start's wins: `left` (`right` right to
 * left) and `top`.
 * @param {Item} item @param {number} x0 @param {number} y0
 * @param {ArrayLike<number>} port the nearest Scroll's padding box less its padding and bars (the viewport without one): left, top, right, bottom
 * @param {ArrayLike<number>} hold its containing block's content box (a Scroll's, as far as its content reaches): left, top, right, bottom
 */
export function stickAt(item, x0, y0, port, hold) {
  const r = item.r;
  const width = port[2] - port[0];
  const height = port[3] - port[1];
  let x = x0;
  let y = y0;
  // The start's inset last: it wins.
  if (r.dir === 1 && r.left === r.left) x = Math.max(x, Math.min(port[0] + part(r.left, width), hold[2] - item.w - r.mr));
  if (r.right === r.right) x = Math.min(x, Math.max(port[2] - part(r.right, width) - item.w, hold[0] + r.ml));
  if (r.dir !== 1 && r.left === r.left) x = Math.max(x, Math.min(port[0] + part(r.left, width), hold[2] - item.w - r.mr));
  if (r.bottom === r.bottom) y = Math.min(y, Math.max(port[3] - part(r.bottom, height) - item.h, hold[1] + r.mt));
  if (r.top === r.top) y = Math.max(y, Math.min(port[1] + part(r.top, height), hold[3] - item.h - r.mb));
  PLACE[0] = x;
  PLACE[1] = y;
}

/**
 * A Scroll's scrollport as sticky items in it are held in, into `out`
 * (left, top, right, bottom): its padding box at `x`, `y`, less its
 * padding and its bars (the bar down on its left right to left).
 * @param {Item} item @param {number} x @param {number} y @param {number[] | Float64Array} out
 */
export function portOf(item, x, y, out) {
  const r = item.r;
  const barX = item.axis !== 1 ? r.bar : 0;
  const barY = item.axis !== 0 ? r.bar : 0;
  const back = r.dir === 1;
  out[0] = x + r.bL + (back ? barX : 0) + r.pl;
  out[1] = y + r.bT + r.pt;
  out[2] = x + item.w - r.bR - (back ? 0 : barX) - r.pr;
  out[3] = y + item.h - r.bB - barY - r.pb;
}

/**
 * The box a sticky child of `box` is held within, into `out` (left, top,
 * right, bottom): its content box with `box` at `x`, `y`; a Scroll's
 * from its content's origin `cx`, `cy` (its scroll applied), inside its
 * border as far as its content reaches (to its left right to left).
 * @param {Item} box @param {number} x @param {number} y @param {number} cx @param {number} cy @param {number[] | Float64Array} out
 */
export function holdOf(box, x, y, cx, cy, out) {
  const r = box.r;
  if (box.kind === SCROLL) {
    const wide = Math.max(box.w, box.contentW);
    out[0] = r.dir === 1 ? cx + box.w - wide + r.bL : cx + r.bL;
    out[1] = cy + r.bT;
    out[2] = r.dir === 1 ? cx + box.w - r.bR : cx + wide - r.bR;
    out[3] = cy + Math.max(box.h, box.content) - r.bB;
  } else {
    out[0] = x + r.bL + r.pl;
    out[1] = y + r.bT + r.pt;
    out[2] = x + box.w - r.bR - r.pr;
    out[3] = y + box.h - r.bB - r.pb;
  }
}

/**
 * One portable shape of a Shape item, in the item's own coordinates.
 * @typedef {object} Figure
 * @property {'line' | 'rect' | 'round' | 'oval' | 'path'} kind
 * @property {number=} x
 * @property {number=} y
 * @property {number=} right
 * @property {number=} bottom
 * @property {number=} color ARGB
 * @property {unknown=} fill A filled figure's color or gradient (as a background takes one), over its bounds, in place of `color`.
 * @property {number=} stroke A line's thickness (1 by default); for another figure, a stroke width (0 fills).
 * @property {number=} radius A corner radius.
 * @property {ArrayLike<number>=} points x, y pairs of a path.
 * @property {boolean=} closed Closes a path.
 * @property {readonly number[]=} dash Dashes its stroke: lengths on and off, as SVG's stroke-dasharray.
 */

/**
 * An event handler registered by `listen`.
 * @typedef {object} Listener
 * @property {string} name
 * @property {(event: any) => void} fn
 */

/** Interaction states a style may style (bits of `Item.state`). */
export const HOVER = 1;
export const PRESS = 2;
export const FOCUS = 4;

/** The style of an item without one. */
const PLAIN = new Style();

/**
 * An item's resolved style: every value concrete, from the theme's defaults
 * for its kind, its parent's inherited text, its shorthand props, its style
 * and the style of its current states. Enumerations are as in ren-core's
 * Style. Lengths are logical pixels; colors ARGB, -1 for none.
 */
export class Resolved {
  constructor() {
    this.row = false;
    /** Children in lines (containers); words in lines (text). */
    this.wrap = false;
    /** A grid container, not a flex one. */
    this.grid = false;
    /** The gaps between columns and between rows. */
    this.colGap = 0;
    this.rowGap = 0;
    /** Grid tracks and lines, CSS syntax (null: none). @type {string | null} */
    this.columns = null;
    /** @type {string | null} */
    this.rows = null;
    /** @type {string | null} */
    this.column = null;
    /** @type {string | null} */
    this.rowLine = null;
    this.pt = 0;
    this.pr = 0;
    this.pb = 0;
    this.pl = 0;
    this.mt = 0;
    this.mr = 0;
    this.mb = 0;
    this.ml = 0;
    /** Each side's border width, and the widest (0: no border). */
    this.bT = 0;
    this.bR = 0;
    this.bB = 0;
    this.bL = 0;
    this.bw = 0;
    /** The set size, or NaN (from the content); a string is a percentage ('50%'), as the sizes and insets below. @type {number | string} */
    this.width = NaN;
    /** @type {number | string} */
    this.height = NaN;
    /** NaN: CSS's automatic minimum. @type {number | string} */
    this.minW = NaN;
    /** @type {number | string} */
    this.maxW = Infinity;
    /** @type {number | string} */
    this.minH = NaN;
    /** @type {number | string} */
    this.maxH = Infinity;
    /** Width over height (NaN: none). */
    this.ratio = NaN;
    /** Fixed: out of the flow, placed by its insets against the viewport as it paints. */
    this.fixed = false;
    /** Sticky: in the flow, held in its scrollport by its top and left insets as it paints. */
    this.sticky = false;
    /** Out of the flow, placed by its insets in its parent's padding box. */
    this.abs = false;
    /** The insets, NaN: auto. @type {number | string} */
    this.top = NaN;
    /** @type {number | string} */
    this.right = NaN;
    /** @type {number | string} */
    this.bottom = NaN;
    /** @type {number | string} */
    this.left = NaN;
    /** The stacking order: an integer, or NaN (auto: no stacking context of its own, unless its opacity is below 1). */
    this.z = NaN;
    this.grow = 0;
    this.shrink = 1;
    /** align-items; self is -1 when the container decides. */
    this.align = 3;
    this.self = -1;
    /** justify-content; -1 is CSS's normal (the start in a flex row, auto grid tracks stretched). */
    this.justify = -1;
    this.clip = false;
    this.bg = -1;
    /** A gradient background (ren-core's Gradient: radial, angle, stops), in place of `bg`. @type {{ radial: boolean, angle: number, stops: number[] } | null} */
    this.grad = null;
    this.fg = 0;
    this.opacity = 1;
    /** Each side's border color (-1: none); `bc` is the top's. */
    this.bc = -1;
    this.cR = -1;
    this.cB = -1;
    this.cL = -1;
    /** The border style: 0 solid, 1 dashed, 2 dotted. */
    this.bs = 0;
    /** The largest corner radius, and each corner's: top-left, top-right, bottom-right, bottom-left. */
    this.radius = 0;
    this.rtl = 0;
    this.rtr = 0;
    this.rbr = 0;
    this.rbl = 0;
    this.shX = 0;
    this.shY = 0;
    this.shBlur = 0;
    this.shColor = -1;
    /** Its focus ring: 0 handed on, 1 its own, 2 an inner item's, 3 the focused item's around it; -1 its own. */
    this.ring = -1;
    this.size = 17;
    this.bold = false;
    this.italic = false;
    /** Set in the monospace face (its family names monospace; inherited). */
    this.mono = false;
    /** The slot of the typeface its family names (Fonts.typeface; 0: the root face; inherited). */
    this.family = 0;
    /** The face text is set in: BOLD | ITALIC | MONO and the family's slot (text.js). */
    this.face = 0;
    /** The text's alignment as its style gives it (inherited): 0 start, 1 center, 2 end. */
    this.alignText = 0;
    /** Where its rows align, by its direction: 0 left, 1 center, 2 right. */
    this.textAlign = 0;
    /** Its direction (HTML's dir, resolved): 0 left to right, 1 right to left; inherited. */
    this.dir = 0;
    /** The line height, as a multiple of the size. */
    this.leading = 1.4;
    this.underline = false;
    /** A line through the text (inherited, as a decoration). */
    this.strike = false;
    this.select = true;
    /** An Image's fit: 0 fill, 1 contain, 2 cover, 3 none (object-fit). */
    this.fit = 0;
    /** A target of the pointer (pointerEvents, inherited): false lets it through to what is under it. */
    this.events = true;
    /** In an inert region (its own `inert` or an ancestor's): no pointer, no selection, no focus; its children cannot take them back. */
    this.inert = false;
    /** A Scroll's bars' width (its scrollbarWidth: the theme's bar, half of it thin, 0 none); 0 for any other kind. */
    this.bar = 0;
    /** Its bars' thumb and track colors (scrollbarColor, inherited); -1 unset. */
    this.thumb = -1;
    this.track = -1;
    /** Its text's case (textTransform): 0 as given, 1 upper, 2 lower, 3 capitalized; inherited, but an Action and an Edit take their own. */
    this.case = 0;
    /** The pans and zoom a touch pressed on it leaves to the browser (touchAction, its own): bits 1 pan-x, 2 pan-y, 4 pinch-zoom; -1 unset. */
    this.touch = -1;
    /** No box (display: 'contents', a container's): its children lay out as its parent's; it paints and hits nothing of its own. */
    this.contents = false;
    /** A transform (painted and hit, not laid out): whether there is one, the scale per axis, the rotation and skews in degrees, the move and the origin (px, or percent strings of its own size). */
    this.tf = false;
    this.sx = 1;
    this.sy = 1;
    this.rot = 0;
    /** The skews in degrees, along x and along y (CSS's skew(), after the scale). */
    this.kx = 0;
    this.ky = 0;
    /** @type {number | string} */
    this.tx = 0;
    /** @type {number | string} */
    this.ty = 0;
    /** @type {number | string} */
    this.ox = '50%';
    /** @type {number | string} */
    this.oy = '50%';
    /** The color of an Edit's placeholder (inherited). */
    this.ph = 0;
  }
}

/**
 * A run of a Label's or an Edit's text in a style of its own (ren-core's `runs`): where
 * it lies in the joined text, its style normalized once, its press, and
 * what it is drawn with once its Label resolves (the run's style over the
 * Label's inherited text).
 */
export class Span {
  /** @param {number} start @param {number} end @param {Style} style @param {((event: any) => void) | null} press */
  constructor(start, end, style, press) {
    this.start = start;
    this.end = end;
    this.style = style;
    this.press = press;
    /** Resolved: its text color, its background (-1: none), size, face (BOLD | ITALIC | MONO) and decorations. */
    this.fg = 0;
    this.bg = -1;
    this.size = 17;
    this.face = 0;
    this.underline = false;
    this.strike = false;
  }
}

/**
 * A Label's runs (ren-core's `{ text, style, onPress }`) as spans over
 * their joined text, into `item.spans` and `item.joined`; none (null or
 * not a list) clears them.
 * @param {Item} item @param {unknown} value
 */
function spansOf(item, value) {
  item.spanGen++;
  if (!Array.isArray(value)) {
    item.spans = null;
    item.joined = '';
    return;
  }
  /** @type {Span[]} */
  const spans = [];
  let text = '';
  for (const run of value) {
    if (run == null) continue;
    const part = run.text == null ? '' : String(run.text);
    const style = run.style == null ? PLAIN : run.style instanceof Style ? run.style : styled(run.style);
    spans.push(new Span(text.length, text.length + part.length, style, typeof run.onPress === 'function' ? run.onPress : null));
    text += part;
  }
  item.spans = spans;
  item.joined = text;
}

/** The roles ARIA names by their content when nothing else names them. */
const CONTENT_NAMED = new Set(['button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem']);
/** White space as an accessible name collapses it: spaces, tabs and line breaks. */
const SPACES = /[ \t\n\r\f]+/g;
const ENDS = /^ | $/g;

/**
 * The text an item holds, as a DOM element's text content: its runs', its
 * `text`, else its shown children's text, a space between elements.
 * @param {Item} item
 * @returns {string}
 */
export function spoken(item) {
  if (item.spans !== null) return item.joined;
  if (item.caption !== null) return item.caption;
  let text = '';
  for (let c = item.first; c !== null; c = c.next) {
    if (c.kind === TEXT) text += c.own;
    else if (c.kind !== MARKER && !c.hidden) {
      const part = spoken(c);
      if (part !== '') text += text === '' || text.endsWith(' ') ? part : ` ${part}`;
    }
  }
  return text;
}

/**
 * The direction of the first strong character of an item's text, as
 * HTML's `dir="auto"` finds it: an Edit's value, a Label's or an
 * Action's text, else its children's text in order, past those with a
 * `dir` of their own and Edits (a field's value is no text of its
 * parent's); 0 left to right, 1 right to left, -1 none.
 * @param {Item} item
 * @returns {-1 | 0 | 1}
 */
export function strongOf(item) {
  if (item.kind === EDIT) return direction(item.draft);
  if (item.kind === TEXT) return direction(item.own);
  if (item.spans !== null) return direction(item.joined);
  if (item.caption !== null) return direction(item.caption);
  for (let c = item.first; c !== null; c = c.next) {
    if (c.kind === MARKER || c.kind === EDIT || c.dir >= 0) continue;
    const found = strongOf(c);
    if (found >= 0) return found;
  }
  return -1;
}

/** The text of a Label or Action: its runs' joined, its `text`, or its text children's. @param {Item} item */
export function caption(item) {
  const mode = item.r.case;
  if (item.spans !== null) return cased(item.joined, mode);
  if (item.caption !== null) return cased(item.caption, mode);
  let text = '';
  for (let c = item.first; c !== null; c = c.next) if (c.kind === TEXT) text += c.own;
  return cased(text, mode);
}

/** What a secret Edit shows for each UTF-16 unit of its value, so offsets in the value and in the drawn text agree. */
export const BULLET = '\u2022';

/** The text an Edit draws and measures: its draft, or bullets for a secret one-line Edit. @param {Item} item */
export function shown(item) {
  return item.secret && item.lines <= 1 ? BULLET.repeat(item.draft.length) : item.draft;
}

/**
 * An Edit's runs while they style what it shows: their joined text is its
 * value (a draft the view has not answered yet, or a secret's bullets, shows
 * plain), else null.
 * @param {Item} item
 */
export const edited = item => (item.spans !== null && !(item.secret && item.lines <= 1) && item.joined === item.draft ? item.spans : null);

/** True when the user may change an Edit's value. @param {Item} item */
export const editable = item => !item.readOnly && !item.disabled;

/**
 * A scroll offset as the DOM takes one: a number, and 0 for anything that
 * is not a finite one (NaN, a string that reads as none, Infinity).
 * @param {unknown} value
 */
export const finite = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** A scene node. Every field is set in the constructor, so all items share one shape. */
export class Item {
  /** @param {number} kind @param {string} text @param {number} [id] a number unique within its renderer (the renderer counts; nothing is shared between renderers) */
  constructor(kind, text, id = 0) {
    this.id = id;
    this.kind = kind;
    /** @type {Item | null} */
    this.parent = null;
    /** @type {Item | null} */
    this.first = null;
    /** @type {Item | null} */
    this.last = null;
    /** @type {Item | null} */
    this.prev = null;
    /** @type {Item | null} */
    this.next = null;
    /** The text of a text node; the drawn text of a Label or Action after layout (of a text node, its run's: layout.js `runOf`). */
    this.text = text;
    /** A text node's own text, as its host set it. */
    this.own = text;
    /** A text node laid out in the run of the text before it (layout.js `follows`), when it last synced. */
    this.followed = false;
    // Portable properties.
    /** The `label` prop as given (null: none); `label` reads the item's accessible name. @type {string | null} */
    this.given = null;
    /** @type {string | null} */
    this.caption = null;
    /** The shown value of an Edit: the last value set, or what the user typed since. */
    this.draft = '';
    // Shorthand props (the style overrides them): unset is -1, NaN or null.
    /** layout: 1 row, 0 column, -1 unset. */
    this.row = -1;
    this.gap = NaN;
    this.pad = NaN;
    /** @type {number | null} */
    this.fill = null;
    /** @type {number | null} */
    this.color = null;
    this.size = NaN;
    /** @type {number | null} */
    this.height = null;
    /** @type {number | null} */
    this.width = null;
    this.min = NaN;
    this.hidden = false;
    this.selected = false;
    /** True once `selected` was given (true or false): a toggle button. */
    this.toggle = false;
    /** 1 wraps, 0 does not, -1 unset. */
    this.wrap = -1;
    this.invalid = false;
    /** An Edit's rows (1: one line); read when it is made. */
    this.lines = 1;
    /** A multi-line Edit grows with its wrapped lines up to this many rows (Infinity: no limit); 0 does not. */
    this.autosize = 0;
    /** An Edit that takes no focus and no edits, dimmed. */
    this.disabled = false;
    /** An Edit that takes focus and selection, not edits. */
    this.readOnly = false;
    /** A password Edit: drawn as bullets, never copied. */
    this.secret = false;
    /** A Label's line clamp (0: none): at most this many wrapped lines, the last ending with an ellipsis. */
    this.clamp = 0;
    /** A Label on one line that ends with an ellipsis where it does not fit. */
    this.ellipsis = false;
    /** The selection an unfocused Edit takes when it gets focus (setSelectionRange): anchor and caret, -1 for none. */
    this.mark = -1;
    this.point = -1;
    this.choice = false;
    /** @type {string | null} */
    this.source = null;
    /** @type {readonly Figure[] | null} */
    this.shapes = null;
    /** Properties outside the portable vocabulary, such as renderer colors. @type {Map<string, any> | null} */
    this.other = null;
    /** A Label's runs (ren-core's `runs`), over `joined`, their text; null: none. @type {Span[] | null} */
    this.spans = null;
    this.joined = '';
    /** Counts the runs' changes (given, or resolved again), which its rows follow. */
    this.spanGen = 0;
    /** The portable style, normalized (ren-core's `styled`). */
    this.style = PLAIN;
    /** The interaction states it is in (HOVER, PRESS, FOCUS). */
    this.state = 0;
    /** The resolved style it is laid out and drawn with. */
    this.r = new Resolved();
    /** Its node's id in the layout tree (0: none yet), and the tree's layouts it last read. */
    this.node = 0;
    /** @type {any} */
    this.tree = null;
    this.gen = -1;
    /** The layout style it last gave its node. */
    this.boxKey = '';
    /** True when its children changed since its node's children were set. */
    this.kids = true;
    /** Laid out with no box (display contents, shown): its children's nodes are its parent's. */
    this.flat = false;
    /** True when its parent's node must list its children again (it went flat or back, or a flat one's children changed). */
    this.relist = false;
    /** True when a child of it may be drawn out of the flow's order (absolute, moved by insets, or a stacking context). */
    this.placed = false;
    /** True when a fixed item is below it: it is visited wherever it is, to find it. */
    this.pins = false;
    /** True when a negative stacking context below it (not inside another context) paints under its children. */
    this.sunk = false;
    /** A leaf's content child in the layout tree (0: none), its style's key, and whether it is set. */
    this.inner = 0;
    this.innerKey = '';
    this.hasInner = false;
    /** Wrapping text's pieces under its content child (their nodes) and their widths' key. @type {number[]} */
    this.pieces = [];
    this.piecesKey = '';
    /** The content width wrapping text last got (-1: none yet). */
    this.wrapAt = -1;
    /** A leaf whose content has one size, written on it as its minimum (no content child). */
    this.direct = false;
    /** How a container lays its children out (its align, direction and display) when they last synced: a change syncs them again. */
    this.lays = -1;
    /** A leaf stretched across its parent (its size and minimum there automatic), and one found too long for it there: it keeps a content child. */
    this.stretch = false;
    this.over = false;
    /** The longest a container's direct stretched leaves are across it (their content, margins included; 0: none). */
    this.reach = 0;
    /** A box sized to fit its content (`fits`): no width of its own, not stretched across a column, or absolute. */
    this.fit = false;
    /** A grid with flexible columns and no width of its own: its tracks' minimums across (-1: not one, or minimums its content sets). */
    this.floor = -1;
    /** Such a box's widest, the room it was found to have after a layout (`fits`; Infinity: none). */
    this.fitW = Infinity;
    /** A fitted box's width as laid out before it was fitted: its max-content, as far as the engine found it. */
    this.most = Infinity;
    /** Its content's width and height (content box). */
    this.cw = 0;
    this.ch = 0;
    /** The minimums and basis last sent for it when it is direct (NaN: auto, or none sent). */
    this.sw = NaN;
    this.sh = NaN;
    this.sb = NaN;
    // Layout, relative to the parent's content origin.
    this.x = 0;
    this.y = 0;
    this.w = 0;
    this.h = 0;
    /** The content height of a Scroll, and its width. */
    this.content = 0;
    this.contentW = 0;
    this.dirty = true;
    /** True when its style must resolve again (it, or what its parent passes down, changed). */
    this.stale = true;
    /** Wrapped lines of a Label. @type {string[] | null} */
    this.rows = null;
    /** Where each of `rows` starts in the text. @type {number[] | null} */
    this.starts = null;
    /**
     * With runs: how many characters of each row come from the text (fewer
     * than the row's length when it ends with an ellipsis, which takes the
     * run of the character before it), each row's top from the text's top
     * (one more: the bottom), and its baseline from its top. @type {number[] | null}
     */
    this.cuts = null;
    /**
     * Of each row cut with an ellipsis, where the characters it keeps are
     * not the row's first ones (the row laid out right to left, or of
     * mixed directions: it is cut where it is drawn), their offsets in the
     * row, ascending; null for a row cut after its first ones, or not cut.
     * @type {(Int32Array | null)[] | null}
     */
    this.kept = null;
    /**
     * Of each row cut with an ellipsis from a row with right-to-left text,
     * its levels as cut (bidi.js `line`): those its characters had in the
     * whole row, so what it keeps stays where the whole row put it, and
     * the ellipsis at the row's base level, at its end; null for another
     * row. @type {(Uint8Array | null)[] | null}
     */
    this.levels = null;
    /** @type {number[] | null} */
    this.tops = null;
    /** @type {number[] | null} */
    this.bases = null;
    /** What the rows were made from: the text, its room (-1: not wrapped) and size. */
    this.rowsOf = '';
    this.rowsRoom = -1;
    this.rowsSize = 0;
    this.rowsFace = 0;
    this.rowsGen = -1;
    /** The direction its rows were cut in. */
    this.rowsDir = 0;
    /** The width its rows were cut to with an ellipsis (-1: not cut). */
    this.rowsCut = -1;
    /** The selected range of its text, [from, to); from -1 when none is. */
    this.from = -1;
    this.to = -1;
    /** The scroll offset of a Scroll, down and across (from its start: its right, right to left). */
    this.offset = 0;
    this.offsetX = 0;
    /** A focus trap: Tab cycles among the focusables inside it while the focus is. */
    this.trap = false;
    /** Inert, as the DOM's `inert`: it and what it holds take no focus, pointer or selection, and the mirror leaves them out. */
    this.inert = false;
    /** Its `dir`, as HTML's: 0 ltr, 1 rtl, 2 auto (its text's first strong character), -1 unset (its parent's). */
    this.dir = -1;
    /** Its `tabIndex`, NaN unset: set, a View, Layout or Scroll is focusable; -1 keeps any item out of the Tab order, above 0 orders it first. */
    this.tabIndex = NaN;
    /** The axis a Scroll scrolls: 0 down (y), 1 across (x), 2 both. */
    this.axis = 0;
    /** @type {Listener[] | null} */
    this.events = null;
    /** The border box size its `resize` listeners last heard (-1: none yet). */
    this.sizeW = -1;
    this.sizeH = -1;
    /** True when a `press` handler makes this item a press target. */
    this.presses = false;
    /** True when a pointer handler (pointerdown, pointermove, pointerup, wheel) makes this item a pointer target. */
    this.pointers = false;
    /** The Document the item belongs to, for the DOM-like methods below (focus, scrollTop, pointer capture). @type {any} */
    this.owner = null;
    /** The element of this item in the accessibility mirror (aria.js), once mirrored. @type {any} */
    this.aria = null;
    /** True while the mirror has this item queued for its next write. */
    this.noted = false;
  }

  /** A renderer property outside the portable vocabulary. @param {string} name */
  get(name) {
    return this.other === null ? undefined : this.other.get(name);
  }

  /**
   * Its `label` prop, as given; unset (or empty) on an item named by its
   * content (an Action, or a role named so: radio, tab, option, ...), the
   * text it holds, white space collapsed, as the DOM's accessible name.
   * @returns {string | null}
   */
  get label() {
    const given = this.given;
    if (given !== null && given !== '') return given;
    const role = this.get('role');
    if (role == null ? this.kind !== ACTION : !CONTENT_NAMED.has(String(role))) return given;
    const text = spoken(this).replace(SPACES, ' ').replace(ENDS, '');
    return text === '' ? given : text;
  }

  set label(value) {
    this.given = value;
  }

  // The DOM's element methods, so a ref works the same on every renderer.

  /** Takes keyboard focus (an Edit or an Action), as an element's `focus()`. */
  focus() {
    if (this.owner !== null) this.owner.take(this);
  }

  /**
   * Focuses the first Edit or Action inside it (not hidden, not disabled),
   * in document order, as a focus trap opens (ren-core's `$focus`); returns
   * whether one took the focus.
   */
  focusFirst() {
    return this.owner !== null && this.owner.within(this, false);
  }

  /** Focuses the last Edit or Action inside it, as `focusFirst`. */
  focusLast() {
    return this.owner !== null && this.owner.within(this, true);
  }

  /** Gives focus up, as an element's `blur()`. */
  blur() {
    if (this.owner !== null && this.owner.current === this) this.owner.take(null);
  }

  /** A Scroll's scroll offset, as an element's; setting it scrolls (clamped) and sends `scroll`. */
  get scrollTop() {
    return this.offset;
  }

  set scrollTop(top) {
    if (this.owner !== null) this.owner.scrollTo(this, top);
    else this.offset = Math.max(0, finite(top));
  }

  /**
   * The offset in a Label's text nearest a point of the surface (the
   * pointer event's `x`, `y`), where it was last drawn; -1 when it was not
   * (or holds no selectable text). The DOM's counterpart is the document's
   * `caretPositionFromPoint`.
   * @param {number} x @param {number} y
   */
  offsetAt(x, y) {
    const owner = this.owner;
    if (owner === null) return -1;
    const texts = owner.painter.texts;
    for (let i = texts.n - 1; i >= 0; i--) {
      if (texts.items[i] !== this) continue;
      texts.local(i, x, y);
      return owner.offset(this, texts.px - texts.box[i * 6 + 4], texts.py - texts.box[i * 6 + 5]);
    }
    return -1;
  }

  /** Its Document, as an element's root node: its `activeElement` is the focused item. */
  getRootNode() {
    return this.owner;
  }

  /**
   * A Scroll's offset across, as an element's: from 0 at its start, below
   * 0 right to left (it scrolls from the right); setting it scrolls
   * (clamped) and sends `scroll`.
   */
  get scrollLeft() {
    return this.r.dir === 1 && this.offsetX !== 0 ? -this.offsetX : this.offsetX;
  }

  set scrollLeft(left) {
    // Given as is: undefined scrolls to 0 too, not to where it was.
    if (this.owner !== null) this.owner.scrollTo(this, this.offset, finite(left));
    else this.offsetX = Math.max(0, this.r.dir === 1 ? -finite(left) : finite(left));
  }

  /** The height of a Scroll's content, as an element's. */
  get scrollHeight() {
    return this.content;
  }

  /** The width of a Scroll's content, as an element's. */
  get scrollWidth() {
    return Math.max(this.contentW, this.clientWidth);
  }

  /** The width inside its border, as an element's. */
  get clientWidth() {
    return Math.max(0, this.w - this.r.bL - this.r.bR);
  }

  /** The height inside its border, as an element's. */
  get clientHeight() {
    return Math.max(0, this.h - this.r.bT - this.r.bB);
  }

  /**
   * Its border box as an element's `getBoundingClientRect()`: where it was
   * last laid out and is painted, in the Document's CSS pixels (its
   * canvas's; a panel's own), with the scroll of the Scrolls around it and
   * of the page applied, a sticky item held where it paints, a fixed one
   * placed against the viewport, and the bounds of its own and its
   * ancestors' transforms, as the DOM's. Zero until it is laid out; it does
   * not lay out.
   * @returns {{ x: number, y: number, left: number, top: number, right: number, bottom: number, width: number, height: number }}
   */
  getBoundingClientRect() {
    const owner = this.owner;
    const boxes = owner === null ? null : owner.boxes;
    /** @param {Item} n */
    const fix = n => {
      if (boxes !== null && n.tree === boxes) boxes.fix(n);
    };
    /** From the item up to its layer's child. @type {Item[]} */
    const chain = [];
    /** @type {Item} */
    let layer = this;
    while (layer.parent !== null) {
      chain.push(layer);
      layer = layer.parent;
    }
    fix(this);
    // The page and the overlay are at 0, 0; the page moved by its scroll.
    const page = owner !== null && layer === owner.root;
    let px = 0;
    let py = page ? -owner.page : 0;
    // The viewport fixed items are placed against: the page's stops at its scrollbar.
    const vw = owner === null ? 0 : page && owner.limit > 0 ? owner.width - owner.theme.bar : owner.width;
    const vh = owner === null ? 0 : owner.height;
    // The nearest Scroll's scrollport (a sticky item's), and the transform around.
    const port = [0, 0, vw, vh];
    /** @type {Float64Array | null} */
    let m = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const n = chain[i];
      const parent = /** @type {Item} */ (n.parent);
      fix(n);
      const r = n.r;
      let x = px + n.x;
      let y = py + n.y;
      let dx = 0;
      let dy = 0;
      if (parent.kind === SCROLL) {
        fix(parent);
        dx = Math.max(0, parent.offsetX);
        // Right to left, it scrolls from its right: its content moves right.
        if (parent.r.dir === 1) dx = -dx;
        dy = Math.max(0, parent.offset);
        x -= dx;
        y -= dy;
        portOf(parent, px, py, port);
      }
      if (r.fixed) {
        // Against the viewport, out of its ancestors' scrolls and transforms.
        pinAt(n, vw, vh, x, y);
        x = PLACE[0];
        y = PLACE[1];
        port[0] = port[1] = 0;
        port[2] = vw;
        port[3] = vh;
        m = null;
      } else if (r.sticky) {
        // Held in its scrollport, within its containing block's content box:
        // the nearest ancestor with a box (a boxless one, display contents,
        // sits at that one's corner, its scroll already in the point).
        let box = parent;
        while (box.flat && box.parent !== null) box = box.parent;
        const sx = box === parent ? dx : 0;
        const sy = box === parent ? dy : 0;
        holdOf(box, px, py, px - sx, py - sy, HOLD);
        stickAt(n, x, y, port, HOLD);
        x = PLACE[0];
        y = PLACE[1];
      }
      if (r.tf) {
        const t = transformOf(r, x, y, n.w, n.h);
        m = m === null ? t : compose(m, t);
      }
      px = x;
      py = y;
    }
    const width = this.w;
    const height = this.h;
    if (m === null) return { x: px, y: py, left: px, top: py, right: px + width, bottom: py + height, width, height };
    // The bounds of its box transformed.
    let l = Infinity;
    let t = Infinity;
    let rt = -Infinity;
    let b = -Infinity;
    for (let k = 0; k < 4; k++) {
      const cx = k & 1 ? px + width : px;
      const cy = k & 2 ? py + height : py;
      const tx = m[0] * cx + m[2] * cy + m[4];
      const ty = m[1] * cx + m[3] * cy + m[5];
      if (tx < l) l = tx;
      if (tx > rt) rt = tx;
      if (ty < t) t = ty;
      if (ty > b) b = ty;
    }
    return { x: l, y: t, left: l, top: t, right: rt, bottom: b, width: rt - l, height: b - t };
  }

  /** The selection of an Edit as [anchor, caret]: the Document's while it has focus, else the one it will take (its value's end by default). */
  ends() {
    const owner = this.owner;
    if (owner !== null && owner.current === this) return [owner.anchor, owner.caret];
    const length = this.draft.length;
    return this.point < 0 ? [length, length] : [Math.min(this.mark, length), Math.min(this.point, length)];
  }

  /**
   * The drawn row an Edit's caret is in and how many rows it draws, as
   * `{ row, rows }` (from 0): a multi-line Edit's rows as it wraps its value
   * (the caret where a row wraps is at the next row's start, unless the
   * keyboard put it at the row's end); a one-line Edit's is row 0 of 1.
   * @returns {{ row: number, rows: number }}
   */
  caretRow() {
    if (this.kind !== EDIT || this.lines <= 1 || this.owner === null) return { row: 0, rows: 1 };
    return this.owner.caretRow(this);
  }

  /** Where an Edit's selection starts, as an input's; setting it keeps the end (moved up to it when before). */
  get selectionStart() {
    const [a, c] = this.ends();
    return Math.min(a, c);
  }

  set selectionStart(start) {
    this.setSelectionRange(start, Math.max(start, this.selectionEnd), this.selectionDirection);
  }

  /** Where an Edit's selection ends, as an input's. */
  get selectionEnd() {
    const [a, c] = this.ends();
    return Math.max(a, c);
  }

  set selectionEnd(end) {
    this.setSelectionRange(Math.min(this.selectionStart, end), end, this.selectionDirection);
  }

  /** 'backward' when the caret is at the selection's start, else 'forward'. */
  get selectionDirection() {
    const [a, c] = this.ends();
    return c < a ? 'backward' : 'forward';
  }

  /**
   * Selects an Edit's value from `start` to `end` (clamped to it; an end
   * before the start collapses at the end), the caret at the end unless
   * `direction` is 'backward', as an input's `setSelectionRange`. An
   * unfocused Edit takes it when it gets focus.
   * @param {number} start @param {number} end @param {'forward' | 'backward' | 'none'} [direction]
   */
  setSelectionRange(start, end, direction = 'none') {
    if (this.kind !== EDIT) return;
    const length = this.draft.length;
    const e = Math.max(0, Math.min(length, Math.floor(end) || 0));
    const s = Math.min(e, Math.max(0, Math.min(length, Math.floor(start) || 0)));
    const back = direction === 'backward';
    const owner = this.owner;
    if (owner !== null && owner.current === this) owner.select(back ? e : s, back ? s : e);
    else {
      this.mark = back ? e : s;
      this.point = back ? s : e;
    }
  }

  /** Keeps the pointer's moves and its release on this item until the release, as an element's. @param {number} [id] */
  setPointerCapture(id) {
    void id;
    if (this.owner !== null) this.owner.grabbed = this;
  }

  /** @param {number} [id] */
  releasePointerCapture(id) {
    void id;
    if (this.owner !== null && this.owner.grabbed === this) this.owner.grabbed = null;
  }

  /** @param {number} [id] */
  hasPointerCapture(id) {
    void id;
    return this.owner !== null && this.owner.grabbed === this;
  }
}

/** Marks an item and every ancestor for layout. @param {Item} item */
export function touch(item) {
  /** @type {Item | null} */
  let n = item;
  while (n !== null) {
    n.dirty = true;
    n.stale = true;
    n = n.parent;
  }
}

/** Unlinks a child from its parent. @param {Item} child */
export function unlink(child) {
  const parent = child.parent;
  if (parent === null) return;
  if (child.prev === null) parent.first = child.next;
  else child.prev.next = child.next;
  if (child.next === null) parent.last = child.prev;
  else child.next.prev = child.prev;
  child.parent = null;
  child.prev = null;
  child.next = null;
  parent.kids = true;
  touch(parent);
}

/** Links `child` into `parent` before `before`, moving it when it is elsewhere. @param {Item} parent @param {Item} child @param {Item | null} before */
export function link(parent, child, before) {
  if (child === before) return;
  if (child.parent !== null) unlink(child);
  if (before !== null && before.parent !== parent) before = null;
  child.parent = parent;
  if (before === null) {
    child.prev = parent.last;
    child.next = null;
    if (parent.last === null) parent.first = child;
    else parent.last.next = child;
    parent.last = child;
  } else {
    child.prev = before.prev;
    child.next = before;
    if (before.prev === null) parent.first = child;
    else before.prev.next = child;
    before.prev = child;
  }
  parent.kids = true;
  touch(parent);
}

/** The color names of the vocabulary. */
const COLORED = ['background', 'color', 'borderColor'];

/**
 * Development mode: reports what a style holds that a drawn renderer cannot
 * draw: names outside the portable vocabulary (the DOM writes them as CSS,
 * ren-canv ignores them) and colors it cannot read (named colors).
 * @param {Record<string, any>} value @param {Style} s
 */
function portable(value, s) {
  if (s.other !== null) diagnose(`REN dev: the style names ${Object.keys(s.other).join(', ')} are not portable: the DOM writes them as CSS, ren-skia and ren-three ignore them.`);
  for (const key of COLORED) {
    const given = value[key];
    if (given != null && argb(given) === null) diagnose(`REN dev: the ${key} ${JSON.stringify(given)} is not a portable color: use an ARGB number, '#rrggbb' or 'rgb(…)'.`);
  }
}

/** A string property value. @param {any} value */
const str = value => (value == null ? null : String(value));
/** A finite number property value, or `fallback` (NaN and ±Infinity too). @param {any} value @param {number} fallback */
const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
/** A finite, nullable number property value. @param {any} value */
const opt = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** A portable color (ARGB number or CSS hex, rgb()), or null. @param {any} value */
const color = value => argb(value);

/**
 * Applies a property to an item. Returns 2 when layout changes, 1 when only
 * the picture changes, 0 when nothing does.
 * @param {Item} item @param {string} name @param {any} value
 * @returns {number}
 */
export function assign(item, name, value) {
  switch (name) {
    case 'text':
      item.caption = str(value);
      return 2;
    case 'runs':
      spansOf(item, value);
      return 2;
    case 'value':
      item.draft = value == null ? '' : String(value);
      // A value set moves the caret to its end (the Document keeps the focused one's).
      item.mark = item.point = -1;
      // An Edit that grows with its lines lays out again, and one whose direction its value gives resolves again.
      return item.autosize !== 0 || item.dir === 2 ? 2 : 1;
    case 'label':
      item.label = str(value);
      return 1;
    case 'layout':
      item.row = value == null ? -1 : value === 'row' ? 1 : 0;
      return 2;
    case 'gap':
      item.gap = num(value, NaN);
      return 2;
    case 'pad':
      item.pad = num(value, NaN);
      return 2;
    case 'fill':
      item.fill = color(value);
      return 2;
    case 'color':
      item.color = color(value);
      return 2;
    case 'size':
      item.size = num(value, NaN);
      return 2;
    case 'height':
      item.height = opt(value);
      return 2;
    case 'width':
      item.width = opt(value);
      return 2;
    case 'min':
      item.min = num(value, NaN);
      return 2;
    case 'hidden':
      item.hidden = !!value;
      return 2;
    case 'selected':
      item.selected = !!value;
      // Given at all (false too): a toggle, whose state the mirror says.
      item.toggle = value != null;
      return 2;
    case 'wrap':
      item.wrap = value == null ? -1 : value ? 1 : 0;
      return 2;
    case 'invalid':
      item.invalid = !!value;
      return 2;
    case 'lines':
      // A Label's clamp; an Edit's rows.
      if (item.kind === LABEL) item.clamp = Math.max(0, Math.floor(num(value, 0)));
      else item.lines = Math.max(1, Math.floor(num(value, 1)));
      return 2;
    case 'ellipsis':
      item.ellipsis = !!value;
      return 2;
    case 'autosize':
      item.autosize = value === true ? Infinity : typeof value === 'number' && value > 0 ? Math.floor(value) : 0;
      return 2;
    case 'disabled':
      item.disabled = !!value;
      return 2;
    case 'readOnly':
      item.readOnly = !!value;
      return 1;
    case 'secret':
      item.secret = !!value;
      return 1;
    case 'tone':
      item.choice = value === 'choice';
      return 2;
    case 'source':
      item.source = str(value);
      return 1;
    case 'trap':
      item.trap = !!value;
      return 0;
    case 'inert':
      item.inert = !!value;
      return 2;
    case 'dir':
      item.dir = value === 'ltr' ? 0 : value === 'rtl' ? 1 : value === 'auto' ? 2 : -1;
      return 2;
    case 'tabIndex':
      item.tabIndex = typeof value === 'number' || typeof value === 'string' ? Math.trunc(num(Number(value), NaN)) : NaN;
      return 1;
    case 'axis':
      item.axis = value === 'x' ? 1 : value === 'both' ? 2 : 0;
      return 2;
    case 'shapes':
      item.shapes = Array.isArray(value) ? value : null;
      return 1;
    case 'style':
      item.style = value == null ? PLAIN : value instanceof Style ? value : styled(value);
      if (value != null && !(value instanceof Style) && development()) portable(value, item.style);
      return 2;
    default:
      if (value === undefined) {
        if (item.other !== null) item.other.delete(name);
      } else {
        if (item.other === null) item.other = new Map();
        item.other.set(name, value);
      }
      return 1;
  }
}
