// The Document: the drawn primitives engine a canvas renderer builds on. It
// is a ren-core Host over a retained scene of the portable primitives (scene.js)
// that lays it out (layout.js), paints it into a flat command buffer and
// finds what changed (draw.js), and hit-tests and routes input itself:
// focus, editing, selection and IME composition. Hosts (browser listeners
// through `attach`, tests) call press, key, type, wheel and resize.
//
// What draws the commands is the subclass's: `draw(frame, damage)` replays a
// frame (CanvasKit in ren-skia, a 2D canvas in ren-three), and `drawing`
// says whether there is anything to draw on. Text is measured through the
// Fonts the subclass passes in.

import { mount, Theme, behaviorOf } from 'ren-core/host';
import { Item, VIEW, LAYOUT, SCROLL, LABEL, EDIT, ACTION, IMAGE, TEXT, MARKER, HOVER, PRESS, FOCUS, kindOf, assign, touch, link, unlink, shown, editable, finite } from './scene.js';
import { line, Boxes, measureOf, rowWidth, rowMeasure, textAt, dirOf, rowAt, follows, indent } from './layout.js';
import { Lines, Seek, Nearest, Under, inside, wraps, xAt } from './text.js';
import { Painter, decode } from './draw.js';
import { Entry } from './entry.js';
import { Mirror, HIDDEN } from './aria.js';

/** @typedef {import('ren-core/host').Host} Host */
/** @typedef {import('./text.js').Fonts} Fonts */
/** @typedef {import('./draw.js').Frame} Frame */
/** @typedef {import('./draw.js').Damage} Damage */

/**
 * @typedef {object} Options
 * @property {number=} width The viewport width in logical pixels (800).
 * @property {number=} height The viewport height in logical pixels (600).
 * @property {number=} scale Device pixels per logical pixel (1).
 * @property {import('ren-core/host').Tokens=} theme Theme color and metric overrides.
 * @property {number=} background The ARGB page color (the theme canvas).
 * @property {(boolean | 'demand')=} aria The accessibility mirror `attach` keeps beside the canvas: always (true, the default), never (false), or once a user activates its hidden "Enable accessibility" button ('demand').
 * @property {import('ren-core/host').Behavior=} behavior How the page behaves under the user's hands (ren-core's `behaviorOf`): as an application ('app', the default: loose text not selectable, Ctrl or Cmd+A and the I-beam only in an Edit or a `select: 'text'` element, the browser's context menu only in an Edit, no touch callout), as a page ('page'), or `like` one with switches of its own.
 * @property {boolean=} fit Size the page to its content (its max-content width and its height) instead of `width` and `height`: a panel.
 * @property {import('./engine.js').LayoutPort=} layout Where the layout engine (Taffy, or one `useLayout` set) lays the page out: in this thread (the default, after `loadLayout()`), or in the worker a `remoteLayout(port)` reaches (`serveLayout` there). With a worker, a change that moves boxes paints when its answer comes.
 */

/**
 * A press (a click, Enter or Space on an Action): where it happened, in
 * logical pixels. As the DOM's click it bubbles from the item pressed
 * through its ancestors, until one stops it.
 */
export class Press {
  /** @param {number} x @param {number} y */
  constructor(x, y) {
    this.type = 'press';
    this.x = x;
    this.y = y;
    /** The item pressed; the item whose handler runs. @type {Item | null} */
    this.target = null;
    /** @type {Item | null} */
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.stopped = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}

/** An edit's value, for change and submit. */
export class Change {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
  }
}

/**
 * What a pointer does (buttons, modifiers, wheel deltas), as a host reads it
 * from its own event; every field is optional.
 * @typedef {object} PointerInfo
 * @property {number=} button
 * @property {number=} buttons
 * @property {boolean=} shiftKey
 * @property {boolean=} ctrlKey
 * @property {boolean=} metaKey
 * @property {boolean=} altKey
 * @property {number=} deltaX
 * @property {number=} deltaY
 * @property {number=} deltaMode 0 pixels, 1 lines, 2 pages, as the DOM's
 * @property {number=} pointerId
 * @property {number=} timeStamp when the platform sent it (ms): presses that carry it are counted into runs of clicks
 */

/** The drag and drop events a primitive listens to. */
const DRAGS = new Set(['dragenter', 'dragover', 'dragleave', 'drop']);

/** The pointer events a primitive listens to, as the DOM names them. */
const POINTER = new Set(['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'pointerenter', 'pointerleave']);

/**
 * A pointer event on a primitive, with the DOM's field names: `x` and `y`
 * in the surface's logical pixels (as `clientX` and `clientY`; these cross
 * to a worker), `offsetX` and `offsetY` from the target's padding box. It
 * bubbles from the target through its ancestors; while a button is down,
 * moves and the release go to the item pressed.
 */
export class Pointer {
  /** @param {string} type @param {number} x @param {number} y @param {Item} target @param {number} offsetX @param {number} offsetY @param {PointerInfo} info */
  constructor(type, x, y, target, offsetX, offsetY, info) {
    this.type = type;
    this.x = x;
    this.y = y;
    this.clientX = x;
    this.clientY = y;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.button = info.button ?? 0;
    this.buttons = info.buttons ?? (type === 'pointerup' || type === 'pointercancel' ? 0 : 1);
    this.shiftKey = info.shiftKey === true;
    this.ctrlKey = info.ctrlKey === true;
    this.metaKey = info.metaKey === true;
    this.altKey = info.altKey === true;
    this.deltaX = info.deltaX ?? 0;
    this.deltaY = info.deltaY ?? 0;
    this.deltaMode = info.deltaMode ?? 0;
    this.pointerId = info.pointerId ?? 1;
    /** The item under the pointer (or pressed); the item whose handler runs. */
    this.target = target;
    /** @type {Item} */
    this.currentTarget = target;
    this.defaultPrevented = false;
    this.stopped = false;
    /** How many handlers ran. */
    this.handled = 0;
  }
  /** Keeps the surface's own response: a press's focus and selection, a wheel's scroll. */
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}

/**
 * The cursor over an item: its style's `cursor` in the states it is in
 * (focus over press over hover, as they overlay), else its own, or its
 * nearest ancestor's; over an Edit, text; else `none` (the default).
 * @param {Item | null} item @param {string} [none]
 */
function cursorOf(item, none = 'default') {
  for (let n = item; n !== null; n = n.parent) {
    const s = n.style;
    const own = ((n.state & FOCUS) !== 0 && s.focus !== null ? s.focus.cursor : null) ?? ((n.state & PRESS) !== 0 && s.press !== null ? s.press.cursor : null) ?? ((n.state & HOVER) !== 0 && s.hover !== null ? s.hover.cursor : null) ?? s.cursor;
    if (own !== null) return own;
    if (n.kind === EDIT) return 'text';
  }
  return none;
}

/**
 * The element around an item (or the item) whose own style opts its text in
 * to selection (`select: 'text'`), when the nearest one that sets `select`
 * does; else null.
 * @param {Item} item
 */
function regionOf(item) {
  for (let n = /** @type {Item | null} */ (item); n !== null; n = n.parent) if (n.style.select >= 0) return n.style.select === 1 ? n : null;
  return null;
}

/** Whether `item` is `outer` or inside it. @param {Item} item @param {Item} outer */
function within(item, outer) {
  for (let n = /** @type {Item | null} */ (item); n !== null; n = n.parent) if (n === outer) return true;
  return false;
}

/** Makes a subtree's items belong to a Document. @param {Item} item @param {Document} owner */
function reown(item, owner) {
  const was = item.owner;
  item.owner = owner;
  if (was !== null && was !== owner && item.events !== null) owner.adopt(item, was);
  for (let c = item.first; c !== null; c = c.next) reown(c, owner);
}

/** Marks an item and everything below it for resolving and layout (a new theme). @param {Item} item */
function restyle(item) {
  item.stale = true;
  item.dirty = true;
  for (let c = item.first; c !== null; c = c.next) restyle(c);
}

/** No pointer details. */
const PLAIN_POINTER = Object.freeze({});

/**
 * How close two presses of one button are to count as a run of clicks (a
 * double or triple click), in ms and in px: the platforms' defaults. A
 * pointerdown carries no count (its `detail` is 0 in Chrome), and a
 * prevented one has no mousedown after it, so the count is made here.
 */
const CLICK_MS = 500;
const CLICK_PX = 4;

/**
 * A key pressed while an item has focus, as the DOM's keydown: it goes to
 * the focused item and bubbles through its ancestors; `preventDefault`
 * keeps a field's own editing, `stopPropagation` ends it.
 */
export class Key {
  /** @param {string} key @param {{ shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean }} [mods] */
  constructor(key, mods = {}) {
    this.type = 'key';
    this.key = key;
    this.shiftKey = mods.shiftKey === true;
    this.ctrlKey = mods.ctrlKey === true;
    this.metaKey = mods.metaKey === true;
    this.altKey = mods.altKey === true;
    /** Whether the focused item is a text field (an Edit), as ren-core's `$keys` tells it. */
    this.editable = false;
    /** The focused item; the item whose handler runs. @type {Item | null} */
    this.target = null;
    /** @type {Item | null} */
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.stopped = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}

/** A Scroll moved (its `scrollTop`), as the DOM's scroll event; it does not bubble, so `stopPropagation` ends nothing after it. */
export class Scrolled {
  /** @param {Item} target */
  constructor(target) {
    this.type = 'scroll';
    this.target = target;
    this.currentTarget = target;
    this.scrollTop = target.offset;
    this.scrollLeft = target.scrollLeft;
  }
  stopPropagation() {}
}

/**
 * A focus or blur, as the DOM's: the item that takes or gives up the focus,
 * and the other one (`relatedTarget`, null for none). It does not bubble, so
 * `stopPropagation` ends nothing after it; each is its own event.
 */
class Focus {
  /** @param {string} type @param {Item} target @param {Item | null} relatedTarget */
  constructor(type, target, relatedTarget) {
    this.type = type;
    this.target = target;
    this.currentTarget = target;
    this.relatedTarget = relatedTarget;
    this.stopped = false;
  }
  stopPropagation() {
    this.stopped = true;
  }
}

/**
 * The drawn primitives engine: the ren-core Host, plus the input methods a host
 * environment drives. A subclass draws its frames (`draw`).
 * @implements {Host}
 */
export class Document {
  /** @param {Fonts} fonts what measures text @param {Options} [options] */
  constructor(fonts, options = {}) {
    this.theme = new Theme(options.theme);
    this.fonts = fonts;
    /** The layout tree beside the scene, laid out here or in a worker. */
    this.boxes = new Boxes(this.fonts, this.theme, options.layout?.engine());
    this.painter = new Painter(this.fonts, this.theme, this.boxes);
    this.width = options.width ?? 800;
    this.height = options.height ?? 600;
    this.scale = options.scale ?? 1;
    this.boxes.scale = this.scale;
    /**
     * Where the page's origin sits past the canvas's pixels, in logical
     * pixels (under one device pixel): a browser snaps a canvas to device
     * pixels while the DOM beside it keeps the fraction, so the backends
     * draw shifted by it and text rows land where the DOM's do (`attach`
     * measures it).
     */
    this.shiftX = 0;
    this.shiftY = 0;
    /** Called after each frame (`attach` measures the shift then). @type {(() => void) | null} */
    this.framed = null;
    this.background = options.background ?? this.theme.canvas;
    /** True when the background was given: a new theme keeps it. */
    this.ownBackground = options.background !== undefined;
    /** Size the page to its content. */
    this.fit = options.fit === true;
    /** The last item id this renderer gave. */
    this.count = 0;
    /** The page: views render into it. */
    this.root = new Item(VIEW, '', ++this.count);
    /** The overlay layer portals render into, drawn over the page. */
    this.overlay = new Item(VIEW, '', ++this.count);
    /** The item with keyboard focus. @type {Item | null} */
    this.current = null;
    /** `current`'s ancestors when it took the focus: a removed item's focusout still reaches them. @type {Item[]} */
    this.focusPath = [];
    /** The caret of the focused edit: the moving end of its selection. */
    this.caret = 0;
    /** The fixed end of the selection; equal to `caret` when nothing is selected. */
    this.anchor = 0;
    /** Where an IME composition starts in the focused edit's draft (-1: none), and its text. */
    this.from = -1;
    this.preedit = '';
    /** The draft without the composition, and where the replaced selection ended in it. */
    this.base = '';
    this.cut = 0;
    /** The native text entry `attach` made in a document. @type {Entry | null} */
    this.entry = null;
    /** The x a run of ArrowUp and ArrowDown keeps, and where its last move left the caret. @type {{ item: Item, caret: number, x: number } | null} */
    this.goal = null;
    /**
     * A caret at a soft wrap shown at the end of the row before it (a
     * textarea's upstream affinity), as a move up, down or to a row's end
     * leaves it; it holds while the caret stays where that move put it.
     * @type {{ item: Item, caret: number } | null}
     */
    this.upstream = null;
    /** When `attach` mirrors the scene for assistive technology. */
    this.aria = options.aria ?? true;
    /** How the page behaves under the user's hands: each switch of its `behavior`. @type {import('ren-core/host').Switches} */
    this.behavior = behaviorOf(options.behavior);
    // Text no `select` style reaches is selectable as the behavior says.
    this.boxes.select = this.behavior.select;
    /** The accessibility mirror, while there is one. @type {Mirror | null} */
    this.mirror = null;
    /** True when focus came from the keyboard, so an action shows its ring. */
    this.ring = false;
    /** True when the last input was a key, not the pointer: a focus from code then shows the ring, as Chrome's :focus-visible. */
    this.keyed = false;
    /** The item under the pointer, and the one it pressed (until release). @type {Item | null} */
    this.hovered = null;
    /** Pointer handlers on the scene; none: no pointer event is made. */
    this.pointing = 0;
    /** The last press's run of clicks: how many, when (the platform's ms), where, and with which button. */
    this.clicks = 0;
    this.clickAt = -Infinity;
    this.clickX = 0;
    this.clickY = 0;
    this.clickButton = 0;
    /** The CSS cursor over the hovered item (its style's `cursor`, or its nearest ancestor's); the host shows it. */
    this.cursor = 'default';
    /** Where the pointer last was over the surface (NaN: not over it), where each frame finds the cursor again. */
    this.pointerX = NaN;
    this.pointerY = NaN;
    /** Called when a frame changes the cursor under a still pointer (`attach` shows it). @type {(() => void) | null} */
    this.aimed = null;
    /** The items listening for `resize`. @type {Set<Item>} */
    this.resizing = new Set();
    /** The image sources that failed to load here: never loaded again, an Image that shows one hears `error`. @type {Set<string>} */
    this.broken = new Set();
    /** Images given a broken source, told `error` after the next present. @type {Item[]} */
    this.erred = [];
    /** The items listening for `move`, each with the place it was last told at (x, y; NaN before one). @type {Map<Item, Float64Array>} */
    this.moving = new Map();
    /** The item under a drag over the canvas (null: none). @type {Item | null} */
    this.dragged = null;
    /** `dragged` and its ancestors when it became the item under the drag: its leave goes to the nearest still attached. @type {Item[]} */
    this.dragPath = [];
    /** The item a pointerdown reached: moves and the release go to it until then. @type {Item | null} */
    this.grabbed = null;
    /** Its padding box origin when pressed, for offsets once it is not drawn under the pointer. */
    this.grabX = 0;
    this.grabY = 0;
    /** @type {Item | null} */
    this.pressed = null;
    /** What a pointer drag selects: 0 nothing, 1 the focused Edit's value, 2 text. */
    this.dragging = 0;
    /** The text selection: where it started and where it ends now, and the items it covers. @type {Item | null} */
    this.anchorItem = null;
    this.anchorAt = 0;
    /** @type {Item | null} */
    this.focusItem = null;
    this.focusAt = 0;
    /** @type {Item[]} */
    this.selected = [];
    /** True while the page overflows: its scrollbar's width is taken from the page. */
    this.gutter = false;
    /** What the page was last laid out at (the page's and the overlay's nodes are set as it is). @type {import('./engine.js').Spec} */
    this.spec = { root: 0, overlay: 0, width: -1, height: -1, bar: 0, gutter: false, fit: this.fit };
    /** Layouts run again for wrapping text since the present began. */
    this.passes = 0;
    /** The page scroll offset and its limit. */
    this.page = 0;
    this.limit = 0;
    /** Repaint only the rectangles that differ from the last frame (damage repaint); false repaints every frame whole. */
    this.partial = true;
    /** True when the next frame must repaint whole: the first, after a resize or an image load. */
    this.full = true;
    /** How the last present repainted: 'full', 'damage' (its rectangles only) or 'none' (nothing differed). */
    this.repaint = 'none';
    /** True when the next present must lay out and paint. */
    this.damage = true;
    /** The number of frames painted. */
    this.frames = 0;
    this.closed = false;
    /** The application root's host element and what `open` made in it. @type {any} */
    this.host = null;
    /** @type {any} */
    this.made = null;
    /** @type {(() => void) | null} */
    this.detach = null;
    this.opened = false;
    /** Who follows the viewport (ren-core's `$viewport`), and the window's preference queries while one does. @type {Set<(width: number, height: number, flags: number) => void>} */
    this.viewers = new Set();
    /** @type {any[] | null} */
    this.queries = null;
    this.tell = () => this.viewed();
  }

  /** The renderer's name, for `Runtime`. */
  get kind() {
    return 'canvas';
  }

  /** The name errors carry. */
  get name() {
    return `REN ${this.kind}`;
  }

  /** True when there is a surface to draw on: `present` then calls `draw`. */
  get drawing() {
    return false;
  }

  /**
   * Prepares an application root: in a document, marks its host element and
   * routes input from the canvas `canvasFor` gives (none: no input). Returns
   * the page. One root per document.
   * @param {any} element the host element, or null (no document)
   * @param {string} id
   */
  open(element, id) {
    if (this.opened) throw new Error(`${this.name}: a renderer serves one root; make one per root`);
    this.opened = true;
    this.host = element;
    if (element != null && element.ownerDocument != null) {
      element.setAttribute('data-ren-root', id);
      const canvas = this.canvasFor(element);
      if (canvas !== null) this.detach = attach(this, canvas);
    }
    return this.root;
  }

  /**
   * Where a box of the page shows on screen, relative to the canvas's
   * offset parent: for the native text entry over the focused Edit. A page
   * drawn straight on the canvas is at the canvas's offset; one drawn
   * elsewhere (a panel in a 3D scene) projects it.
   * @param {any} canvas @param {number} x @param {number} y @param {number} right @param {number} bottom
   * @returns {[number, number, number, number]} left, top, width, height
   */
  screen(canvas, x, y, right, bottom) {
    return [(canvas.offsetLeft ?? 0) + x, (canvas.offsetTop ?? 0) + y, right - x, bottom - y];
  }

  /**
   * The canvas an application root draws on and takes input from, made in
   * its host element when needed; null for none. The subclass's.
   * @param {any} element
   * @returns {any}
   */
  canvasFor(element) {
    void element;
    return null;
  }

  /**
   * Draws the painted frame: whole when `damage` is null, else only inside
   * its rectangles. The subclass's.
   * @param {Frame} frame @param {Damage | null} damage
   */
  draw(frame, damage) {
    void frame;
    void damage;
  }

  // -------------------------------------------------------------------------
  // Host

  /** @param {string} tag @param {any} props */
  element(tag, props) {
    const kind = kindOf(tag);
    if (kind < 0) throw new Error(`${this.name}: unsupported element <${tag}>; use the ren-core primitives`);
    const item = new Item(kind, '', ++this.count);
    item.owner = this;
    if (kind === EDIT && props != null && typeof props.lines === 'number') assign(item, 'lines', props.lines);
    return item;
  }

  /** @param {string} text */
  text(text) {
    return new Item(TEXT, text, ++this.count);
  }

  /** @param {Item} node @param {string} text */
  content(node, text) {
    if (node.own === text) return;
    node.own = node.text = text;
    touch(node);
    if (this.mirror !== null && node.parent !== null) this.mirror.note(node.parent);
    this.damage = true;
  }

  /** @param {Item} node @param {string} name @param {any} value @param {any} previous */
  set(node, name, value, previous) {
    const was = name === 'value' ? node.draft : '';
    const change = assign(node, name, value);
    // A source that failed before: this Image hears `error` too (at mount, or on a change), with no load again.
    if (name === 'source' && node.kind === IMAGE && node.source !== null && this.broken.has(node.source)) this.erred.push(node);
    if (change === 0) return;
    if (change === 2) touch(node);
    if (this.mirror !== null) this.mirror.note(node);
    if (node === this.current && name === 'value') {
      // The view rewrote the value (a mask, a rejected edit): the caret goes to its end, as the DOM puts it.
      if (this.from < 0 && node.draft !== was) this.caret = this.anchor = node.draft.length;
      if (this.from >= 0) {
        // The app wrote a value under a composition: it becomes the base.
        this.base = node.draft;
        this.from = Math.min(this.from, this.base.length);
        this.cut = Math.max(this.from, Math.min(this.cut, this.base.length));
        node.draft = this.base.slice(0, this.from) + this.preedit + this.base.slice(this.cut);
      }
      this.clamp(node.draft.length);
    }
    this.damage = true;
  }

  /** @param {Item} node @param {string} name @param {(event: any) => void} handler */
  listen(node, name, handler) {
    const listener = { name, fn: handler };
    if (node.events === null) node.events = [];
    node.events.push(listener);
    if (name === 'press' && !node.presses) {
      node.presses = true;
      this.damage = true;
    }
    if (name === 'resize') {
      this.resizing.add(node);
      node.sizeW = node.sizeH = -1;
      this.damage = true;
    }
    if (name === 'move' && !this.moving.has(node)) {
      // Compared from where it is now, when it has a place.
      const at = new Float64Array([NaN, NaN]);
      if (this.attached(node) && node.tree === this.boxes) {
        const r = node.getBoundingClientRect();
        at[0] = r.x;
        at[1] = r.y;
      }
      this.moving.set(node, at);
    }
    const pointer = POINTER.has(name);
    if (pointer) {
      this.pointing++;
      if (!node.pointers) {
        node.pointers = true;
        this.damage = true;
      }
    }
    return () => {
      const events = node.events;
      if (events === null) return;
      const at = events.indexOf(listener);
      if (at < 0) return;
      events.splice(at, 1);
      // The Document it belongs to now (a panel may have adopted it since).
      const doc = node.owner instanceof Document ? node.owner : this;
      if (name === 'press') node.presses = events.some(e => e.name === 'press');
      if (name === 'resize' && !events.some(e => e.name === 'resize')) doc.resizing.delete(node);
      if (name === 'move' && !events.some(e => e.name === 'move')) doc.moving.delete(node);
      if (pointer) {
        doc.pointing--;
        node.pointers = events.some(e => POINTER.has(e.name));
      }
    };
  }

  /**
   * Takes over what an item made for another Document listens for (ren-three
   * binds a panel's items on the overlay before the panel adopts them): its
   * size and place are followed here, and its pointer listeners count here.
   * @param {Item} item @param {Document} was
   */
  adopt(item, was) {
    const events = /** @type {{ name: string }[]} */ (item.events);
    if (was.resizing.delete(item)) {
      this.resizing.add(item);
      item.sizeW = item.sizeH = -1;
      this.damage = true;
    }
    if (was.moving.delete(item)) this.moving.set(item, new Float64Array([NaN, NaN]));
    const pointers = events.filter(e => POINTER.has(e.name)).length;
    was.pointing -= pointers;
    this.pointing += pointers;
  }

  /**
   * Sends a pointer event to the topmost item under a point (or to `to`,
   * the item pressed while a button is down), then to each ancestor, until
   * one stops it. Returns the event, or null when no item takes it.
   * @param {string} type @param {number} x @param {number} y @param {PointerInfo} info @param {Item | null} [to]
   * @returns {Pointer | null}
   */
  pointer(type, x, y, info, to = null) {
    if (this.pointing === 0) return null;
    // The target is the topmost box drawn under the pointer, as the DOM's
    // element under it: the event bubbles from it to the handlers above.
    const hits = this.painter.covers;
    const b = hits.box;
    let target = to;
    let i = -1;
    if (target === null) {
      i = hits.find(x, y);
      if (i < 0) return null;
      target = hits.items[i];
    } else for (let k = hits.n - 1; k >= 0; k--) if (hits.items[k] === target) i = k;
    // The target's padding box, where it was last drawn (or where it was pressed).
    let ox = this.grabX;
    let oy = this.grabY;
    // The point in the target's space (a transformed one's own).
    let lx = x;
    let ly = y;
    if (i >= 0) {
      ox = b[i * 6 + 4] + target.r.bL;
      oy = b[i * 6 + 5] + target.r.bT;
      hits.local(i, x, y);
      lx = hits.px;
      ly = hits.py;
    }
    const e = new Pointer(type, x, y, target, lx - ox, ly - oy, info);
    for (let n = /** @type {Item | null} */ (target); n !== null && !e.stopped; n = n.parent) {
      if (!n.pointers) continue;
      e.currentTarget = n;
      e.handled++;
      this.emit(n, type, e);
    }
    if (type === 'pointerdown') {
      this.grabX = ox;
      this.grabY = oy;
    }
    return e;
  }

  /** @param {Item} parent @param {Item} child @param {Item | null} before */
  insert(parent, child, before) {
    if (parent.kind === EDIT) return;
    // An item made for another Document (ren-three's panels take the
    // overlay's items) belongs here now: its methods act on this one.
    if (child.owner !== this) reown(child, this);
    link(parent, child, before);
    if (this.mirror !== null) this.mirror.insert(parent, child);
    this.damage = true;
  }

  /** @param {Item} parent @param {Item} child */
  remove(parent, child) {
    if (child.parent !== parent) return;
    unlink(child);
    this.boxes.drop(child);
    // The pointer's capture goes with a removed item, as the DOM releases it.
    for (let n = this.grabbed; n !== null; n = n.parent)
      if (n === child) {
        this.grabbed = null;
        break;
      }
    if (this.mirror !== null) this.mirror.remove(parent, child);
    this.damage = true;
  }

  marker() {
    return new Item(MARKER, '', ++this.count);
  }

  /** @param {Item} node */
  parent(node) {
    return node.parent;
  }

  /** @param {Item} node */
  next(node) {
    return node.next;
  }

  /** @param {any} value */
  owns(value) {
    return value instanceof Item;
  }

  layer() {
    return this.overlay;
  }

  /**
   * Lays out, paints and shows a frame when something changed since the last
   * one; returns whether it painted. Cheap when nothing did.
   */
  present() {
    if (this.closed) return false;
    const current = this.current;
    if (current !== null && !this.attached(current)) {
      if (this.from >= 0) this.drop();
      // The focus trap it was in, still shown, takes the focus back.
      /** @type {Item | null} */
      let trap = null;
      for (const n of this.focusPath) if (n.trap && !n.hidden && this.attached(n)) {
        trap = n;
        break;
      }
      this.current = null;
      this.damage = true;
      this.lost(current);
      if (trap !== null && this.current === null && !inertAt(trap)) {
        // Its first focusable, else the trap itself when it takes the focus.
        /** @type {Item[]} */
        const order = [];
        inputs(trap, order, NO_SEEK);
        const next = order.length > 0 ? order[0] : takes(trap) ? trap : null;
        if (next !== null) this.focus(next, this.keyed);
      }
    } else if (current !== null && (current.disabled || inertAt(current))) {
      // Disabled while focused, or in a region made inert: it gives the focus up, as a DOM field does.
      if (this.from >= 0) this.drop();
      this.current = null;
      this.states(current, FOCUS, false, false);
      this.damage = true;
      this.lost(current);
    }
    if (this.selected.length > 0) this.unselectRemoved();
    if (this.erred.length > 0) {
      // Told after the frame (a handler may change the view), as a failed load is.
      const erred = this.erred.splice(0);
      queueMicrotask(() => {
        for (const item of erred)
          if (!this.closed && item.source !== null && this.broken.has(item.source) && item.events !== null && this.attached(item)) this.emit(item, 'error', { type: 'error', target: item, currentTarget: item, source: item.source });
      });
    }
    if (!this.damage || this.boxes.engine.busy) return false;
    this.damage = false;
    const frames = this.frames;
    this.passes = 0;
    this.lay();
    return this.frames !== frames;
  }

  /**
   * Brings the layout up to date with the scene, then paints: at once when
   * nothing moved or layout runs in this thread, when the answer comes when
   * it runs in a worker.
   */
  lay() {
    const spec = this.spec;
    const changed = this.boxes.prepare(this.root, this.overlay, this.width, this.width - (this.gutter ? this.theme.bar : 0), this.height);
    if (!changed && spec.width === this.width && spec.height === this.height) {
      this.paint();
      return;
    }
    spec.root = this.root.node;
    spec.overlay = this.overlay.node;
    spec.width = this.width;
    spec.height = this.height;
    spec.bar = this.theme.bar;
    spec.gutter = this.gutter;
    this.boxes.arrange(spec, placed => this.placed(placed));
  }

  /** The page was laid out. @param {import('./engine.js').Placed} placed */
  placed(placed) {
    if (this.closed) return;
    const spec = this.spec;
    this.gutter = placed.gutter;
    if (this.fit && (placed.width !== this.width || placed.height !== this.height)) {
      // A panel: as wide as its content wants, as high as it then is.
      this.width = placed.width;
      this.height = placed.height;
      this.sized();
      // After this layout: the view may change with it (a breakpoint), and must not lay out inside it.
      if (this.viewers.size > 0) queueMicrotask(this.tell);
    }
    spec.width = this.width;
    spec.height = this.height;
    this.boxes.fix(this.root);
    this.boxes.fix(this.overlay);
    // Wrapping text takes the height of its rows at the width it got (a
    // height seldom changes a width: this settles in a pass or two); what
    // changed while a worker laid out is laid out before it paints.
    // A fixed item between two insets in the page follows its scrollbar coming or going.
    const boxes = this.boxes;
    const wrapped = this.passes < 3 && (boxes.wraps() || (boxes.pinned.size > 0 && boxes.pageW !== this.width - (this.gutter ? this.theme.bar : 0)));
    if (wrapped || (this.damage && this.boxes.engine.pushed)) {
      if (wrapped) this.passes++;
      this.damage = false;
      this.lay();
      return;
    }
    this.paint();
  }

  /** Paints the laid-out scene and shows it. */
  paint() {
    if (this.mirror !== null && this.mirror.queue.length > 0) this.mirror.flush();
    this.limit = Math.max(0, this.root.h - this.height);
    this.page = Math.min(this.limit, Math.max(0, this.page));
    const focused = this.current;
    if (focused !== null && focused.kind === EDIT && focused.lines > 1) this.reveal(focused);
    const state = this.painter.state;
    state.width = this.width;
    state.height = this.height;
    state.focus = this.current;
    state.caret = this.caret;
    state.anchor = this.anchor;
    state.upstream = this.current !== null && this.upstreamAt(this.current, this.caret);
    state.from = this.from;
    state.span = this.preedit.length;
    state.ring = this.ring;
    state.page = this.page;
    state.scale = this.scale;
    this.painter.draw(this.root, this.overlay, this.limit);
    if (this.drawing) {
      /** @type {Damage | null} */
      let damage = null;
      if (this.partial && !this.full) {
        damage = this.painter.compare();
        // Past half the viewport, one whole pass is cheaper than clipped ones.
        if (damage.n > 0 && damage.area() > this.width * this.height * 0.5) damage = null;
      }
      this.full = false;
      if (damage !== null && damage.n === 0) this.repaint = 'none';
      else {
        this.repaint = damage === null ? 'full' : 'damage';
        this.draw(this.painter.frame, damage);
      }
    }
    this.frames++;
    this.framed?.();
    if (this.pointerX === this.pointerX) this.aim();
    if (this.entry !== null) this.entry.sync();
    if (this.resizing.size > 0) this.sizes();
    if (this.moving.size > 0) this.moves();
  }

  /**
   * After a layout: each item listening for `resize` whose border box got a
   * new size (or its first) hears it, as a ResizeObserver reports it.
   */
  sizes() {
    /** @type {Item[]} */
    const changed = [];
    for (const item of this.resizing) {
      if (!this.attached(item) || item.tree !== this.boxes) continue;
      this.boxes.fix(item);
      if (item.w === item.sizeW && item.h === item.sizeH) continue;
      item.sizeW = item.w;
      item.sizeH = item.h;
      changed.push(item);
    }
    for (const item of changed) this.emit(item, 'resize', { type: 'resize', target: item, currentTarget: item, width: item.w, height: item.h });
  }

  /**
   * After a frame: each item listening for `move` whose border box is
   * painted somewhere new (a layout shift, a scroll, a transform, an
   * animation: whatever painted it there) hears its place, `{ x, y }` as
   * its getBoundingClientRect() gives it; the first place is only noted.
   */
  moves() {
    /** @type {Item[]} */
    const changed = [];
    for (const [item, at] of this.moving) {
      if (!this.attached(item) || item.tree !== this.boxes) continue;
      const r = item.getBoundingClientRect();
      if (r.x === at[0] && r.y === at[1]) continue;
      const first = at[0] !== at[0];
      at[0] = r.x;
      at[1] = r.y;
      if (!first) changed.push(item);
    }
    for (const item of changed) {
      const at = /** @type {Float64Array} */ (this.moving.get(item));
      if (at !== undefined) this.emit(item, 'move', { type: 'move', target: item, currentTarget: item, x: at[0], y: at[1] });
    }
  }

  // -------------------------------------------------------------------------
  // Drawing

  /** The last frame's command buffer. */
  get frame() {
    return this.painter.frame;
  }

  /** The last frame's commands, decoded. */
  commands() {
    return decode(this.painter.frame);
  }

  /** Called when the viewport size or scale changed, before the next present: a subclass makes its surface again. */
  sized() {
    this.full = true;
  }

  /**
   * Takes a new theme at once: every item's style resolves again, the page
   * lays out and repaints; the scene, focus, selection and state stay (as
   * the DOM follows its custom properties). The background follows the
   * theme's canvas unless one was given.
   * @param {import('ren-core/host').Tokens} tokens
   */
  setTheme(tokens) {
    const theme = new Theme(tokens);
    this.theme = theme;
    this.boxes.theme = theme;
    this.painter.theme = theme;
    if (!this.ownBackground) this.background = theme.canvas;
    for (const layer of [this.root, this.overlay]) restyle(layer);
    this.full = true;
    this.damage = true;
    this.present();
  }

  /**
   * Shifts the drawing by a fraction of a device pixel (`shiftX`), a whole
   * repaint when it changed.
   * @param {number} x @param {number} y
   */
  shift(x, y) {
    if (x === this.shiftX && y === this.shiftY) return;
    this.shiftX = x;
    this.shiftY = y;
    this.full = true;
    this.damage = true;
    this.present();
  }

  /** Changes the viewport size (and scale), then presents. @param {number} width @param {number} height @param {number} [scale] */
  resize(width, height, scale = this.scale) {
    if (width === this.width && height === this.height && scale === this.scale) return;
    const moved = width !== this.width || height !== this.height;
    this.width = width;
    this.height = height;
    if (scale !== this.scale) {
      // Borders snap to the new device pixels.
      this.boxes.scale = scale;
      for (const layer of [this.root, this.overlay]) restyle(layer);
    }
    this.scale = scale;
    this.sized();
    this.damage = true;
    if (moved) this.viewed();
    this.present();
  }

  /**
   * The Host's viewport (ren-core's `$viewport`, `$media`): the Document's
   * size in logical pixels, and the color scheme and motion preferences of
   * the window it is in (none without one); now, then on each change.
   * @param {(width: number, height: number, flags: number) => void} report
   * @returns {() => void}
   */
  viewport(report) {
    const viewers = this.viewers;
    if (viewers.size === 0) this.prefer(true);
    viewers.add(report);
    report(this.width, this.height, this.flags());
    return () => {
      if (viewers.delete(report) && viewers.size === 0) this.prefer(false);
    };
  }

  /** The viewport's flags: 1 a dark color scheme, 2 reduced motion (the window's media queries). */
  flags() {
    const q = this.queries;
    return q === null ? 0 : (q[0].matches ? 1 : 0) | (q[1].matches ? 2 : 0);
  }

  /** Follows the window's color scheme and motion preferences, or stops. @param {boolean} on */
  prefer(on) {
    const tell = this.tell;
    if (!on) {
      if (this.queries !== null) for (const q of this.queries) q.removeEventListener?.('change', tell);
      this.queries = null;
      return;
    }
    const win = this.host?.ownerDocument?.defaultView ?? globalThis;
    if (typeof win.matchMedia !== 'function') return;
    this.queries = [win.matchMedia('(prefers-color-scheme: dark)'), win.matchMedia('(prefers-reduced-motion: reduce)')];
    for (const q of this.queries) q.addEventListener?.('change', tell);
  }

  /** Reports the viewport to its followers. */
  viewed() {
    if (this.viewers.size === 0) return;
    const flags = this.flags();
    for (const report of [...this.viewers]) report(this.width, this.height, flags);
  }

  /**
   * Stops input and frees the fonts. The scene stays until its view is
   * disposed; for an application root (after `open`), the page and overlay
   * are emptied. A subclass frees its surface, then calls this.
   */
  close() {
    // Nothing of a closed Document's caret is kept to be found again.
    this.goal = null;
    this.upstream = null;
    if (this.closed) return;
    this.closed = true;
    if (this.opened) {
      if (this.detach !== null) this.detach();
      this.detach = null;
      for (const layer of [this.root, this.overlay]) while (layer.first !== null) unlink(layer.first);
      if (this.host != null && this.host.ownerDocument != null) this.host.removeAttribute('data-ren-root');
      this.host = null;
    }
    this.prefer(false);
    this.viewers.clear();
    this.boxes.close();
    this.fonts.close();
  }

  // -------------------------------------------------------------------------
  // Input

  /** True when `item` is in the page or the overlay. @param {Item} item */
  attached(item) {
    /** @type {Item | null} */
    let n = item;
    while (n !== null) {
      if (n === this.root || n === this.overlay) return true;
      if (n.hidden) return false;
      n = n.parent;
    }
    return false;
  }

  /** Runs the handlers of `name` on `item`. @param {Item} item @param {string} name @param {any} event */
  emit(item, name, event) {
    const events = item.events;
    if (events === null) return;
    const list = events.length === 1 ? events : events.slice();
    for (let i = 0; i < list.length; i++) if (list[i].name === name) list[i].fn(event);
  }

  /**
   * Presses an item: its press handlers, then its ancestors', as the DOM's
   * click bubbles, until one stops it.
   * @param {Item} item @param {Press} press
   */
  activate(item, press) {
    press.target = item;
    for (let n = /** @type {Item | null} */ (item); n !== null && !press.stopped; n = n.parent) {
      if (!n.presses) continue;
      press.currentTarget = n;
      this.emit(n, 'press', press);
    }
  }

  /**
   * Files dropped at a point (the host's drop, `attach`'s): the item under
   * it and its ancestors hear `drop` with the files, as the DOM's drop
   * bubbles, until one stops it. Returns whether any heard it.
   * @param {number} x @param {number} y @param {readonly any[]} files
   */
  dropFiles(x, y, files) {
    this.present();
    // A drop ends the drag, without a leave (as the DOM's).
    this.dragTo(null);
    const covers = this.painter.covers;
    const c = covers.find(x, y);
    if (c < 0) return false;
    const heard = this.bubble(covers.items[c], 'drop', { type: 'drop', files, x, y, target: null, currentTarget: null, stopPropagation: null });
    this.present();
    return heard;
  }

  /**
   * An event that bubbles from `target` through its ancestors' handlers of
   * its name (its `stopPropagation` ends it), as the DOM's drop and drag.
   * Returns whether any heard it.
   * @param {Item} target @param {string} name @param {any} e
   */
  bubble(target, name, e) {
    let stopped = false;
    let heard = false;
    e.target = target;
    e.stopPropagation = () => void (stopped = true);
    for (let n = /** @type {Item | null} */ (target); n !== null && !stopped; n = n.parent) {
      if (n.events === null || !n.events.some(l => l.name === name)) continue;
      e.currentTarget = n;
      heard = true;
      this.emit(n, name, e);
    }
    return heard;
  }

  /**
   * A drag over the canvas at a point (the host's dragenter and dragover,
   * `attach`'s), carrying `files` files of these MIME `types` as far as the
   * platform tells: as the DOM's, when the item under it changes, the new
   * one hears `dragenter`, then the last one `dragleave` (one hidden or
   * removed since: its nearest ancestor still attached, which hears neither
   * when it is the new one); the item under it hears `dragover`; each
   * bubbles. Returns whether any heard the dragover.
   * @param {number} x @param {number} y @param {number} [files] @param {readonly string[]} [types]
   */
  dragOver(x, y, files = 0, types = []) {
    this.present();
    const covers = this.painter.covers;
    const c = x === x && y === y ? covers.find(x, y) : -1;
    const target = c < 0 ? null : covers.items[c];
    const changed = target !== this.dragged;
    const last = changed ? this.dragAncestor() : null;
    if (changed) this.dragTo(target);
    /** @param {string} type */
    const drag = type => ({ type, x, y, files, types, target: null, currentTarget: null, stopPropagation: null });
    if (changed && last !== target) {
      if (target !== null) this.bubble(target, 'dragenter', drag('dragenter'));
      if (last !== null) this.bubble(last, 'dragleave', drag('dragleave'));
    }
    const heard = target !== null && this.bubble(target, 'dragover', drag('dragover'));
    this.present();
    return heard;
  }

  /**
   * The item under the drag, or, when it was hidden or removed since, its
   * nearest ancestor (as it was then) still attached; null: none.
   * @returns {Item | null}
   */
  dragAncestor() {
    const path = this.dragPath;
    for (let i = 0; i < path.length; i++) if (this.attached(path[i])) return path[i];
    return null;
  }

  /** Makes `item` the one under the drag (null: none), keeping its ancestors. @param {Item | null} item */
  dragTo(item) {
    this.dragged = item;
    const path = this.dragPath;
    path.length = 0;
    for (let n = item; n !== null; n = n.parent) path.push(n);
  }

  /**
   * The item a drag or drop at a point reaches: the topmost item under it,
   * or its nearest ancestor, that listens for `dragenter`, `dragover`,
   * `dragleave` or `drop` (null: none). A host that lays the page over
   * other content (ren-three's overlay) takes files there even where
   * nothing is painted, as the DOM's element under them.
   * @param {number} x @param {number} y
   * @returns {Item | null}
   */
  dropTarget(x, y) {
    this.present();
    const covers = this.painter.covers;
    const c = covers.find(x, y);
    if (c < 0) return null;
    for (let n = /** @type {Item | null} */ (covers.items[c]); n !== null; n = n.parent) {
      const events = n.events;
      if (events === null) continue;
      for (let i = 0; i < events.length; i++) if (DRAGS.has(events[i].name)) return n;
    }
    return null;
  }

  /**
   * The drag left the canvas (or was cancelled): the item under it hears
   * `dragleave`, bubbling; one hidden or removed since, its nearest ancestor
   * still attached.
   */
  dragLeave() {
    const last = this.dragAncestor();
    this.dragTo(null);
    if (last === null) return;
    this.bubble(last, 'dragleave', { type: 'dragleave', x: NaN, y: NaN, files: 0, types: [], target: null, currentTarget: null, stopPropagation: null });
    this.present();
  }

  /**
   * A failed image source left the replay's cache: the next draw loads it
   * again, so it is no longer known to fail (an Image on it hears `error`
   * only if that load fails too).
   * @param {string} source
   */
  forgot(source) {
    this.broken.delete(source);
  }

  /**
   * An image source failed to load (the replay's loader says so): each
   * Image showing it hears `error`, as a DOM img's.
   * @param {string} source
   */
  failed(source) {
    this.broken.add(source);
    /** @param {Item} n */
    const walk = n => {
      for (let c = n.first; c !== null; c = c.next) {
        if (c.kind === IMAGE && c.source === source && c.events !== null) this.emit(c, 'error', { type: 'error', target: c, currentTarget: c, source });
        walk(c);
      }
    };
    walk(this.root);
    walk(this.overlay);
  }

  /**
   * The focused item gave the focus up by itself (hidden, removed or
   * disabled): it hears `blur`, then `focusout` (`relatedTarget` null)
   * bubbles through the ancestors it had when it took the focus (a removed
   * one's, whose handlers went with it, hear nothing), so a wrapper hears
   * the focus leave it.
   * @param {Item} item
   */
  lost(item) {
    const path = this.focusPath.slice();
    this.focusPath.length = 0;
    this.emit(item, 'blur', new Focus('blur', item, null));
    let stopped = false;
    const e = { type: 'focusout', relatedTarget: null, target: item, currentTarget: /** @type {Item | null} */ (null), stopPropagation: () => void (stopped = true) };
    for (let i = 0; i < path.length && !stopped; i++) {
      const n = path[i];
      if (n.events === null || !n.events.some(l => l.name === 'focusout')) continue;
      e.currentTarget = n;
      this.emit(n, 'focusout', e);
    }
  }

  /** The item with keyboard focus, or null. */
  get focused() {
    return this.current;
  }

  /** The item with keyboard focus, or null, as a document's (an item's `getRootNode()` is its Document). */
  get activeElement() {
    return this.current;
  }

  /**
   * Moves keyboard focus to `item` (null blurs), in the DOM's order: the old
   * one hears `blur`, then `focusout`, the new one `focus`, then `focusin`;
   * focusout and focusin bubble, with `relatedTarget` the other item (null:
   * none), so a wrapper hears focus move into or out of it (also when the
   * focused item is hidden, removed or disabled: `lost`). A blur or focusout
   * handler that moves the focus elsewhere wins, as in Chrome
   * (test/fixtures/focus.json). A composition in the edit losing focus is committed first.
   * @param {Item | null} item @param {boolean} [ring] show the ring on an Action (keyboard focus)
   */
  focus(item, ring = false) {
    if (item !== null && !takes(item)) item = null;
    // A disabled Edit, or an item in an inert region, takes no focus (the focus stays where it is).
    if (item !== null && (item.disabled || inertAt(item))) return;
    const old = this.current;
    if (this.ring !== ring) {
      this.ring = ring;
      this.damage = true;
    }
    if (old === item) return;
    if (this.from >= 0) this.commit(this.preedit);
    if (this.current !== old) return;
    this.damage = true;
    if (old !== null) {
      // While the old one hears blur and focusout nothing has the focus, as
      // in Chrome: a handler that moves it elsewhere wins and `item` hears
      // nothing (moved by a blur handler, the focusout follows, relatedTarget null).
      this.current = null;
      this.focusPath.length = 0;
      this.states(old, FOCUS, false, false);
      this.emit(old, 'blur', new Focus('blur', old, item));
      const moved = this.current !== null;
      this.bubble(old, 'focusout', { type: 'focusout', relatedTarget: moved ? null : item, target: null, currentTarget: null, stopPropagation: null });
      if (moved || this.current !== null) return;
      if (item !== null && item.disabled) item = null;
    }
    this.current = item;
    this.focusPath.length = 0;
    for (let n = item; n !== null; n = n.parent) this.focusPath.push(n);
    this.caret = this.anchor = item !== null && item.kind === EDIT ? item.draft.length : 0;
    this.upstream = null;
    this.goal = null;
    if (item !== null && item.point >= 0) {
      // The selection setSelectionRange gave it while unfocused.
      const length = item.draft.length;
      this.anchor = Math.min(item.mark, length);
      this.caret = Math.min(item.point, length);
      item.mark = item.point = -1;
    }
    if (item !== null) this.states(item, FOCUS, true, false);
    if (item !== null) {
      this.emit(item, 'focus', new Focus('focus', item, old));
      // A focus handler that moved the focus on: its own moves were heard, not this focusin (as in Chrome).
      if (this.current === item) this.bubble(item, 'focusin', { type: 'focusin', relatedTarget: old, target: null, currentTarget: null, stopPropagation: null });
    }
  }

  /**
   * A pointer press at a logical point, the `count`th in a row (a double or
   * triple click), with Shift held or not. On an Edit: focuses it and places
   * its caret (a double press selects a word, a triple its whole value;
   * Shift extends the selection), and a drag from there selects. On an
   * Action or a press target: presses it. On selectable text: starts a
   * selection there, which a drag extends (a double press selects a word, a
   * triple the whole Label; Shift extends the selection). Returns whether it
   * hit anything, or a pointer handler took it.
   * @param {number} x @param {number} y @param {number} [count] @param {boolean} [shift] @param {PointerInfo} [info] the pointer's buttons and modifiers, for pointer handlers
   */
  press(x, y, count = 1, shift = false, info = PLAIN_POINTER) {
    this.keyed = false;
    const took = this.pressAt(x, y, this.counted(x, y, count, info), shift, info);
    // The host focused the canvas on pointerdown: the entry takes the focus
    // back even when the press drew nothing new (a press on the focused Edit).
    if (this.entry !== null) this.entry.sync();
    return took;
  }

  /**
   * A press of another button than the main one (a right press): its
   * pointer handlers hear it, so an app can open its own menu there, and it
   * presses, focuses and selects nothing, as a DOM click is the main
   * button's alone. Returns whether a handler heard it.
   * @param {number} x @param {number} y @param {PointerInfo} [info]
   */
  secondary(x, y, info = PLAIN_POINTER) {
    this.keyed = false;
    this.present();
    this.grabbed = null;
    const e = this.pointer('pointerdown', x, y, info);
    this.present();
    return e !== null && e.handled > 0;
  }

  /**
   * A press's place in its run of clicks: the count the platform gave (more
   * than 1), else one more than the last press's when this one is the same
   * button, close in time and place; a press with no platform time (made by
   * code) keeps its count.
   * @param {number} x @param {number} y @param {number} count @param {PointerInfo} info
   */
  counted(x, y, count, info) {
    const at = info.timeStamp;
    if (typeof at !== 'number') return count;
    const button = info.button ?? 0;
    if (count > 1) this.clicks = count;
    else {
      const near = at - this.clickAt <= CLICK_MS && Math.abs(x - this.clickX) <= CLICK_PX && Math.abs(y - this.clickY) <= CLICK_PX && button === this.clickButton;
      this.clicks = near ? this.clicks + 1 : 1;
    }
    this.clickAt = at;
    this.clickX = x;
    this.clickY = y;
    this.clickButton = button;
    return this.clicks;
  }

  /** `press`'s work. @param {number} x @param {number} y @param {number} count @param {boolean} shift @param {PointerInfo} info */
  pressAt(x, y, count, shift, info) {
    this.present();
    // The pointer handlers first: the item pressed keeps the pointer until release.
    // Nothing holds the pointer until a handler captures it (setPointerCapture), as on the DOM.
    this.grabbed = null;
    // The element pressed is the one under the point before the handlers
    // ran, as the DOM's: a handler that lays something over the point (a
    // dropdown's backdrop) keeps the press's focus from nothing.
    const before = this.target(x, y);
    const pressed = before < 0 ? null : this.painter.hits.items[before];
    // The region a press there focuses (a View with a tabIndex around the point), as a DOM click focuses its nearest focusable ancestor.
    const region = this.holder(x, y);
    const e = this.pointer('pointerdown', x, y, info);
    const hits = this.painter.hits;
    const item = pressed !== null && this.attached(pressed) ? pressed : null;
    // A run of text under it with its own press (an anchor in a sentence) hears it first, as a span's click before its Label's.
    const run = e !== null && e.defaultPrevented ? null : this.runAt(x, y);
    let stopped = false;
    if (run !== null && run[0].press !== null) {
      const p = new Press(x, y);
      p.target = p.currentTarget = run[1];
      run[0].press(p);
      stopped = p.stopped;
    }
    // Its region now, for the caret (-1 when a handler hid it).
    const i = item === null ? -1 : this.region(item, x, y);
    if (e !== null && e.defaultPrevented) {
      // Prevented, as a DOM mousedown: no focus and no selection; the click
      // is not the pointerdown's default, so a press target is still pressed.
      if (item !== null && item.kind !== EDIT) this.activate(item, new Press(x, y));
      this.present();
      return true;
    }
    this.dragging = 0;
    if (item === null) {
      this.pressing(null);
      this.focus(region !== null && this.attached(region) ? region : null);
      const at = this.textAt(x, y, false);
      if (at === null) {
        this.unselect();
        this.present();
        // A pointer handler that ran took it: the host keeps the pointer here.
        return e !== null && e.handled > 0;
      }
      const [item, offset] = at;
      if (count >= 3) this.selectText(item, 0, item, item.text.length);
      else if (count === 2) {
        // The word of the character under the press (its right half too), as a browser takes it.
        const [from, to] = word(item.text, /** @type {[Item, number]} */ (this.textAt(x, y, false, true))[1]);
        this.selectText(item, from, item, to);
      } else if (shift && this.anchorItem !== null) this.selectText(this.anchorItem, this.anchorAt, item, offset);
      else this.selectText(item, offset, item, offset);
      this.dragging = 2;
      this.present();
      return true;
    }
    this.pressing(item);
    this.unselect();
    if (item.kind === EDIT && item.disabled) this.focus(null);
    else if (item.kind === EDIT) {
      const was = this.current === item;
      this.focus(item);
      if (this.current === item && i >= 0) {
        if (this.from >= 0) this.commit(this.preedit);
        hits.local(i, x, y);
        const at = this.place(item, hits.px - hits.box[i * 6 + 4], hits.py - hits.box[i * 6 + 5]);
        if (count >= 3) this.select(0, item.draft.length);
        else if (count === 2) {
          // A secret has no words to show: a double press selects it all, as a password field.
          const [from, to] = item.secret ? [0, item.draft.length] : word(item.draft, this.place(item, hits.px - hits.box[i * 6 + 4], hits.py - hits.box[i * 6 + 5], true));
          this.select(from, to);
        } else this.select(shift && was ? this.anchor : -1, at);
        this.dragging = 1;
      }
      // A click on a field bubbles to its ancestors on the DOM too.
      this.activate(item, new Press(x, y));
    } else {
      this.focus(item.kind === ACTION ? item : region !== null && this.attached(region) ? region : null);
      // A run that stopped its press keeps it from the Label and above.
      if (!stopped) this.activate(item, new Press(x, y));
    }
    this.present();
    return true;
  }

  /**
   * True when the page has something under a point: a press or focus
   * target, text, a scrolling region, or anything drawn there. A host that
   * lays the page over other content (ren-three's overlay) sends the point
   * on when not.
   * @param {number} x @param {number} y
   */
  at(x, y) {
    this.present();
    const p = this.painter;
    if (p.hits.find(x, y) >= 0 || p.texts.find(x, y) >= 0 || p.regions.find(x, y) >= 0) return true;
    const marks = p.marks;
    const b = marks.box;
    for (let i = 0; i < marks.n; i++) if (x >= b[i * 4] && x < b[i * 4 + 2] && y >= b[i * 4 + 1] && y < b[i * 4 + 3]) return true;
    return false;
  }

  /**
   * Whether the platform's default action for a `type` event at a point is
   * cancelled: the topmost item drawn there, or one above it, names it in its
   * `prevent` (a name, names split by spaces or a list; true is press and
   * submit), as ren-dom cancels it on the element. The host asks it for the
   * events it cannot hand the items (the browser's context menu).
   * @param {string} type @param {number} x @param {number} y
   */
  cancels(type, x, y) {
    this.present();
    const covers = this.painter.covers;
    const c = covers.find(x, y);
    for (let n = c < 0 ? null : covers.items[c]; n !== null; n = n.parent) {
      const p = n.other === null ? undefined : n.other.get('prevent');
      if (p == null || p === false) continue;
      if (p === true ? type === 'press' || type === 'submit' : (Array.isArray(p) ? p.map(String) : String(p).split(/\s+/)).includes(type)) return true;
    }
    return false;
  }

  /**
   * Whether the browser's context menu opens at a point: in an Edit as the
   * behavior's `editMenu` says, elsewhere as its `menu` says, and never
   * where an item cancels it (`prevent="contextmenu"`).
   * @param {number} x @param {number} y
   */
  menu(x, y) {
    if (this.cancels('contextmenu', x, y)) return false;
    const hits = this.painter.hits;
    const i = hits.find(x, y);
    for (let n = i < 0 ? null : hits.items[i]; n !== null; n = n.parent) if (n.kind === EDIT) return this.behavior.editMenu;
    return this.behavior.menu;
  }

  /**
   * The press or focus target of a point (an Edit, an Action, an item with a
   * press handler), as its hit region's index, or -1: the topmost box drawn
   * there, or its nearest ancestor that is one, as the DOM finds the element
   * a click reaches. A box over a target without being inside it (a plain
   * View lying over an Action) keeps the press from it.
   * @param {number} x @param {number} y
   */
  target(x, y) {
    const p = this.painter;
    const c = p.covers.find(x, y);
    if (c < 0) return -1;
    const hits = p.hits;
    for (let n = /** @type {Item | null} */ (p.covers.items[c]); n !== null; n = n.parent) {
      if (!(n.presses || n.kind === EDIT || n.kind === ACTION)) continue;
      // Its region under the point, else its last one (content past its box).
      let last = -1;
      for (let i = hits.n - 1; i >= 0; i--) {
        if (hits.items[i] !== n) continue;
        if (hits.inside(i, x, y)) return i;
        if (last < 0) last = i;
      }
      return last;
    }
    return -1;
  }

  /**
   * The View, Layout or Scroll with a `tabIndex` nearest around what is
   * drawn under a point, or null; an Edit or Action on the way up keeps the
   * press's focus its own.
   * @param {number} x @param {number} y
   */
  holder(x, y) {
    const p = this.painter;
    const c = p.covers.find(x, y);
    if (c < 0) return null;
    for (let n = /** @type {Item | null} */ (p.covers.items[c]); n !== null; n = n.parent) {
      if (n.kind === EDIT || n.kind === ACTION) return null;
      if (takes(n)) return n;
    }
    return null;
  }

  /**
   * `item`'s hit region under a point, else its last one, as an index, or
   * -1 when it has none (not drawn).
   * @param {Item} item @param {number} x @param {number} y
   */
  region(item, x, y) {
    const hits = this.painter.hits;
    let last = -1;
    for (let i = hits.n - 1; i >= 0; i--) {
      if (hits.items[i] !== item) continue;
      if (hits.inside(i, x, y)) return i;
      if (last < 0) last = i;
    }
    return last;
  }

  /**
   * The selectable text under a point, as its item and the offset nearest
   * the point; with `near`, the nearest text when none is under it (a drag
   * past the text). Null when there is none.
   * @param {number} x @param {number} y @param {boolean} near
   * @returns {[Item, number] | null}
   */
  textAt(x, y, near, under = false) {
    const texts = this.painter.texts;
    const b = texts.box;
    let found = -1;
    let best = Infinity;
    for (let i = texts.n - 1; i >= 0; i--) {
      const k = i * 6;
      if (texts.inside(i, x, y)) {
        found = i;
        break;
      }
      if (!near) continue;
      // Nearest: by rows first (above or below), then across (in the text's space).
      const px = texts.px;
      const py = texts.py;
      const dy = py < b[k + 1] ? b[k + 1] - py : py >= b[k + 3] ? py - b[k + 3] + 1 : 0;
      const dx = px < b[k] ? b[k] - px : px >= b[k + 2] ? px - b[k + 2] + 1 : 0;
      const d = dy * 100000 + dx;
      if (d < best) {
        best = d;
        found = i;
      }
    }
    if (found < 0) return null;
    const item = texts.items[found];
    const k = found * 6;
    texts.local(found, x, y);
    return [item, this.offset(item, texts.px - b[k + 4], texts.py - b[k + 5], under)];
  }

  /**
   * The offset in a Label's text nearest a point relative to its content
   * origin; with `under`, where the character under it starts (a word's, for
   * a double press), the nearest past its row's end.
   * @param {Item} item @param {number} dx @param {number} dy @param {boolean} [under]
   */
  offset(item, dx, dy, under = false) {
    const rows = item.rows;
    const starts = item.starts;
    if (rows === null || starts === null || rows.length === 0) return 0;
    const r = item.r;
    if (dy < 0) return 0;
    if (item.tops !== null ? dy >= item.tops[rows.length] : dy >= rows.length * line(r)) return item.text.length;
    const row = rowAt(item, dy);
    const m = measureOf(item, this.fonts);
    // With runs, a row's text less its ellipsis: an offset of the text.
    const text = item.cuts === null ? rows[row] : rows[row].slice(0, item.cuts[row]);
    const width = item.w - r.bL - r.bR - r.pl - r.pr;
    const advance = r.textAlign === 0 ? 0 : rowWidth(item, m, row);
    const left = r.textAlign === 1 ? (width - advance) / 2 : r.textAlign === 2 ? width - advance : 0;
    const shown = rowMeasure(item, m, row);
    const hit = under ? Under(shown, text, starts[row], dx - left, dirOf(item, row)) : -1;
    return textAt(item, row, hit >= 0 ? hit : Nearest(shown, text, starts[row], dx - left, dirOf(item, row)));
  }

  /**
   * The run of a Label's text under a point (its runs' `onPress`), where the
   * Label under it was last drawn, and the Label; null for none.
   * @param {number} x @param {number} y
   * @returns {[import('./scene.js').Span, Item] | null}
   */
  runAt(x, y) {
    const covers = this.painter.covers;
    const c = covers.find(x, y);
    if (c < 0) return null;
    const item = covers.items[c];
    const spans = item.spans;
    const rows = item.rows;
    if (spans === null || rows === null || item.starts === null || item.cuts === null || item.tops === null) return null;
    const r = item.r;
    covers.local(c, x, y);
    // From its content origin: the region's is its border box's.
    const dx = covers.px - covers.box[c * 6 + 4] - r.bL - r.pl;
    const dy = covers.py - covers.box[c * 6 + 5] - r.bT - r.pt;
    if (dy < 0 || dy >= item.tops[rows.length]) return null;
    const row = rowAt(item, dy);
    const m = measureOf(item, this.fonts);
    const width = item.w - r.bL - r.bR - r.pl - r.pr;
    const advance = rowWidth(item, m, row);
    const left = r.textAlign === 1 ? (width - advance) / 2 : r.textAlign === 2 ? width - advance : 0;
    const at = item.starts[row];
    const under = Under(rowMeasure(item, m, row), rows[row].slice(0, item.cuts[row]), at, dx - left, dirOf(item, row));
    if (under < 0) return null;
    const offset = textAt(item, row, under);
    for (let k = 0; k < spans.length; k++) if (spans[k].start <= offset && offset < spans[k].end) return [spans[k], item];
    return null;
  }

  /**
   * Selects the text from an offset in one item to an offset in another
   * (either way round, in document order), across the selectable text
   * between them.
   * @param {Item} anchor @param {number} from @param {Item} focus @param {number} to
   */
  selectText(anchor, from, focus, to) {
    this.anchorItem = anchor;
    this.anchorAt = from;
    this.focusItem = focus;
    this.focusAt = to;
    // The items from the first end to the last, in document order.
    const order = /** @type {Item[]} */ ([]);
    texts(this.root, order);
    texts(this.overlay, order);
    let a = order.indexOf(anchor);
    let f = order.indexOf(focus);
    let fromAt = from;
    let toAt = to;
    if (a > f || (a === f && from > to)) {
      [a, f] = [f, a];
      [fromAt, toAt] = [toAt, fromAt];
    }
    const next = a < 0 || f < 0 ? [] : order.slice(a, f + 1);
    // A collapsed selection (a click in text) draws nothing.
    const collapsed = next.length === 1 && fromAt === toAt;
    for (const item of this.selected) if (!next.includes(item)) this.range(item, -1, -1);
    for (let i = 0; i < next.length; i++) {
      const item = next[i];
      if (collapsed) this.range(item, -1, -1);
      else this.range(item, i === 0 ? fromAt : 0, i === next.length - 1 ? toAt : item.text.length);
    }
    this.selected = next;
  }

  /** Sets an item's selected range. @param {Item} item @param {number} from @param {number} to */
  range(item, from, to) {
    if (item.from === from && item.to === to) return;
    item.from = from;
    item.to = to;
    this.damage = true;
  }

  /** Clears the text selection. */
  unselect() {
    for (const item of this.selected) this.range(item, -1, -1);
    this.selected = [];
    this.anchorItem = this.focusItem = null;
  }

  /** Drops the removed items from the text selection (as a DOM range leaves removed nodes), and an end that was one; hidden ones stay. */
  unselectRemoved() {
    const inPage = (/** @type {Item} */ item) => {
      let n = item;
      while (n.parent !== null) n = n.parent;
      return n === this.root || n === this.overlay;
    };
    const kept = this.selected.filter(inPage);
    if (kept.length === this.selected.length) return;
    for (const item of this.selected) if (!kept.includes(item)) this.range(item, -1, -1);
    this.selected = kept;
    if (this.anchorItem !== null && !kept.includes(this.anchorItem)) this.anchorItem = null;
    if (this.focusItem !== null && !kept.includes(this.focusItem)) this.focusItem = null;
  }

  /**
   * Selects all: the focused Edit's value, else all the selectable text of
   * the page; with the behavior's `selectAll` off, all the text of the
   * `select: 'text'` element the selection (or the focus) is in, else
   * nothing. Returns whether it selected.
   */
  selectAll() {
    this.present();
    const item = this.current;
    if (item !== null && item.kind === EDIT) {
      this.select(0, item.draft.length);
      return true;
    }
    const order = /** @type {Item[]} */ ([]);
    if (this.behavior.selectAll) texts(this.root, order);
    else {
      const at = this.anchorItem ?? item;
      const region = at === null ? null : regionOf(at);
      if (region === null) return false;
      if (region.kind === LABEL || region.kind === TEXT) {
        if (region.r.select && region.rows !== null && !region.hidden) order.push(region);
      } else texts(region, order);
    }
    if (order.length === 0) return false;
    const last = /** @type {Item} */ (order.at(-1));
    this.selectText(order[0], 0, last, last.text.length);
    this.present();
    return true;
  }

  /** The selected text: the focused Edit's selection, else the text selection, a line break between items (as browsers copy blocks). */
  copied() {
    const item = this.current;
    if (item !== null && item.kind === EDIT) return item.secret ? '' : item.draft.slice(Math.min(this.anchor, this.caret), Math.max(this.anchor, this.caret));
    let out = '';
    for (let i = 0; i < this.selected.length; i++) {
      const s = this.selected[i];
      if (s.from < 0) continue;
      if (out !== '') out += '\n';
      out += s.text.slice(s.from, s.to);
    }
    return out;
  }

  /**
   * Turns a state bit on or off for `item` and, when `up`, its ancestors (as
   * CSS's :hover and :active apply to them); an item whose style styles
   * that state lays out again.
   * @param {Item | null} item @param {number} bit HOVER, PRESS or FOCUS @param {boolean} on @param {boolean} up
   */
  states(item, bit, on, up) {
    for (let n = item; n !== null; n = up ? n.parent : null) {
      const had = (n.state & bit) !== 0;
      if (had === on) continue;
      n.state = on ? n.state | bit : n.state & ~bit;
      const s = n.style;
      if ((bit === HOVER ? s.hover : bit === PRESS ? s.press : s.focus) !== null) {
        touch(n);
        this.damage = true;
      }
    }
  }

  /** Moves the pressed state to `item` (null: none). @param {Item | null} item */
  pressing(item) {
    if (this.pressed === item) return;
    if (this.pressed !== null) this.states(this.pressed, PRESS, false, true);
    this.pressed = item;
    if (item !== null) this.states(item, PRESS, true, true);
  }

  /**
   * The pointer moved to a logical point (no button, or dragging): the item
   * under it, and its ancestors, are hovered. Returns whether anything is.
   * @param {number} x @param {number} y @param {PointerInfo} [info]
   */
  move(x, y, info = PLAIN_POINTER) {
    this.present();
    this.pointer('pointermove', x, y, info, this.grabbed);
    if (this.dragging === 1) {
      // Dragging in an Edit selects from where the press put the caret.
      const item = this.current;
      const hits = this.painter.hits;
      for (let i = hits.n - 1; i >= 0 && item !== null; i--)
        if (hits.items[i] === item) {
          hits.local(i, x, y);
          this.select(this.anchor, this.place(item, hits.px - hits.box[i * 6 + 4], hits.py - hits.box[i * 6 + 5]));
          break;
        }
    } else if (this.dragging === 2 && this.anchorItem !== null) {
      const at = this.textAt(x, y, true);
      if (at !== null) {
        this.selectText(this.anchorItem, this.anchorAt, at[0], at[1]);
        this.present();
      }
    }
    const hits = this.painter.hits;
    const i = hits.find(x, y);
    const item = i < 0 ? null : hits.items[i];
    if (item !== this.hovered) {
      const old = this.hovered;
      if (old !== null) this.states(old, HOVER, false, true);
      this.hovered = item;
      if (item !== null) this.states(item, HOVER, true, true);
      this.crossed(old, item, x, y, info);
      this.present();
    }
    // Each move: a style may have changed its cursor under a still item.
    this.pointerX = x;
    this.pointerY = y;
    this.cursor = this.cursorAt(item, x, y);
    return item !== null;
  }

  /**
   * The cursor at the point the pointer last moved to, found again after a
   * frame: what the frame drew under a still pointer (a panel opened there,
   * an item restyled or pressed) shows its own, as the DOM's does.
   */
  aim() {
    const hits = this.painter.hits;
    const i = hits.find(this.pointerX, this.pointerY);
    const cursor = this.cursorAt(i < 0 ? null : hits.items[i], this.pointerX, this.pointerY);
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.aimed?.();
  }

  /**
   * The cursor at a point over its pointer target (null: none): over
   * selectable text inside that target that shows the I-beam (any, with the
   * behavior's `textCursor`; else only a `select: 'text'` element's), text
   * unless a style there names its own; else the target's.
   * @param {Item | null} item @param {number} x @param {number} y
   */
  cursorAt(item, x, y) {
    const texts = this.painter.texts;
    const t = texts.n === 0 ? -1 : texts.find(x, y);
    if (t >= 0) {
      const text = texts.items[t];
      if ((this.behavior.textCursor || regionOf(text) !== null) && (item === null || within(text, item))) return cursorOf(text, 'text');
    }
    return cursorOf(item);
  }

  /**
   * The platform took the pressed pointer back (a touch it pans or zooms
   * with, a native drag, the system): `pointercancel` goes to the item that
   * holds the pointer (captured), else to the one under where the pointer
   * last was, and bubbles; the press ends with no `pointerup`, as the DOM's.
   * @param {number} x @param {number} y where the pointer last was @param {PointerInfo} [info]
   */
  cancel(x, y, info = PLAIN_POINTER) {
    this.present();
    this.pointer('pointercancel', x, y, info, this.grabbed);
    this.grabbed = null;
    this.dragging = 0;
    this.pressing(null);
    this.present();
  }

  /**
   * The pans and zoom a touch pressed at a point leaves to the platform, as
   * CSS's touch-action finds them: the bits (1 pan-x, 2 pan-y, 4
   * pinch-zoom) the topmost item drawn there and each ancestor that sets a
   * `touchAction` allow together, or -1 when none sets one.
   * @param {number} x @param {number} y
   */
  touchAction(x, y) {
    this.present();
    const covers = this.painter.covers;
    const c = covers.find(x, y);
    let bits = -1;
    for (let n = c < 0 ? null : covers.items[c]; n !== null; n = n.parent) {
      const own = n.r.touch;
      if (own >= 0) bits = bits < 0 ? own : bits & own;
    }
    return bits;
  }

  /** The pointer button came up: nothing is pressed any more. @param {number} [x] @param {number} [y] @param {PointerInfo} [info] */
  release(x, y, info = PLAIN_POINTER) {
    if (x !== undefined && y !== undefined) this.pointer('pointerup', x, y, info, this.grabbed);
    this.grabbed = null;
    this.dragging = 0;
    this.pressing(null);
    this.present();
  }

  /**
   * An item's own `focus()` and `blur()`: keyboard focus, with the ring
   * when the last input was a key and not the pointer (a roving focus moved
   * by the arrow keys), as Chrome's :focus-visible takes a script's focus.
   * An item that cannot take the focus (not an Edit,
   * an Action or a View, Layout or Scroll with a `tabIndex`; hidden, inert
   * or not in the page) leaves it where it is, as Chrome's focus() of an
   * element that is not focusable.
   * @param {Item | null} item
   */
  take(item) {
    if (item !== null && (!takes(item) || !this.attached(item))) return;
    this.focus(item, this.keyed);
    this.present();
  }

  /**
   * Focuses the first (or last) item Tab reaches inside `item`, in document
   * order (an item's `focusFirst`, `focusLast`): an Edit or Action not
   * hidden, disabled, inert or out of the Tab order (`tabIndex` -1), or a
   * View, Layout or Scroll with a `tabIndex` of 0 or more; returns whether
   * one took the focus.
   * @param {Item} item @param {boolean} last
   */
  within(item, last) {
    if (!this.attached(item) || inertAt(item)) return false;
    /** @type {Item[]} */
    const order = [];
    inputs(item, order, NO_SEEK);
    if (order.length === 0) return false;
    const next = order[last ? order.length - 1 : 0];
    this.focus(next, this.keyed);
    this.present();
    return this.current === next;
  }

  /**
   * A Scroll moved: the root's `scrolls` (ren-core's `$scrolls`: a popup
   * following its target), as a document's capture-phase listener hears
   * every scroll first, then its own `scroll` handlers, each with its own
   * event. @param {Item} item
   */
  scrolled(item) {
    if (this.root.events !== null) this.emit(this.root, 'scrolls', new Scrolled(item));
    this.emit(item, 'scroll', new Scrolled(item));
  }

  /**
   * A Scroll's `scrollTop` or `scrollLeft` set: scrolls it, clamped to its
   * content, and sends `scroll`. A value that is not a finite number (NaN, a
   * string that reads as none, Infinity) scrolls to 0, as the DOM's does.
   * @param {Item} item @param {number} top @param {number} [left] across (a Scroll with an axis across): its `scrollLeft`, below 0 right to left
   */
  scrollTo(item, top, left = item.scrollLeft) {
    top = finite(top);
    left = finite(left);
    this.present();
    const next = Math.max(0, Math.min(Math.max(0, item.content - item.clientHeight), top));
    const across = item.axis === 0 ? 0 : Math.max(0, Math.min(Math.max(0, item.contentW - item.clientWidth), item.r.dir === 1 ? -left : left));
    if (next === item.offset && across === item.offsetX) return;
    item.offset = next;
    item.offsetX = across;
    this.damage = true;
    this.scrolled(item);
    this.present();
  }

  /**
   * The pointer went from under one item to under another: as the DOM's
   * pointerleave and pointerenter, each item it left (deepest first) and
   * each it entered (outermost first) hears it; neither bubbles.
   * @param {Item | null} from @param {Item | null} to @param {number} x @param {number} y @param {PointerInfo} info
   */
  crossed(from, to, x, y, info) {
    if (this.pointing === 0) return;
    /** @type {Item[]} */
    const before = [];
    for (let n = from; n !== null; n = n.parent) before.push(n);
    /** @type {Item[]} */
    const after = [];
    for (let n = to; n !== null; n = n.parent) after.push(n);
    for (const n of before) if (n.pointers && !after.includes(n)) this.emit(n, 'pointerleave', new Pointer('pointerleave', x, y, n, NaN, NaN, info));
    for (let k = after.length - 1; k >= 0; k--) {
      const n = after[k];
      if (n.pointers && !before.includes(n)) this.emit(n, 'pointerenter', new Pointer('pointerenter', x, y, n, NaN, NaN, info));
    }
  }

  /** The pointer left the surface: nothing is hovered or pressed. */
  leave() {
    this.pointerX = this.pointerY = NaN;
    if (this.hovered !== null) this.states(this.hovered, HOVER, false, true);
    this.crossed(this.hovered, null, NaN, NaN, PLAIN_POINTER);
    this.hovered = null;
    this.pressing(null);
    this.present();
  }

  /**
   * The caret position under a point relative to an edit's text origin,
   * measured as it is drawn (through its runs while they match its value),
   * at a cluster's edge; with `under`, where the character under the point
   * starts (the nearest past its row's end).
   * @param {Item} item @param {number} dx @param {number} dy @param {boolean} [under]
   */
  place(item, dx, dy, under = false) {
    const value = shown(item);
    const r = item.r;
    const m = measureOf(item, this.fonts);
    // A place inside a cluster (क्ष, 👨‍👩‍👧; a secret one's bullets, a pair of the value) goes to its nearer edge.
    const whole = (/** @type {string} */ text, /** @type {number} */ start, /** @type {number} */ at) => {
      let from = at;
      let to = at;
      if (item.secret) {
        if (!inside(item.draft, start + at)) return start + at;
        from = at - 1;
        to = at + 1;
      } else if (GRAPHEMES !== null && at > 0 && at < text.length) {
        const s = GRAPHEMES.segment(text).containing(at);
        if (s === undefined || s.index === at) return start + at;
        from = s.index;
        to = s.index + s.segment.length;
      } else if (inside(text, at)) {
        from = at - 1;
        to = at + 1;
      } else return start + at;
      const before = Math.abs(xAt(m, text, start, from, r.dir) - dx);
      const after = Math.abs(xAt(m, text, start, to, r.dir) - dx);
      return start + (before <= after ? from : to);
    };
    const room = item.w - r.bL - r.bR - r.pl - r.pr;
    const rows = item.lines <= 1 ? [{ start: 0, text: value }] : Lines(m, value, room);
    const k = Math.max(0, Math.min(rows.length - 1, Math.floor(dy / line(r))));
    const row = rows[k];
    // From where the row starts, as it is drawn (`indent`).
    dx -= indent(r, m, row.text, row.start, room, item.lines <= 1 ? 0 : wraps(/** @type {import('./text.js').Row[]} */ (rows), k) ? 2 : 1);
    // With `under`, where the character under the point starts (a word's, for a double press).
    const hit = under ? Under(m, row.text, row.start, dx, r.dir) : -1;
    return hit >= 0 ? row.start + hit : whole(row.text, row.start, Nearest(m, row.text, row.start, dx, r.dir));
  }

  /**
   * A key pressed: Tab (Shift+Tab with `shift`) moves focus; the focused item
   * receives 'key' {key}; an Edit edits its value (sending 'change' {value})
   * and sends 'submit' {value} on Enter; an Action presses on Enter or Space.
   * A single character replaces the selection; Shift with an arrow, Home or
   * End extends it. While an IME composes, keys belong to it and nothing
   * happens. Returns whether the renderer acted on the key, so a host
   * cancels the browser's default only then.
   * @param {string} key a DOM-style key name ('a', 'Enter', 'Backspace', 'ArrowLeft', …)
   * @param {boolean} [shift]
   * @param {{ shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean }} [mods] the host event's modifiers, for key handlers
   */
  key(key, shift = false, mods = undefined) {
    this.keyed = true;
    this.present();
    if (this.from >= 0) return false;
    const item = this.current;
    // As the DOM's keydown: the focused item, then its ancestors, then the
    // root's handlers (`keys`: ren-core's $keys), as a document's listener
    // hears it last; with nothing focused, the root's alone.
    const e = new Key(key, mods ?? { shiftKey: shift });
    e.target = item;
    e.editable = item !== null && item.kind === EDIT;
    for (let n = /** @type {Item | null} */ (item); n !== null && !e.stopped; n = n.parent) {
      if (n.events === null) continue;
      e.currentTarget = n;
      this.emit(n, 'key', e);
    }
    if (!e.stopped && this.root.events !== null) {
      e.currentTarget = this.root;
      this.emit(this.root, 'keys', e);
    }
    // A chord (Ctrl, Cmd or Alt with a character) is the handlers' and the platform's (copy, a shortcut): no editing.
    if (e.defaultPrevented || ((e.ctrlKey || e.metaKey || e.altKey) && single(key))) {
      this.present();
      return e.defaultPrevented;
    }
    // A modifier with a caret or deletion key (a word or line move, a word
    // deletion) is the native entry's: it edits the textarea, which mirrors
    // back. Without one (a Document alone, a worker's), the plain key's move
    // stands in, so the chord still does something.
    if (item !== null && item.kind === EDIT && this.entry !== null && (e.ctrlKey || e.metaKey || e.altKey) && NATIVE.has(key)) {
      this.present();
      return false;
    }
    if (key === 'Tab') {
      this.tab(shift);
      this.present();
      return true;
    }
    if (item === null) return false;
    if (this.current !== item) {
      this.present();
      return true;
    }
    let handled = true;
    if (item.kind === EDIT && !editable(item) && (key === 'Backspace' || key === 'Delete' || (key === 'Enter' && item.lines > 1) || single(key))) {
      // Read-only: the keys that would edit do nothing (their default is kept from the native entry too).
    } else if (item.kind === EDIT) {
      const value = item.draft;
      const caret = Math.min(value.length, this.caret);
      const anchor = Math.min(value.length, this.anchor);
      const start = Math.min(caret, anchor);
      const end = Math.max(caret, anchor);
      switch (key) {
        case 'Enter':
          if (item.lines > 1) this.change(item, value.slice(0, start) + '\n' + value.slice(end), start + 1);
          else this.emit(item, 'submit', new Change(value));
          break;
        case 'Backspace':
          if (start < end) this.change(item, value.slice(0, start) + value.slice(end), start);
          else if (caret > 0) {
            const from = caret - erase(value, caret);
            this.change(item, value.slice(0, from) + value.slice(caret), from);
          }
          break;
        case 'Delete':
          if (start < end) this.change(item, value.slice(0, start) + value.slice(end), start);
          else if (caret < value.length) this.change(item, value.slice(0, caret) + value.slice(caret + step(value, caret, 1)), caret);
          break;
        // Back and on in the value's order, the way its direction runs: right to left, the left arrow goes on.
        case 'ArrowLeft':
        case 'ArrowRight':
          if ((key === 'ArrowLeft') !== (item.r.dir === 1)) this.select(shift ? anchor : -1, !shift && start < end ? start : caret - step(value, caret, -1));
          else this.select(shift ? anchor : -1, !shift && start < end ? end : caret + step(value, caret, 1));
          break;
        // A multi-line Edit's rows as drawn (wrapped): up or down a row, at the same x as the last such move
        // began, as a textarea's; past the first or last row, its start or end. A one-line Edit's are the platform's.
        case 'ArrowUp':
        case 'ArrowDown': {
          if (item.lines <= 1) {
            handled = false;
            break;
          }
          const [next, up] = this.vertical(item, caret, key === 'ArrowUp' ? -1 : 1);
          const x = /** @type {{ x: number }} */ (this.goal).x;
          // A selection's moving end is at the next row's start, as a textarea keeps it.
          this.select(shift ? anchor : -1, next, up && !shift);
          this.goal = { item, caret: this.caret, x };
          break;
        }
        // A multi-line Edit's Home and End go to the start and end of the caret's drawn row, as a textarea's:
        // the end of a row that wraps is the next row's start, shown at this row's end.
        case 'Home':
        case 'End': {
          if (item.lines <= 1) {
            this.select(shift ? anchor : -1, key === 'Home' ? 0 : value.length);
            break;
          }
          const rows = this.rows(item);
          const row = Seek(rows, caret, this.upstreamAt(item, caret));
          const soft = key === 'End' && wraps(rows, row);
          // A selection's end at a row's end stays there too (a second Shift+End keeps it), as a textarea's.
          this.select(shift ? anchor : -1, key === 'Home' ? rows[row].start : soft ? rows[row + 1].start : rows[row].start + rows[row].text.length, soft);
          break;
        }
        default:
          if (single(key)) this.change(item, value.slice(0, start) + key + value.slice(end), start + key.length);
          else handled = false;
      }
    } else if (item.kind === ACTION && (key === 'Enter' || key === ' ')) this.activate(item, this.center(item));
    else handled = false;
    this.present();
    return handled;
  }

  /**
   * Where the caret goes a row up (`dir` -1) or down (1) from `caret` in a
   * multi-line Edit's drawn rows: the offset nearest the goal x (where the
   * caret was when the run of vertical moves began), the value's start or
   * end past its first or last row. Sets `goal` to that x. Returns the
   * offset, and whether it shows at the end of the row it came to (at a
   * soft wrap, where the next row starts).
   * @param {Item} item @param {number} caret @param {number} dir
   * @returns {[number, boolean]}
   */
  vertical(item, caret, dir) {
    const r = item.r;
    const value = shown(item);
    const m = measureOf(item, this.fonts);
    const rows = this.rows(item);
    const row = Seek(rows, caret, this.upstreamAt(item, caret));
    // The caret's x in whole pixels, as a browser takes it for a move up or down, within the text box
    // (on spaces hanging past it, at its edge).
    const room = item.w - r.bL - r.bR - r.pl - r.pr;
    const x = this.goal !== null && this.goal.item === item && this.goal.caret === caret ? this.goal.x : Math.floor(Math.max(0, Math.min(room, indent(r, m, rows[row].text, rows[row].start, room, wraps(rows, row) ? 2 : 1) + xAt(m, rows[row].text, rows[row].start, caret - rows[row].start, r.dir))));
    this.goal = { item, caret, x };
    const to = row + dir;
    if (to < 0) return [0, false];
    if (to >= rows.length) return [value.length, false];
    const at = this.place(item, x, (to + 0.5) * line(r));
    // At the row's end, where the next row starts after a soft wrap: shown at this row's end.
    return [at, to + 1 < rows.length && at === rows[to + 1].start && wraps(rows, to)];
  }

  /**
   * Scrolls a multi-line Edit's rows (its `offset`, its scrollTop) so the
   * caret's row shows, as a textarea does: the caret spans the font's box,
   * centered in its line, and the field scrolls the least that shows it,
   * in whole pixels, never past its rows.
   * @param {Item} item
   */
  reveal(item) {
    const r = item.r;
    const height = line(r);
    const rows = this.rows(item);
    const row = Seek(rows, this.caret, this.upstreamAt(item, this.caret));
    const box = Math.max(0, item.h - r.bT - r.bB - r.pt - r.pb);
    const { ascent, descent } = this.fonts.metrics(r.size);
    const extent = Math.min(height, ascent + descent);
    const top = row * height + (height - extent) / 2;
    let offset = item.offset;
    if (top + extent > offset + box) offset = Math.floor(top + extent - box);
    if (top < offset) offset = Math.floor(top);
    offset = Math.max(0, Math.min(offset, rows.length * height - box));
    item.offset = offset;
  }

  /** A multi-line Edit's rows as drawn: its shown value wrapped in its text box. @param {Item} item */
  rows(item) {
    const r = item.r;
    return Lines(measureOf(item, this.fonts), shown(item), item.w - r.bL - r.bR - r.pl - r.pr);
  }

  /**
   * A multi-line Edit's caret row and row count (an item's `caretRow()`), as
   * it draws them now: laid out first.
   * @param {Item} item
   * @returns {{ row: number, rows: number }}
   */
  caretRow(item) {
    this.present();
    const rows = this.rows(item);
    const caret = item.ends()[1];
    return { row: Seek(rows, caret, this.upstreamAt(item, caret)), rows: rows.length };
  }

  /** Whether the caret at `caret` in `item` shows at the end of the row before (`upstream`). @param {Item} item @param {number} caret */
  upstreamAt(item, caret) {
    const u = this.upstream;
    return u !== null && u.item === item && u.caret === caret && this.caret === caret;
  }

  /** Inserts text at the caret of the focused Edit, replacing the selection. Returns whether there is one. @param {string} text */
  type(text) {
    this.present();
    const item = this.current;
    if (item === null || item.kind !== EDIT) return false;
    if (!editable(item)) return true;
    if (this.from >= 0) this.commit(this.preedit);
    const value = item.draft;
    const start = Math.min(value.length, this.caret, this.anchor);
    const end = Math.min(value.length, Math.max(this.caret, this.anchor));
    this.change(item, value.slice(0, start) + text + value.slice(end), start + text.length);
    this.present();
    return true;
  }

  /**
   * Selects from `anchor` to `caret` in the focused Edit (clamped to its
   * draft); an anchor of -1 collapses the selection at the caret. With
   * `upstream`, a collapsed caret at a soft wrap shows at the end of the
   * row before it (a move up, down or to a row's end). Returns whether
   * there is a focused Edit.
   * @param {number} anchor @param {number} caret @param {boolean} [upstream]
   */
  select(anchor, caret, upstream = false) {
    const item = this.current;
    if (item === null || item.kind !== EDIT) return false;
    const length = item.draft.length;
    const next = Math.max(0, Math.min(length, caret));
    const fixed = anchor < 0 ? next : Math.max(0, Math.min(length, anchor));
    // A move of any other kind: the next vertical one starts from the caret's own x (a vertical one sets both again).
    const was = this.upstreamAt(item, this.caret);
    this.upstream = upstream ? { item, caret: next } : null;
    this.goal = null;
    if (upstream !== was) this.damage = true;
    if (next !== this.caret || fixed !== this.anchor) {
      this.caret = next;
      this.anchor = fixed;
      this.damage = true;
      this.present();
    }
    return true;
  }

  /** True while an IME composition is open in the focused Edit. */
  get composing() {
    return this.from >= 0;
  }

  /**
   * An IME composition's current text (compositionstart, compositionupdate):
   * the first call replaces the selection, and each call replaces the
   * previous text. The draft shows it, underlined, with the caret at its end;
   * nothing is sent until `commit`. Returns whether there is a focused Edit.
   * @param {string} text
   */
  compose(text) {
    this.present();
    const item = this.current;
    if (item === null || item.kind !== EDIT) return false;
    if (!editable(item)) return true;
    if (this.from < 0) {
      const value = item.draft;
      this.base = value;
      this.from = Math.min(value.length, this.caret, this.anchor);
      this.cut = Math.min(value.length, Math.max(this.caret, this.anchor));
    }
    this.preedit = text;
    item.draft = this.base.slice(0, this.from) + text + this.base.slice(this.cut);
    if (item.autosize !== 0 || item.dir === 2) touch(item);
    if (this.mirror !== null) this.mirror.note(item);
    this.caret = this.anchor = this.from + text.length;
    this.goal = null;
    this.upstream = null;
    this.damage = true;
    this.present();
    return true;
  }

  /**
   * Ends a composition with its final text (compositionend) and sends one
   * 'change' when the value changed; without a composition it inserts `text`
   * as `type` does. Returns whether there is a focused Edit.
   * @param {string} text
   */
  commit(text) {
    const item = this.current;
    if (item === null || item.kind !== EDIT) return false;
    if (this.from < 0) return this.type(text);
    const base = this.base;
    const value = base.slice(0, this.from) + text + base.slice(this.cut);
    const caret = this.from + text.length;
    this.from = -1;
    this.preedit = '';
    this.base = '';
    if (value !== base) this.change(item, value, caret);
    else {
      item.draft = value;
      if (this.mirror !== null) this.mirror.note(item);
      this.caret = this.anchor = caret;
      this.damage = true;
    }
    this.present();
    return true;
  }

  /**
   * The whole value and selection of a native text entry after it edited
   * itself (an input event: virtual keyboards, paste, spell check, the
   * platform's own editing keys). A different value is a change; the same
   * value only moves the selection. Returns whether there is a focused Edit.
   * @param {string} value @param {number} anchor @param {number} caret
   */
  input(value, anchor, caret) {
    const item = this.current;
    if (item === null || item.kind !== EDIT) return false;
    if (item.lines <= 1 && /[\r\n]/.test(value)) {
      // A one-line Edit takes no line break (a paste of lines), as HTML's input strips them: the ends shift with it.
      const kept = (/** @type {number} */ at) => value.slice(0, at).replace(/[\r\n]/g, '').length;
      anchor = kept(anchor);
      caret = kept(caret);
      value = value.replace(/[\r\n]/g, '');
    }
    if (this.from >= 0) return this.compose(value.slice(this.from, value.length - (this.base.length - this.cut)));
    if (value !== item.draft && !editable(item)) {
      // The native entry edited a read-only Edit: it shows the value again (at the next frame).
      this.damage = true;
      this.select(anchor, caret);
    } else if (value !== item.draft) {
      this.change(item, value, caret);
      // The entry's own anchor, unless the view rewrote the value or placed the selection itself (a mask):
      // then its collapsed caret stands, as the DOM leaves it.
      if (item.draft === value && this.caret === caret && this.anchor === caret) this.anchor = Math.min(anchor, value.length);
    } else this.select(anchor, caret);
    this.present();
    return true;
  }

  /** The user changed an edit's value: shows it and sends 'change'. @param {Item} item @param {string} value @param {number} caret */
  change(item, value, caret) {
    item.draft = value;
    this.goal = null;
    this.upstream = null;
    // An Edit that grows with its lines lays out again, and one whose direction its value gives resolves again.
    if (item.autosize !== 0 || item.dir === 2) touch(item);
    if (this.mirror !== null) this.mirror.note(item);
    this.caret = this.anchor = caret;
    this.damage = true;
    this.emit(item, 'change', new Change(value));
    // The app may write a different value back.
    this.clamp(item.draft.length);
  }

  /** Abandons a composition without sending anything (its Edit left the scene). */
  drop() {
    this.from = -1;
    this.preedit = '';
    this.base = '';
  }

  /** Keeps the caret and anchor within a draft of `length`. @param {number} length */
  clamp(length) {
    if (this.caret > length) this.caret = length;
    if (this.anchor > length) this.anchor = length;
  }

  /** A press at the middle of an item's last hit region. @param {Item} item */
  center(item) {
    const hits = this.painter.hits;
    for (let i = hits.n - 1; i >= 0; i--)
      if (hits.items[i] === item) {
        const b = hits.box;
        return new Press((b[i * 6] + b[i * 6 + 2]) / 2, (b[i * 6 + 1] + b[i * 6 + 3]) / 2);
      }
    return new Press(0, 0);
  }

  /**
   * Moves focus to the next (or previous) item Tab reaches (`inputs`),
   * within the focus trap it is in (`trap`), as the DOM's order: those with
   * a `tabIndex` above 0 first, by it, then the rest in document order. From
   * an item out of that order (a region focused from code, `tabIndex` -1)
   * it goes on from where that item is in the document.
   * @param {boolean} back
   */
  tab(back) {
    /** @type {Item[]} */
    const order = [];
    // Inside a focus trap, its focusables only.
    /** @type {Item | null} */
    let trap = null;
    for (let n = this.current; n !== null && trap === null; n = n.parent) if (n.trap && !n.hidden) trap = n;
    const seek = new Seeking(this.current);
    if (trap !== null) inputs(trap, order, seek);
    else {
      inputs(this.root, order, seek);
      inputs(this.overlay, order, seek);
    }
    const n = order.length;
    if (n === 0) return;
    let next;
    const at = this.current === null ? -1 : order.indexOf(this.current);
    if (at < 0 && seek.mark >= 0) next = order[back ? (seek.mark + n - 1) % n : seek.mark % n];
    else {
      // Positive tab indexes first, ascending; the sort keeps document order among equals.
      const sorted = order.some(i => i.tabIndex > 0) ? order.slice().sort((a, b) => rank(a) - rank(b)) : order;
      const i = at < 0 ? -1 : sorted.indexOf(/** @type {Item} */ (this.current));
      next = sorted[i < 0 ? (back ? n - 1 : 0) : (i + (back ? n - 1 : 1)) % n];
    }
    this.focus(next, true);
  }

  /**
   * Scrolls the innermost Scroll under a point that can move by `dy`, or the
   * page. Returns whether anything scrolled.
   * @param {number} x @param {number} y @param {number} dy pixels @param {PointerInfo} [info] the host event (its own deltas and deltaMode reach handlers as they are) @param {number} [dx] pixels across (the event's deltaX by default; Shift turns dy across)
   */
  wheel(x, y, dy, info = PLAIN_POINTER, dx = info.deltaX ?? 0) {
    this.present();
    // Shift turns the wheel across, as browsers do.
    if (info.shiftKey === true && dx === 0) {
      dx = dy;
      dy = 0;
    }
    // A handler that prevents it keeps the scroll.
    const e = this.pointer('wheel', x, y, info.deltaY === undefined ? { ...info, deltaY: dy } : info);
    if (e !== null && e.defaultPrevented) return true;
    // The Scrolls around the topmost box under the pointer, innermost first,
    // as the DOM scrolls the element under it and its scroll ancestors: an
    // item over a Scroll without being in it keeps the wheel from it.
    /** @type {Item[]} */
    const around = [];
    const covers = this.painter.covers;
    const c = covers.find(x, y);
    if (c >= 0) {
      for (let n = /** @type {Item | null} */ (covers.items[c]); n !== null; n = n.parent) if (n.kind === SCROLL) around.push(n);
    } else {
      const regions = this.painter.regions;
      for (let i = regions.n - 1; i >= 0; i--) if (regions.inside(i, x, y)) around.push(regions.items[i]);
    }
    for (const item of around) {
      const next = item.axis === 1 ? item.offset : Math.max(0, Math.min(item.content - item.clientHeight, item.offset + dy));
      // Right to left, a move to the right goes back toward its start.
      const across = item.axis === 0 ? item.offsetX : Math.max(0, Math.min(item.contentW - item.clientWidth, item.offsetX + (item.r.dir === 1 ? -dx : dx)));
      if (next === item.offset && across === item.offsetX) continue;
      item.offset = next;
      item.offsetX = across;
      this.damage = true;
      this.scrolled(item);
      this.present();
      return true;
    }
    const next = Math.max(0, Math.min(this.limit, this.page + dy));
    if (next === this.page) return false;
    this.page = next;
    this.damage = true;
    if (this.root.events !== null) this.emit(this.root, 'scrolls', new Scrolled(this.root));
    this.present();
    return true;
  }
}

/** Grapheme clusters (a flag, a letter and its accents, an emoji joined by ZWJ), where the platform has them. */
const GRAPHEMES = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/**
 * The code units of the code point before (`dir` -1) or after (1) index
 * `at`: 2 across a surrogate pair, else 1.
 * @param {string} text @param {number} at @param {number} dir
 */
function point(text, at, dir) {
  if (dir < 0) {
    const c = text.charCodeAt(at - 1);
    return at >= 2 && c >= 0xdc00 && c <= 0xdfff && (text.charCodeAt(at - 2) & 0xfc00) === 0xd800 ? 2 : 1;
  }
  const c = text.charCodeAt(at);
  return (c & 0xfc00) === 0xd800 && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
}

/** The keys a modifier makes a native entry's own move or deletion. */
const NATIVE = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete', 'Home', 'End']);

/** How far around the caret, in code units, `step` reads clusters: a cluster reaching past it is read in the whole text. */
const REACH = 64;

/** Whether the code point ending at index `at` is a regional indicator (half of a flag). @param {string} text @param {number} at */
const regional = (text, at) => {
  const c = text.codePointAt(at - 2);
  return at >= 2 && c !== undefined && c >= 0x1f1e6 && c <= 0x1f1ff;
};

/**
 * The code units of the character a caret steps over before (`dir` -1) or
 * after (1) index `at`, as a browser's arrows and Delete: a grapheme
 * cluster whole (🇧🇷, e and its accent, 👨‍👩‍👧); a code point without
 * Intl.Segmenter. Only the text around the caret is segmented, so a key
 * costs the same in a long value: from REACH before it (back over a run of
 * flags' halves, which pair from their run's start) to REACH after it; a
 * cluster that reaches either end of that, or follows the first one there,
 * is found again in the whole text.
 * @param {string} text @param {number} at @param {number} dir
 */
function step(text, at, dir) {
  if (GRAPHEMES === null) return point(text, at, dir);
  const k = dir < 0 ? at - 1 : at;
  if (k < 0 || k >= text.length) return 1;
  let from = Math.max(0, k - REACH);
  if (from > 0 && low(text, from)) from--;
  while (from > 0 && regional(text, from)) from -= 2;
  let to = Math.min(text.length, k + REACH + 1);
  if (to < text.length && low(text, to)) to++;
  let base = from;
  const segments = GRAPHEMES.segment(text.slice(from, to));
  let s = segments.containing(k - from);
  // A window starting inside a cluster (at a virama or ZWJ of a long one) cuts
  // it into a first piece and a second: either may be wrong, so neither is trusted.
  const early = s !== undefined && from > 0 && (s.index === 0 || segments.containing(s.index - 1)?.index === 0);
  if (s === undefined || early || (to < text.length && s.index + s.segment.length === to - from)) {
    base = 0;
    s = GRAPHEMES.segment(text).containing(k);
  }
  if (s === undefined) return 1;
  return dir < 0 ? at - (base + s.index) : base + s.index + s.segment.length - at;
}

/**
 * A cluster Backspace takes whole: an emoji (with its modifiers, selectors
 * and joiners), a flag, a keycap. From any other (an accent apart, an Indic
 * conjunct, Hangul jamo) it takes the last code point, as Chrome does.
 */
const WHOLE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;

/**
 * The code units Backspace takes before index `at`, as a browser's: the
 * emoji, flag or keycap before it whole, else the code point before it
 * (é typed as e and an accent loses the accent first; क्ष loses its ष).
 * @param {string} text @param {number} at
 */
function erase(text, at) {
  const cluster = step(text, at, -1);
  return WHOLE.test(text.slice(at - cluster, at)) ? cluster : point(text, at, -1);
}

/** True for a key name that is one character (one code point). @param {string} key */
function single(key) {
  if (key.length === 1) return key.charCodeAt(0) >= 32;
  return key.length === 2 && key.codePointAt(0) !== undefined && /** @type {number} */ (key.codePointAt(0)) > 0xffff;
}

/** Collects the shown selectable text below `item` (Labels and text nodes), in order. @param {Item} item @param {Item[]} out */
function texts(item, out) {
  for (let c = item.first; c !== null; c = c.next) {
    if (c.hidden) continue;
    if ((c.kind === LABEL || c.kind === TEXT) && c.r.select && c.rows !== null) {
      // A text node in the run of the text before it is selected as part of that one.
      if (c.kind === LABEL || !follows(c)) out.push(c);
    }
    else if (c.kind !== EDIT && c.kind !== ACTION) texts(c, out);
  }
}

/**
 * A word character: a letter, a digit or an underscore, in any script, and
 * what extends one (Unicode's word rules): a combining mark (é as e and its
 * accent, an Indic vowel sign) and the zero-width joiners.
 */
const WORD = /[\p{L}\p{N}\p{M}_\u200c\u200d]/u;
/** What extends the character before it (a combining mark, a zero-width joiner), as Unicode's word rules skip it. */
const EXTEND = /[\p{M}\u200c\u200d]/u;

/** Whether a UTF-16 unit is the second half of a surrogate pair at `k` in `text`. @param {string} text @param {number} k */
const low = (text, k) => {
  const c = text.charCodeAt(k);
  const p = text.charCodeAt(k - 1);
  return c >= 0xdc00 && c <= 0xdfff && p >= 0xd800 && p <= 0xdbff;
};

/**
 * The word around an offset (or the run of other characters there), as
 * [from, to), in UTF-16 offsets that never split a surrogate pair: the
 * characters are read by code point, so a letter past the BMP (𝒜, 𠀀) is
 * a letter.
 * @param {string} text @param {number} at
 */
function word(text, at) {
  if (text.length === 0) return [0, 0];
  let i = Math.min(at, text.length - 1);
  if (low(text, i)) i--;
  /** The character starting at `k`, or '' out of the text. @param {number} k */
  const char = k => (k < 0 || k >= text.length ? '' : String.fromCodePoint(/** @type {number} */ (text.codePointAt(k))));
  /** Where the character before the one at `k` starts. @param {number} k */
  const back = k => (k >= 2 && low(text, k - 1) ? k - 2 : k - 1);
  /** A character that joins the word around it (Unicode's word rules): a point or comma between digits (218.41, 3,284), an apostrophe between letters (can't). @param {number} k */
  const inner = k => {
    const c = char(k);
    // The character before, past the marks and joiners that extend it (they belong to it: WB4).
    let j = k;
    while (j > 0 && EXTEND.test(char(back(j)))) j = back(j);
    const a = j > 0 ? char(back(j)) : '';
    const b = char(k + c.length);
    if (c === '.' || c === ',') return /[0-9]/.test(a) && /[0-9]/.test(b);
    if (c === "'" || c === '\u2019') return /\p{L}/u.test(a) && /\p{L}/u.test(b);
    return false;
  };
  // A press on a joiner (the point of 218.41, the apostrophe of can't) is in the word around it.
  const kind = WORD.test(char(i)) || inner(i);
  /** @param {number} k */
  const same = k => text[k] !== '\n' && (WORD.test(char(k)) === kind || (kind && inner(k)));
  let from = i;
  let to = i + char(i).length;
  while (from > 0 && same(back(from))) from = back(from);
  while (to < text.length && same(to)) to += char(to).length;
  return [from, to];
}

/** Where an item stands among the ones Tab reaches: how many come before it in document order (-1: not met). */
class Seeking {
  /** @param {Item | null} item */
  constructor(item) {
    this.item = item;
    this.mark = -1;
  }
}
const NO_SEEK = new Seeking(null);

/**
 * Collects the items Tab reaches below `item`, in document order: the
 * shown Edits and Actions, not disabled or out of the Tab order (`tabIndex`
 * -1), and the Views, Layouts and Scrolls with a `tabIndex` of 0 or more;
 * nothing in a hidden or inert region. Notes where `seek.item` stands.
 * @param {Item} item @param {Item[]} out @param {Seeking} seek
 */
function inputs(item, out, seek) {
  for (let c = item.first; c !== null; c = c.next) {
    if (c.hidden || c.inert) continue;
    if (c === seek.item) seek.mark = out.length;
    const k = c.kind;
    if (k === EDIT || k === ACTION) {
      if (!c.disabled && !(c.tabIndex < 0)) out.push(c);
    } else {
      if ((k === VIEW || k === LAYOUT || k === SCROLL) && c.tabIndex >= 0) out.push(c);
      inputs(c, out, seek);
    }
  }
}

/** An item's place in the Tab order: its positive tabIndex, every other after them. @param {Item} item */
const rank = item => (item.tabIndex > 0 ? item.tabIndex : Infinity);

/** Whether an item takes the focus: an Edit, an Action, or a View, Layout or Scroll with a `tabIndex`. @param {Item} item */
const takes = item => item.kind === EDIT || item.kind === ACTION || ((item.kind === VIEW || item.kind === LAYOUT || item.kind === SCROLL) && item.tabIndex === item.tabIndex);

/** Whether an item is in an inert region: its own `inert` or an ancestor's. @param {Item} item */
const inertAt = item => {
  for (let n = /** @type {Item | null} */ (item); n !== null; n = n.parent) if (n.inert) return true;
  return false;
};

/**
 * Renders `view()` into a document's page; returns the dispose function,
 * which removes the view and presents the empty page.
 * @param {() => any} view
 * @param {Document} target
 * @param {import('ren-core/host').Options} [options]
 * @returns {() => void}
 */
export function render(view, target, options) {
  const dispose = mount(target, view, target.root, options);
  return () => {
    dispose();
    target.present();
  };
}

/**
 * The browser events a canvas sends.
 * @typedef {object} Events
 * @property {(name: string, listener: (event: any) => void, options?: any) => void} addEventListener
 * @property {(name: string, listener: (event: any) => void) => void} removeEventListener
 * @property {number=} tabIndex
 * @property {(() => void)=} focus
 * @property {boolean=} isConnected
 * @property {(() => { left: number, top: number })=} getBoundingClientRect
 */

/**
 * Sets the CSS a behavior gives the element the user touches (the canvas):
 * no long-press callout or tap highlight without `callout`, and the element
 * itself not selectable without `select`. Returns the function that puts
 * back what was there.
 * @param {any} element @param {import('ren-core/host').Switches} behavior
 */
function dress(element, behavior) {
  const style = element?.style;
  if (style == null || typeof style.setProperty !== 'function') return () => {};
  /** @type {[string, string][]} */
  const set = [];
  if (!behavior.callout) set.push(['-webkit-touch-callout', 'none'], ['-webkit-tap-highlight-color', 'transparent']);
  if (!behavior.select) set.push(['user-select', 'none'], ['-webkit-user-select', 'none']);
  const was = set.map(([name]) => String(style.getPropertyValue(name) ?? ''));
  for (const [name, value] of set) style.setProperty(name, value);
  return () => {
    set.forEach(([name, value], i) => {
      if (style.getPropertyValue(name) !== value) return;
      if (was[i] === '') style.removeProperty(name);
      else style.setProperty(name, was[i]);
    });
  };
}

/**
 * Routes a canvas element's pointer, key and wheel events to a renderer;
 * returns the function that stops. In a document it also adds, beside the
 * canvas, the native text entry of the focused Edit (entry.js) and the
 * accessibility mirror (aria.js; see the `aria` option). The canvas takes
 * the CSS its behavior asks (no touch callout, not selectable itself) until
 * it stops.
 * With `input: false` it adds only the entry and the mirror: a host that
 * routes the canvas's input itself (ren-three, several pages on one canvas).
 * It keeps the renderer's `shiftX`/`shiftY` the canvas's place past the
 * device pixels a browser snaps it to, unless `shift: false` (a page drawn
 * elsewhere than over the canvas: a ren-three panel).
 * @param {Document} renderer
 * @param {Events} canvas
 * @param {{ input?: boolean, shift?: boolean }} [options]
 */
export function attach(renderer, canvas, options = {}) {
  const input = options.input !== false;
  if (input && (canvas.tabIndex === undefined || canvas.tabIndex < 0)) canvas.tabIndex = 0;
  /**
   * Where the pointer was last (a cancel reports 0, 0), whether its press
   * took it, and the pans and zoom the items under it leave to the page
   * (`touchAction`'s bits, -1 where none sets one): a touch keeps the page
   * from what they forbid.
   */
  let lastX = 0;
  let lastY = 0;
  let took = false;
  let allow = -1;
  /** A touch whose pan is decided by its first move (some pans allowed, not all), and where it started. */
  let pending = false;
  let startX = 0;
  let startY = 0;
  /** @param {{ offsetX: number, offsetY: number, button?: number, preventDefault(): void }} e */
  const down = e => {
    lastX = e.offsetX;
    lastY = e.offsetY;
    took = false;
    allow = /** @type {any} */ (e).pointerType === 'touch' ? renderer.touchAction(e.offsetX, e.offsetY) : -1;
    if (e.button !== undefined && e.button !== 0) {
      // Another button's press reaches the pointer handlers only (an app's context menu).
      took = renderer.secondary(e.offsetX, e.offsetY, /** @type {any} */ (e));
      return;
    }
    if (canvas.focus) canvas.focus();
    // A drag keeps the pointer past the canvas's edge, as a native drag does.
    try {
      /** @type {any} */ (canvas).setPointerCapture?.(/** @type {any} */ (e).pointerId);
    } catch {
      // A synthetic pointer may not be capturable.
    }
    took = renderer.press(e.offsetX, e.offsetY, /** @type {any} */ (e).detail || 1, /** @type {any} */ (e).shiftKey === true, /** @type {any} */ (e));
    if (took) e.preventDefault();
  };
  /**
   * A touch keeps the page from the pans and zoom the items under it
   * forbid (their `touchAction`, as CSS's touch-action): its touchstart,
   * after the pointerdown, is cancelled when they allow nothing; when they
   * allow some pans, its first move is, if it goes along a forbidden axis;
   * a second finger's, when they forbid a pinch zoom. Where none sets one,
   * a touch that pressed something (a slider, a selection, a handler) is
   * the app's and keeps the page from panning (which would cancel the
   * pointer); a touch on nothing lets the page scroll.
   * @param {{ cancelable?: boolean, touches?: ArrayLike<{ clientX: number, clientY: number }>, preventDefault(): void }} e
   */
  const touch = e => {
    pending = false;
    if (e.cancelable === false) return;
    const fingers = e.touches?.length ?? 1;
    if (allow < 0) {
      if (took) e.preventDefault();
    } else if (fingers > 1) {
      if ((allow & 4) === 0) e.preventDefault();
    } else if (allow === 0) e.preventDefault();
    else if ((allow & 3) !== 3) {
      pending = true;
      startX = e.touches?.[0]?.clientX ?? 0;
      startY = e.touches?.[0]?.clientY ?? 0;
    }
  };
  /** A touch's first move decides its pan: along an axis its items forbid, the page stays. @param {{ cancelable?: boolean, touches?: ArrayLike<{ clientX: number, clientY: number }>, preventDefault(): void }} e */
  const drag = e => {
    if (allow < 0 || e.cancelable === false) return;
    if ((e.touches?.length ?? 1) > 1) {
      if ((allow & 4) === 0) e.preventDefault();
      return;
    }
    if (!pending) return;
    const dx = Math.abs((e.touches?.[0]?.clientX ?? startX) - startX);
    const dy = Math.abs((e.touches?.[0]?.clientY ?? startY) - startY);
    if (dx === 0 && dy === 0) return;
    pending = false;
    if ((allow & (dx > dy ? 1 : 2)) === 0) e.preventDefault();
  };
  /** The browser took the pointer back (a pan, a zoom, a palm): the press ends where the pointer last was, with pointercancel. @param {any} e */
  const cancel = e => {
    took = false;
    pending = false;
    renderer.cancel(lastX, lastY, e);
  };
  /** @param {{ key: string, shiftKey: boolean, ctrlKey: boolean, metaKey: boolean, altKey: boolean, preventDefault(): void }} e */
  const key = e => {
    // Chords reach the handlers too (a launcher's Ctrl+K); unless one prevents it, Ctrl or Cmd+A selects all,
    // and, with the behavior's `selectAll` off, never the browser's page.
    if (renderer.key(e.key, e.shiftKey, e)) e.preventDefault();
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'a' || e.key === 'A') && (renderer.selectAll() || !renderer.behavior.selectAll)) e.preventDefault();
  };
  /** @param {{ offsetX: number, offsetY: number, deltaY: number, preventDefault(): void }} e */
  const wheel = e => {
    // Lines and pages (deltaMode 1 and 2) scroll as far as a browser scrolls them.
    const mode = /** @type {any} */ (e).deltaMode ?? 0;
    const line = renderer.theme.text * renderer.theme.leading;
    const dy = mode === 1 ? e.deltaY * line : mode === 2 ? e.deltaY * renderer.height : e.deltaY;
    const along = /** @type {any} */ (e).deltaX ?? 0;
    const dx = mode === 1 ? along * line : mode === 2 ? along * renderer.width : along;
    if (renderer.wheel(e.offsetX, e.offsetY, dy, /** @type {any} */ (e), dx)) e.preventDefault();
  };
  /** The hovered item's cursor, as the DOM shows an element's: after each move, and each frame that changes it. */
  const aimed = () => {
    const style = /** @type {any} */ (canvas).style;
    if (style != null && style.cursor !== renderer.cursor) style.cursor = renderer.cursor;
  };
  /** @param {{ offsetX: number, offsetY: number }} e */
  const move = e => {
    lastX = e.offsetX;
    lastY = e.offsetY;
    renderer.move(e.offsetX, e.offsetY, /** @type {any} */ (e));
    aimed();
  };
  /**
   * Files dragged over the canvas may drop (the drop decides who takes
   * them); the drag goes to the items under it with the file items' count
   * and MIME types, all a drag tells before the drop.
   * @param {any} e
   */
  const over = e => {
    e.preventDefault();
    const items = e.dataTransfer?.items;
    /** @type {string[]} */
    const types = [];
    if (items != null) for (const item of items) if (item.kind === 'file') types.push(item.type ?? '');
    renderer.dragOver(Number(e.offsetX), Number(e.offsetY), types.length, types);
  };
  const away = () => renderer.dragLeave();
  /** @param {any} e */
  const drop = e => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    renderer.dropFiles(e.offsetX, e.offsetY, files == null ? [] : [...files]);
  };
  /** @param {{ offsetX: number, offsetY: number }} e */
  const up = e => renderer.release(e.offsetX, e.offsetY, /** @type {any} */ (e));
  const out = () => renderer.leave();
  /** The browser's context menu opens only where the behavior keeps it, and the app shows none of its own (`prevent="contextmenu"`). @param {{ offsetX: number, offsetY: number, preventDefault(): void }} e */
  const menu = e => {
    if (!renderer.menu(e.offsetX, e.offsetY)) e.preventDefault();
  };
  const undress = input ? dress(canvas, renderer.behavior) : null;
  if (input) {
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    renderer.aimed = aimed;
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', out);
    canvas.addEventListener('contextmenu', menu);
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('touchstart', touch, { passive: false });
    canvas.addEventListener('touchmove', drag, { passive: false });
  }
  /** The platform's copy (Ctrl/Cmd+C, the menu) while the canvas has focus: the selected text. @param {any} e */
  const copy = e => {
    const text = renderer.copied();
    if (text === '' || e.clipboardData == null) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  };
  if (input) {
    canvas.addEventListener('keydown', key);
    canvas.addEventListener('copy', copy);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('dragenter', over);
    canvas.addEventListener('dragover', over);
    canvas.addEventListener('dragleave', away);
    canvas.addEventListener('drop', drop);
  }
  const document = /** @type {any} */ (canvas).ownerDocument;
  const dom = document != null && typeof document.createElement === 'function';
  const entry = dom && renderer.entry === null ? new Entry(renderer, canvas) : null;
  if (entry !== null) {
    renderer.entry = entry;
    entry.sync();
  }
  /** @type {Mirror | null} */
  let mirror = null;
  const mirrored = () => {
    if (renderer.mirror !== null) return;
    renderer.present();
    mirror = renderer.mirror = new Mirror(renderer, canvas);
    mirror.flush();
  };
  /** A hidden button right after the canvas that turns the mirror on. @type {any} */
  let enable = null;
  const demand = () => {
    if (enable !== null && enable.parentNode != null) enable.parentNode.removeChild(enable);
    enable = null;
    mirrored();
    // The focus moves into the mirror, not to the body: its first element (a
    // div) is focusable only with a tab index, one out of the Tab order.
    const first = mirror === null ? null : mirror.box.firstChild;
    if (first != null) {
      first.tabIndex = -1;
      first.focus?.();
    }
  };
  if (dom && renderer.mirror === null) {
    if (renderer.aria === true) mirrored();
    else if (renderer.aria === 'demand') {
      enable = document.createElement('button');
      enable.setAttribute('type', 'button');
      enable.setAttribute('data-ren-aria-enable', '');
      enable.setAttribute('style', HIDDEN);
      enable.textContent = 'Enable accessibility';
      enable.addEventListener('click', demand);
      const parent = /** @type {any} */ (canvas).parentNode ?? document.body;
      parent.insertBefore(enable, parent === /** @type {any} */ (canvas).parentNode ? /** @type {any} */ (canvas).nextSibling : null);
    }
  }
  // The canvas's place past the device pixels it is snapped to, measured
  // after a frame (once per animation frame) and when the window resizes or scrolls.
  const view = dom ? document.defaultView : null;
  let asked = false;
  let open = true;
  const locate = () => {
    asked = false;
    const measure = canvas.getBoundingClientRect;
    if (!open || canvas.isConnected === false || typeof measure !== 'function') return;
    const r = measure.call(canvas);
    const s = renderer.scale;
    renderer.shift(r.left - Math.round(r.left * s) / s, r.top - Math.round(r.top * s) / s);
  };
  const ask = () => {
    if (asked || typeof view?.requestAnimationFrame !== 'function') return;
    asked = true;
    view.requestAnimationFrame(locate); // timer: feature, one measurement a frame, after its layout
  };
  if (view != null && options.shift !== false) {
    renderer.framed = ask;
    view.addEventListener?.('resize', ask);
    document.addEventListener?.('scroll', ask, true);
    ask();
  }
  return () => {
    open = false;
    if (renderer.framed === ask) renderer.framed = null;
    view?.removeEventListener?.('resize', ask);
    document?.removeEventListener?.('scroll', ask, true);
    if (entry !== null) {
      entry.close();
      if (renderer.entry === entry) renderer.entry = null;
    }
    if (enable !== null) {
      enable.removeEventListener('click', demand);
      if (enable.parentNode != null) enable.parentNode.removeChild(enable);
      enable = null;
    }
    if (mirror !== null) {
      mirror.close();
      if (renderer.mirror === mirror) renderer.mirror = null;
      mirror = null;
    }
    undress?.();
    if (input) {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      if (renderer.aimed === aimed) renderer.aimed = null;
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointerleave', out);
      canvas.removeEventListener('contextmenu', menu);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('touchstart', touch);
      canvas.removeEventListener('touchmove', drag);
      canvas.removeEventListener('keydown', key);
      canvas.removeEventListener('copy', copy);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('dragenter', over);
      canvas.removeEventListener('dragover', over);
      canvas.removeEventListener('dragleave', away);
      canvas.removeEventListener('drop', drop);
    }
  };
}
