// The accessibility mirror of a canvas: assistive technology reads the DOM,
// and a canvas holds only pixels, so beside it lies a visually hidden DOM
// tree of the scene's accessible items: a div per container, the text of a
// Label, a button per Action (activating it presses the Action), a textbox per
// Edit (focusing it focuses the Edit, whose native entry then takes over), an
// img per Image, and a div per Shape the caller marked with a role (a
// loader's status). Other Shapes, markers and text nodes have no element; a
// Label's or Action's text children are its text, and an Action holding
// content is named by its label, else by the text it holds. The caller's
// meaning marks (ren-core's Meaning props: `role`, `aria-*` states and
// properties, `aria-hidden` on decoration, `id` and microdata) are written
// on each element as ren-dom writes them, and a container's `label` names
// it (`aria-label`), so a radio group reads as a radiogroup of radios.
//
// The mirror is incremental. Structure follows the renderer's own insert and
// remove calls one to one, so a keyed move is one DOM move; a new element
// gets its text while still detached; later text and state changes mark
// their item, and `present` writes only the marked items. Nothing walks the
// scene per frame.

import { VIEW, LAYOUT, SCROLL, LABEL, EDIT, ACTION, IMAGE, SHAPE, TEXT, Item, shown, caption, spoken } from './scene.js';

/** @typedef {import('./document.js').Document} Renderer */

/**
 * The mirror's box: off screen, 1 px and clipped, but in the accessibility
 * tree. No content-visibility: Chrome leaves the content of an off-screen
 * `content-visibility:auto` box out of its accessibility tree, which would
 * hide every mirrored item from assistive technology (the box would have no
 * children there). Chrome's layout of a large mirror costs more so; it is the cost of
 * being read at all.
 */
const BOX = 'position:absolute;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;white-space:nowrap';

/** Visually hidden, but in the accessibility tree and focusable (the enable button). */
export const HIDDEN = 'position:absolute;left:0;top:0;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap';

/** The element tag of each kind; '' for kinds without one (a Shape has one when marked: `tag`). */
const TAGS = ['div', 'div', 'div', 'p', 'div', 'button', 'div', '', '', ''];

/** The element tag of an item: its kind's, a div for a Shape with a role. @param {Item} item */
const tag = item => (item.kind === SHAPE && item.get('role') != null ? 'div' : TAGS[item.kind]);

/** The props written on an element as given (besides every `aria-*` one): the meaning marks. */
const MARKS = new Set(['role', 'id', 'itemscope', 'itemtype', 'itemprop', 'itemref', 'content', 'datetime']);

/** The marks last written on each element, to take away those no longer given. @type {WeakMap<any, string[]>} */
const WRITTEN = new WeakMap();

export class Mirror {
  /** @param {Renderer} renderer @param {any} canvas a canvas element in a document */
  constructor(renderer, canvas) {
    const document = canvas.ownerDocument;
    this.renderer = renderer;
    this.document = document;
    const box = document.createElement('div');
    box.setAttribute('data-ren-aria', '');
    box.setAttribute('style', BOX);
    this.box = box;
    /** Items whose text or state changed since the last flush. @type {Item[]} */
    this.queue = [];
    /** The item of each element. @type {WeakMap<any, Item>} */
    this.items = new WeakMap();
    /** @param {any} e */
    this.click = e => {
      const item = this.find(e.target);
      if (item === null || item.kind !== ACTION) return;
      renderer.focus(item);
      renderer.activate(item, renderer.center(item));
      renderer.present();
    };
    /** @param {any} e */
    this.focusin = e => {
      const item = this.find(e.target);
      if (item === null || item.kind !== EDIT || renderer.current === item) return;
      renderer.focus(item);
      renderer.present();
    };
    box.addEventListener('click', this.click);
    box.addEventListener('focusin', this.focusin);
    box.appendChild(this.make(renderer.root));
    box.appendChild(this.make(renderer.overlay));
    const parent = canvas.parentNode ?? document.body;
    parent.insertBefore(box, canvas.parentNode === parent ? canvas.nextSibling : null);
  }

  /** The item of an element, or of its nearest mirrored ancestor. @param {any} el */
  find(el) {
    for (let n = el; n != null && n !== this.box; n = n.parentNode) {
      const item = this.items.get(n);
      if (item !== undefined) return item;
    }
    return null;
  }

  /**
   * The element of `item`, made with its subtree's on first use. Null for
   * kinds without one.
   * @param {Item} item
   */
  make(item) {
    if (item.aria !== null) return item.aria;
    const name = tag(item);
    if (name === '') return null;
    const el = this.document.createElement(name);
    const kind = item.kind;
    if (kind === ACTION) {
      el.setAttribute('type', 'button');
      el.tabIndex = -1;
    } else if (kind === EDIT) {
      el.setAttribute('role', 'textbox');
      el.tabIndex = -1;
    } else if (kind === IMAGE) el.setAttribute('role', 'img');
    item.aria = el;
    this.items.set(el, item);
    if (kind === VIEW || kind === LAYOUT || kind === SCROLL)
      for (let c = item.first; c !== null; c = c.next) {
        const child = this.make(c);
        if (child !== null) el.appendChild(child);
      }
    // Written while the element is still detached, which is cheaper.
    write(item);
    return el;
  }

  /** Marks an item's text or state for the next flush. @param {Item} item */
  note(item) {
    // What an Action holds names it: its text changing renames the Action,
    // and so does any change to content with no element of its own (a
    // View's children or hidden state, however deep inside the Action).
    if (item.aria === null || item.kind === LABEL || item.kind === TEXT)
      for (let p = item.parent; p !== null; p = p.parent)
        if (p.kind === ACTION) {
          this.note(p);
          break;
        }
    // A Shape marked with a role since it was linked: its element now.
    if (item.aria === null && item.kind === SHAPE && item.parent !== null && item.parent.aria !== null && tag(item) !== '') this.insert(item.parent, item);
    if (item.aria === null || item.noted) return;
    item.noted = true;
    this.queue.push(item);
  }

  /** The renderer linked `child` into `parent`. @param {Item} parent @param {Item} child */
  insert(parent, child) {
    const host = parent.aria;
    if (host === null) {
      // Content nested inside an Action (under a View of it): renames it.
      this.note(parent);
      return;
    }
    // An Action's content is its name, not elements of its own.
    if (tag(child) === '' || parent.kind === ACTION) {
      this.note(parent);
      return;
    }
    const el = /** @type {any} */ (this.make(child));
    // The next mirrored sibling: markers, text and shapes have no element.
    let before = null;
    for (let n = child.next; n !== null; n = n.next)
      if (n.aria !== null && n.aria.parentNode === host) {
        before = n.aria;
        break;
      }
    if (el.parentNode !== host || el.nextSibling !== before) host.insertBefore(el, before);
  }

  /** The renderer unlinked `child` from `parent`. @param {Item} parent @param {Item} child */
  remove(parent, child) {
    if (parent.aria === null) {
      this.note(parent);
      return;
    }
    const el = child.aria;
    if (el === null) this.note(parent);
    else if (el.parentNode === parent.aria) parent.aria.removeChild(el);
  }

  /** Writes the text and state of the marked items. */
  flush() {
    const queue = this.queue;
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      item.noted = false;
      write(item);
    }
    queue.length = 0;
  }

  /** Removes the mirror; items forget their elements. */
  close() {
    const box = this.box;
    box.removeEventListener('click', this.click);
    box.removeEventListener('focusin', this.focusin);
    if (box.parentNode != null) box.parentNode.removeChild(box);
    forget(this.renderer.root);
    forget(this.renderer.overlay);
    for (const item of this.queue) item.noted = false;
    this.queue.length = 0;
  }
}

/** Sets an attribute when it differs; null removes it. @param {any} el @param {string} name @param {string | null} value */
function attribute(el, name, value) {
  if (el.getAttribute(name) === value) return;
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

/**
 * Writes the caller's meaning marks on an item's element, as ren-dom writes
 * them: a role, every `aria-*` (a boolean as its text), an id and the
 * microdata; a mark no longer given goes. A container's `label` names it
 * unless an `aria-label` does.
 * @param {Item} item @param {any} el
 */
function mark(item, el) {
  const before = WRITTEN.get(el);
  /** @type {string[] | undefined} */
  let now;
  const other = item.other;
  if (other !== null)
    for (const [name, value] of other) {
      const aria = name.startsWith('aria-') || name === 'content';
      if (!(aria || MARKS.has(name)) || value == null || (value === false && !aria) || typeof value === 'function' || typeof value === 'object') continue;
      // A boolean mark (itemscope) is there or not; an aria state's boolean (and content's) is its text.
      attribute(el, name, value === true && !aria ? '' : String(value));
      (now ??= []).push(name);
    }
  if (before !== undefined) for (const name of before) if (now === undefined || !now.includes(name)) el.removeAttribute(name);
  if (now !== undefined) WRITTEN.set(el, now);
  else if (before !== undefined) WRITTEN.delete(el);
  const k = item.kind;
  if ((k === VIEW || k === LAYOUT || k === SCROLL || k === SHAPE) && item.get('aria-label') == null) attribute(el, 'aria-label', item.given === null || item.given === '' ? null : item.given);
}

/** Writes an item's text and state into its element. @param {Item} item */
function write(item) {
  const el = item.aria;
  if (el.hidden !== item.hidden) el.hidden = item.hidden;
  // An inert region leaves the accessibility tree and the focus order, as the DOM's.
  attribute(el, 'inert', item.inert ? '' : null);
  // Its own direction, as the DOM's dir attribute (inherited below it there too).
  attribute(el, 'dir', item.dir === 0 ? 'ltr' : item.dir === 1 ? 'rtl' : item.dir === 2 ? 'auto' : null);
  mark(item, el);
  switch (item.kind) {
    case LABEL: {
      const text = caption(item);
      if (el.textContent !== text) el.textContent = text;
      break;
    }
    case ACTION: {
      // Named by its label, else by the text it holds (its caption, or its children's).
      const text = spoken(item);
      if (el.textContent !== text) el.textContent = text;
      if (item.get('aria-label') == null) attribute(el, 'aria-label', item.given);
      // selected is a toggle's aria-pressed only without a role: a role (tab, switch) carries its own state.
      attribute(el, 'aria-pressed', item.other?.get('role') == null && (item.choice || item.toggle) ? String(item.selected) : null);
      break;
    }
    case EDIT: {
      // A secret is read as its bullets, never its value.
      const text = shown(item);
      if (el.textContent !== text) el.textContent = text;
      attribute(el, 'aria-disabled', item.disabled ? 'true' : null);
      attribute(el, 'aria-readonly', item.readOnly ? 'true' : null);
      if (item.get('aria-label') == null) attribute(el, 'aria-label', item.given);
      attribute(el, 'aria-multiline', item.lines > 1 ? 'true' : null);
      attribute(el, 'aria-invalid', item.invalid ? 'true' : null);
      break;
    }
    case IMAGE: {
      // alt="" marks a decorative image, as ren-dom's img: presentation, with no name.
      const alt = item.get('alt');
      if (item.get('role') == null) attribute(el, 'role', alt === '' ? 'presentation' : 'img');
      if (item.get('aria-label') == null) attribute(el, 'aria-label', alt == null || alt === '' ? null : String(alt));
      break;
    }
  }
}

/** Drops the elements of a subtree. @param {Item} item */
function forget(item) {
  item.aria = null;
  for (let c = item.first; c !== null; c = c.next) forget(c);
}
