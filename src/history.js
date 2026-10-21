// An Edit's undo history, as a browser's field keeps one: each user's edit
// is a step of the value and the selection before and after it. Typing
// joins the step before it while it goes on where that one left the caret,
// within a second of it and in the same word (a word and the spaces after
// it are one step); deleting joins deleting so. A paste, a cut, a drop, a
// replaced selection or `replace` is a step of its own. Undo and redo walk
// the steps; an edit after an undo drops the steps it undid. A value the
// view sets that is not the one the last step left (a controlled write)
// clears it, as a browser's field forgets its history when code sets its
// value. At most LIMIT steps are kept.

/** What an edit was, for joining: typing, deleting, or anything else (it stands alone). */
export const TYPED = 1;
export const ERASED = 2;
export const OTHER = 0;

/** The steps kept, the oldest dropped first. */
const LIMIT = 100;
/** A pause longer than this (ms) between two keystrokes starts a step. */
const PAUSE = 1000;

/** White space, where typing starts a new word's step. */
const SPACE = /\s/;

/** One edit: the value and selection (anchor, caret) before and after it. */
class Step {
  /** @param {string} before @param {number} a0 @param {number} c0 @param {string} after @param {number} a1 @param {number} c1 @param {number} kind @param {number} time */
  constructor(before, a0, c0, after, a1, c1, kind, time) {
    this.before = before;
    this.a0 = a0;
    this.c0 = c0;
    this.after = after;
    this.a1 = a1;
    this.c1 = c1;
    this.kind = kind;
    this.time = time;
  }
}

export class History {
  constructor() {
    /** @type {Step[]} */
    this.steps = [];
    /** How many steps are done: undo takes the one before, redo the one here. */
    this.at = 0;
    /** The value the last step done or undone left. */
    this.value = '';
  }

  /**
   * Keeps an edit from `before` (selected from `a0` to `c0`) to `after`
   * (from `a1` to `c1`), joined to the last step when it goes on with it.
   * @param {string} before @param {number} a0 @param {number} c0 @param {string} after @param {number} a1 @param {number} c1 @param {number} kind @param {number} time ms
   */
  record(before, a0, c0, after, a1, c1, kind, time) {
    this.value = after;
    if (before === after) return;
    const steps = this.steps;
    steps.length = this.at;
    const last = this.at > 0 ? steps[this.at - 1] : null;
    // Typing after a space starts the next word's step.
    const word = kind === TYPED && c0 > 0 && SPACE.test(before[c0 - 1]) && !SPACE.test(after.charAt(c0));
    if (last !== null && kind !== OTHER && last.kind === kind && last.after === before && last.a1 === a0 && last.c1 === c0 && time - last.time <= PAUSE && !word) {
      last.after = after;
      last.a1 = a1;
      last.c1 = c1;
      last.time = time;
      return;
    }
    steps.push(new Step(before, a0, c0, after, a1, c1, kind, time));
    if (steps.length > LIMIT) steps.shift();
    this.at = steps.length;
  }

  /** The step to undo, now undone; null for none. */
  back() {
    if (this.at === 0) return null;
    const step = this.steps[--this.at];
    this.value = step.before;
    return step;
  }

  /** The step to redo, now done again; null for none. */
  on() {
    if (this.at >= this.steps.length) return null;
    const step = this.steps[this.at++];
    this.value = step.after;
    return step;
  }

  /** Forgets every step. */
  clear() {
    this.steps.length = 0;
    this.at = 0;
  }
}

/** Each Edit's history, made at its first edit (an Edit moved to another Document keeps it). @type {WeakMap<object, History>} */
const HISTORIES = new WeakMap();

/** An Edit's history, made when `make` and there is none; else null for none. @param {object} item @param {boolean} [make] */
export function historyOf(item, make = false) {
  let h = HISTORIES.get(item) ?? null;
  if (h === null && make) HISTORIES.set(item, (h = new History()));
  return h;
}
