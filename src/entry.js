// Native text entry for the canvas: IME composition, virtual keyboards,
// dictation, paste and the platform's selection only reach a focused native
// text control. While an Edit has focus, a transparent textarea lies over its
// field and holds the DOM focus. The renderer's draft stays the value: the
// textarea mirrors it, and what the platform does to the textarea is mirrored
// back:
// - keydown goes through `Renderer.key` as on the canvas; a key the renderer
//   acts on is cancelled, anything else (dead keys, shortcuts, keys of a
//   virtual keyboard, which arrive as 229 / 'Unidentified') edits natively,
//   the textarea first given the draft and selection (a frame waiting on a
//   worker's layout has not), as paste, cut and drop give it them too;
// - compositionstart and compositionupdate show the preedit (`compose`),
//   compositionend commits it (`commit`: one change);
// - input (outside a composition) hands the whole value and selection to
//   `Renderer.input`;
// - beforeinput turns a line break into Enter on a one-line Edit, and the
//   platform's undo and redo (its Edit menu) into the Edit's own history's
//   (the textarea's would undo what the renderer wrote into it);
// - select and selectionchange mirror the native selection (`select`).
// Everything reaches the application as the renderer's own change, key and
// submit events, so worker mode needs nothing of its own. A secret one-line
// Edit gets a password input instead of the textarea (made on first use), so
// the platform treats it as one (no copy, cut or suggestions); a read-only
// Edit's control is read-only.

import { EDIT } from './scene.js';
import { line } from './layout.js';

/** @typedef {import('./document.js').Document} Renderer */

/** The textarea's style: over the field, invisible, but focusable and read by assistive technology. */
const STYLE =
  'position:absolute;margin:0;border:0;outline:0;resize:none;overflow:hidden;opacity:0;color:transparent;background:transparent;caret-color:transparent;font-family:sans-serif;white-space:pre;pointer-events:none;z-index:1';
/**
 * Its style at rest, before it covers a field: a pixel at the containing
 * block's corner. In flow after the canvas it would overflow the canvas's
 * container, and a scrolling one would show a scrollbar.
 */
const REST = `${STYLE};left:0;top:0;width:1px;height:1px;padding:0`;

/** The selection of a text control as [anchor, caret]. @param {any} area */
const ends = area => (area.selectionDirection === 'backward' ? [area.selectionEnd, area.selectionStart] : [area.selectionStart, area.selectionEnd]);

export class Entry {
  /** @param {Renderer} renderer @param {any} canvas a canvas element in a document */
  constructor(renderer, canvas) {
    const document = canvas.ownerDocument;
    this.renderer = renderer;
    this.canvas = canvas;
    this.document = document;
    const area = document.createElement('textarea');
    area.setAttribute('rows', '1');
    /** The control that holds the focus now: the textarea, or the password input. @type {any} */
    this.area = area;
    /** The textarea, and the password input of a secret Edit (made on first use). @type {any} */
    this.text = area;
    /** @type {any} */
    this.password = null;
    /** The field box the textarea covers, to skip unchanged style writes. */
    this.box = '';
    /** The Edit it last mirrored. @type {import('./scene.js').Item | null} */
    this.item = null;
    /**
     * The renderer's selection when the textarea last held it (written by a
     * sync, or mirrored from the platform): a sync writes the selection only
     * once the renderer's has changed since, so it never undoes a platform
     * move not yet mirrored (Chrome tells selectionchange after the keys
     * queued behind the one that moved it).
     * @type {{ item: import('./scene.js').Item | null, anchor: number, caret: number } | null}
     */
    this.held = null;
    /** Notes that the textarea and the renderer hold the same selection now. */
    this.agreed = () => {
      this.held = { item: renderer.current, anchor: renderer.anchor, caret: renderer.caret };
    };

    /** @param {any} e */
    this.keydown = e => {
      if (e.isComposing || e.keyCode === 229) return;
      // Chords too, with their modifiers: the handlers hear them, and the
      // Document leaves a chord's default (copy, paste, select all) to the
      // textarea unless a handler prevents it.
      if (renderer.key(e.key, e.shiftKey, e)) e.preventDefault();
      // The textarea edits this key itself: it holds the draft and selection
      // first, as a frame waiting on a layout (a worker's) has not given them yet.
      else this.sync();
    };
    // A paste, cut or drop edits the textarea with no key (a menu, a drag): the same.
    this.fresh = () => this.sync();
    /** @param {any} e */
    this.before = e => {
      const item = renderer.current;
      if (item === null || item.kind !== EDIT) return;
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        if (e.inputType === 'historyUndo') renderer.undo(item);
        else renderer.redo(item);
        this.sync();
        return;
      }
      if (item.lines > 1) return;
      if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
        e.preventDefault();
        renderer.key('Enter');
      }
    };
    /** @param {any} e */
    this.start = e => {
      renderer.compose(typeof e.data === 'string' ? e.data : '');
    };
    /** @param {any} e */
    this.update = e => {
      renderer.compose(typeof e.data === 'string' ? e.data : '');
    };
    /** @param {any} e */
    this.end = e => {
      if (renderer.composing) renderer.commit(typeof e.data === 'string' ? e.data : renderer.preedit);
      this.sync();
    };
    /** @param {any} e */
    this.input = e => {
      if (e.isComposing || renderer.composing) return;
      const [anchor, caret] = ends(this.area);
      // A paste, a cut, a drop or a spelling fix is a step of its own in the history.
      renderer.input(this.area.value, anchor, caret, typeof e.inputType === 'string' && APART.test(e.inputType));
      this.sync();
    };
    this.selection = () => {
      if (renderer.composing || document.activeElement !== this.area) return;
      const [anchor, caret] = ends(this.area);
      // The echo of a selection the entry wrote (Chrome tells it after the key): nothing to mirror, and a
      // select would lose what the renderer keeps of its last move (the x of a vertical run, a row end's affinity).
      if ((anchor !== renderer.anchor || caret !== renderer.caret) && renderer.select(anchor, caret)) renderer.present();
      this.agreed();
    };
    this.wire(area);
    document.addEventListener('selectionchange', this.selection);
  }

  /** Makes a control the entry uses: invisible over the canvas, listened to. @param {any} el */
  wire(el) {
    el.setAttribute('data-ren-entry', '');
    el.setAttribute('autocomplete', el.type === 'password' ? 'current-password' : 'off');
    el.setAttribute('style', REST);
    el.tabIndex = -1;
    const canvas = this.canvas;
    const parent = canvas.parentNode ?? this.document.body;
    parent.insertBefore(el, canvas.parentNode === parent ? canvas.nextSibling : null);
    el.addEventListener('keydown', this.keydown);
    el.addEventListener('beforeinput', this.before);
    el.addEventListener('compositionstart', this.start);
    el.addEventListener('compositionupdate', this.update);
    el.addEventListener('compositionend', this.end);
    el.addEventListener('input', this.input);
    el.addEventListener('select', this.selection);
    for (const name of FRESH) el.addEventListener(name, this.fresh);
  }

  /** Stops listening to a control and takes it out. @param {any} el */
  unwire(el) {
    el.removeEventListener('keydown', this.keydown);
    el.removeEventListener('beforeinput', this.before);
    el.removeEventListener('compositionstart', this.start);
    el.removeEventListener('compositionupdate', this.update);
    el.removeEventListener('compositionend', this.end);
    el.removeEventListener('input', this.input);
    el.removeEventListener('select', this.selection);
    for (const name of FRESH) el.removeEventListener(name, this.fresh);
    if (el.parentNode != null) el.parentNode.removeChild(el);
  }

  /**
   * Follows the renderer after a frame: while an Edit has focus, the
   * textarea covers its field, holds its value and selection, and takes the
   * DOM focus from the canvas; otherwise it gives the focus back.
   */
  sync() {
    const renderer = this.renderer;
    const document = this.document;
    const item = renderer.current;
    let active = document.activeElement;
    if (item === null || item.kind !== EDIT) {
      this.item = null;
      // No text (a typed password, a draft) stays in the hidden control.
      if (this.area.value !== '') this.area.value = '';
      if (active === this.area) this.canvas.focus();
      return;
    }
    // A secret one-line Edit is entered in a password input.
    const secret = item.secret && item.lines <= 1;
    if (secret && this.password === null) {
      const input = document.createElement('input');
      input.type = 'password';
      this.password = input;
      this.wire(input);
    }
    const area = secret ? this.password : this.text;
    if (area !== this.area) {
      const was = this.area;
      was.value = '';
      this.area = area;
      this.item = null;
      this.box = '';
      if (active === was) active = this.canvas;
    }
    this.item = item;
    // Each sync: the focused Edit's label or lines may change while it has focus.
    set(area, 'aria-label', item.label ?? '');
    if (!secret) set(area, 'rows', String(item.lines));
    set(area, 'enterkeyhint', item.lines > 1 ? 'enter' : 'done');
    // Its direction, so the platform's own moves (a word, a line's end) run the way the Edit's do.
    set(area, 'dir', item.r.dir === 1 ? 'rtl' : 'ltr');
    if (area.readOnly !== item.readOnly) area.readOnly = item.readOnly;
    this.place(item);
    // Scrolled as the field's rows are, so the platform's IME window sits over the caret.
    if (item.lines > 1 && area.scrollTop !== item.offset) area.scrollTop = item.offset;
    if (!renderer.composing) {
      const rewrite = area.value !== item.draft;
      if (rewrite) area.value = item.draft;
      const held = this.held;
      if (rewrite || held === null || held.item !== item || held.anchor !== renderer.anchor || held.caret !== renderer.caret) {
        const start = Math.min(renderer.anchor, renderer.caret);
        const end = Math.max(renderer.anchor, renderer.caret);
        const direction = renderer.anchor > renderer.caret ? 'backward' : 'forward';
        if (area.selectionStart !== start || area.selectionEnd !== end) area.setSelectionRange(start, end, direction);
        this.agreed();
      }
    }
    // Take the focus from the canvas or the accessibility mirror, never from the rest of the page.
    const mirror = renderer.mirror;
    if (active !== area && (active === this.canvas || active === document.body || active == null || (mirror !== null && mirror.box.contains(active))))
      area.focus({ preventScroll: true });
  }

  /** Lays the textarea over the field of `item`, where the renderer last drew it. @param {import('./scene.js').Item} item */
  place(item) {
    const hits = this.renderer.painter.hits;
    let i = hits.n - 1;
    while (i >= 0 && hits.items[i] !== item) i--;
    if (i < 0) return;
    const b = hits.box;
    const [x, y, w, h] = this.renderer.screen(this.canvas, b[i * 6], b[i * 6 + 1], b[i * 6 + 2], b[i * 6 + 3]);
    // The Edit's own text box, so the platform puts IME windows and selection handles over its text.
    const r = item.r;
    // Set as drawn (the fonts' family where they name one, wrapped as a multi-line Edit's rows), so what the
    // platform does natively in it (a word move, a line's end) lands near where it would on the canvas.
    const named = /** @type {{ family?: unknown }} */ (this.renderer.fonts).family;
    // A family the fonts name, quoted; the generic fallback as a keyword (quoted, it would name a font called "sans-serif").
    const family = typeof named === 'string' ? JSON.stringify(named) : 'sans-serif';
    const box = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;font-size:${r.size}px;line-height:${line(r)}px;padding:${r.pt + r.bT}px ${r.pr + r.bR}px ${r.pb + r.bB}px ${r.pl + r.bL}px;box-sizing:border-box;font-family:${r.mono ? 'monospace' : family};white-space:${item.lines > 1 ? 'pre-wrap' : 'pre'}`;
    if (box === this.box) return;
    this.box = box;
    this.area.setAttribute('style', `${STYLE};${box}`);
    // The other control stays out of the way.
    const other = this.area === this.text ? this.password : this.text;
    if (other !== null) other.setAttribute('style', REST);
  }

  close() {
    this.document.removeEventListener('selectionchange', this.selection);
    if (this.document.activeElement === this.area) this.canvas.focus();
    this.unwire(this.text);
    if (this.password !== null) this.unwire(this.password);
    this.item = null;
  }
}

/** The input types of an edit that stands apart in the history, never joined to typing. */
const APART = /^(insertFrom|deleteBy|insertReplacementText)/;

/** The events that edit the textarea with no keydown the renderer saw first. */
const FRESH = ['paste', 'cut', 'drop'];

/** Sets an attribute when it differs. @param {any} el @param {string} name @param {string} value */
function set(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
