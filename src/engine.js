// Where layout runs, and what it speaks: a neutral boundary around the
// layout engine. A Boxes (layout.js) keeps the scene's layout tree as flat
// commands whose styles are plain CSS box records (`Box`); a Tree runs them
// against a Solver, lays the page out (`arrange`) and answers with boxes.
// The Solver is the engine itself, and only it: Taffy by default (taffy.js,
// `loadLayout`), or anything given to `useLayout`, another engine or a
// JavaScript one, with no change anywhere else. The scene side and the Tree
// meet either in one thread (`Local`, the default: commands run as the
// Document presents, boxes are read as items are drawn) or across a port
// (`remoteLayout` on the main thread, `serveLayout` in any worker: the Tree
// answers with the boxes that changed). Text is measured where the scene
// is; this side needs no fonts.
//
// Commands (Int32 words; ids are the scene side's, from 1):
//   NEW id flags        a leaf with the default style (flags: CONTENT, a
//                       leaf's content child, never reported)
//   STYLE id style      the style a DEFINE made
//   KIDS id count ids…  the children, in order
//   REMOVE id           the node goes (its children stay)
//   DEFINE style        the next Box of the side list, as a style
//   FORGET              every style goes (the nodes keep theirs)
//   SIZE id style       the style with the next three numbers of the side
//                       list as its minWidth, minHeight and basis (NaN:
//                       auto): a leaf sized by its content, which keeps the
//                       style it shares with others
//
// Remote messages, main → worker: [LAYOUT, tree, ops, n, side | null, spec,
// records | null] (records returns the last answer's buffer), [CLOSE, tree].
// Worker → main: [tree, records, count, width, height, gutter, ops]: each
// record is [id, x, y, width, height, content height, content width] as Float32, and ops
// returns the command buffer.

export const NEW = 1;
export const STYLE = 2;
export const KIDS = 3;
export const REMOVE = 4;
export const DEFINE = 5;
export const FORGET = 6;
export const SIZE = 7;
/** A NEW flag: a leaf's content child. */
export const CONTENT = 1;
/** Floats per reported box. */
export const RECORD = 7;

const LAYOUT = 1;
const CLOSE = 2;

/**
 * A node's style, as CSS names it: the whole box model a Solver lays out.
 * Lengths are logical pixels; 'auto' (or a percentage string) where CSS
 * allows one; a max of 'auto' is none. Grid tracks and lines are CSS text.
 * @typedef {object} Box
 * @property {'flex' | 'grid' | 'none'} display
 * @property {'relative' | 'absolute'} position absolute: out of the flow, placed by its insets in its parent's padding box
 * @property {(number | string)[]} inset top, right, bottom, left: a length, a percentage or 'auto'
 * @property {'row' | 'column'} direction flex-direction
 * @property {boolean} wrap flex-wrap
 * @property {number} columnGap
 * @property {number} rowGap
 * @property {number[]} padding top, right, bottom, left
 * @property {number[]} border widths: top, right, bottom, left
 * @property {number[]} margin top, right, bottom, left
 * @property {number | string} width
 * @property {number | string} height
 * @property {number | string} minWidth
 * @property {number | string} minHeight
 * @property {number | string} maxWidth
 * @property {number | string} maxHeight
 * @property {number | null} ratio aspect-ratio, width over height (null: auto)
 * @property {number | string} basis flex-basis
 * @property {number} grow
 * @property {number} shrink
 * @property {'start' | 'center' | 'end' | 'stretch'} align align-items
 * @property {'auto' | 'start' | 'center' | 'end' | 'stretch'} self align-self
 * @property {'normal' | 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly'} justify justify-content ('normal', CSS's initial: the start in a flex container, a grid's auto tracks stretched over its free space)
 * @property {'visible' | 'hidden' | 'scroll'} overflowX
 * @property {'visible' | 'hidden' | 'scroll'} overflowY
 * @property {number} scrollbar the width a scrolling box keeps for its bar
 * @property {string | null} columns grid-template-columns
 * @property {string | null} rows grid-template-rows
 * @property {string | null} column grid-column
 * @property {string | null} row grid-row
 * @property {'ltr' | 'rtl'} dir CSS's direction (HTML's `dir`): right to left, its children are placed from its right (a row's main axis, a grid's columns, the start of `justify` and `align`), their insets and margins staying physical
 */

/** CSS's initial values. @type {Readonly<Box>} */
const INITIAL = Object.freeze({
  display: 'flex',
  position: 'relative',
  inset: ['auto', 'auto', 'auto', 'auto'],
  direction: 'row',
  wrap: false,
  columnGap: 0,
  rowGap: 0,
  padding: [0, 0, 0, 0],
  border: [0, 0, 0, 0],
  margin: [0, 0, 0, 0],
  width: 'auto',
  height: 'auto',
  minWidth: 'auto',
  minHeight: 'auto',
  maxWidth: 'auto',
  maxHeight: 'auto',
  ratio: null,
  basis: 'auto',
  grow: 0,
  shrink: 1,
  align: 'stretch',
  self: 'auto',
  justify: 'normal',
  overflowX: 'visible',
  overflowY: 'visible',
  scrollbar: 0,
  columns: null,
  rows: null,
  column: null,
  row: null,
  dir: 'ltr',
});

/** A Box: CSS's initial values, with `fields`. @param {Partial<Box>} fields @returns {Box} */
export const box = fields => ({ ...INITIAL, ...fields });

/**
 * A layout engine: a tree of nodes with styles, laid out on demand. Nodes
 * and styles are whatever the engine makes.
 * @typedef {object} Solver
 * @property {() => any} leaf A new node with CSS's initial style.
 * @property {(style: Box) => any} define A style from a Box, set on nodes by `set`.
 * @property {(style: any) => void} undefine Frees a style (the nodes keep what it set).
 * @property {(node: any, style: any) => void} set
 * @property {(node: any, style: any, minWidth: number | string, minHeight: number | string, basis: number | string) => void} sized `set`, with these three of the style replaced
 * @property {(node: any, children: any[]) => void} children
 * @property {(node: any) => void} remove Frees a node (its children stay).
 * @property {(node: any, width: number, height?: number) => void} compute Lays out from a node at a width (NaN: its max-content width) and a height (NaN or none: from its content; a percentage height resolves against a given one).
 * @property {(node: any, out: Float64Array) => void} read The node's last box: x and y in its parent's border box, width, height, and its content's height and width.
 * @property {() => void} close
 */

/** @type {(() => Solver) | null} */
let make = null;
/** @type {(() => void)[]} */
let ready = [];

/**
 * The layout engine: `make` returns a new Solver (one per laid-out tree).
 * `loadLayout` sets Taffy's; any other engine can be used instead, here
 * and in a layout worker.
 * @param {() => Solver} solver
 */
export function useLayout(solver) {
  make = solver;
  const waiting = ready;
  ready = [];
  for (const run of waiting) run();
}

/** Runs `fn` once a layout engine is set. @param {() => void} fn */
function whenReady(fn) {
  if (make !== null) fn();
  else ready.push(fn);
}

/**
 * What the page is laid out at, and what came of it.
 * @typedef {object} Spec
 * @property {number} root The page's node.
 * @property {number} overlay The overlay's node.
 * @property {number} width The viewport, in logical pixels.
 * @property {number} height
 * @property {number} bar A scrollbar's width, taken from the page while it overflows.
 * @property {boolean} gutter The page overflowed at the last layout.
 * @property {boolean} fit Size the page to its content (a panel).
 */

/**
 * What a layout of the page came to: the viewport (a fitted page's is its
 * content's) and whether the page overflows it.
 * @typedef {object} Placed
 * @property {number} width
 * @property {number} height
 * @property {boolean} gutter
 */

/** Grows an Int32Array to hold `size` values. @param {Int32Array} a @param {number} size */
function grown(a, size) {
  if (size <= a.length) return a;
  let length = a.length * 2;
  while (length < size) length *= 2;
  const b = new Int32Array(length);
  b.set(a);
  return b;
}

/** A length that may be auto (NaN). @param {number} v */
const auto = v => (v === v ? v : 'auto');

/** The layout engine's side: a Solver's tree kept by commands. */
export class Tree {
  /** @param {boolean} tracking keep what changed since the last `collect` (a remote tree) */
  constructor(tracking) {
    if (make === null) throw new Error('REN canv: no layout engine: await loadLayout() (or useLayout) where layout runs');
    this.solver = make();
    this.tracking = tracking;
    /** The solver's nodes by id. @type {any[]} */
    this.nodes = [];
    /** Styles by the id a DEFINE gave. @type {any[]} */
    this.styles = [];
    // Tracking: each node's parent (0: none), children, flags, whether
    // something below it changed, and the box last reported.
    /** @type {Int32Array} */
    this.parent = new Int32Array(256);
    /** @type {Int32Array} */
    this.flags = new Int32Array(256);
    /** @type {Int32Array} */
    this.dirty = new Int32Array(256);
    /** @type {(Int32Array | null)[]} */
    this.kids = [];
    this.last = new Float32Array(256 * 6);
    /** The reported boxes of a collect. */
    this.records = new Float32Array(256 * RECORD);
    this.count = 0;
    /** A box read for the scene side (x, y, width, height, content height, content width). */
    this.box = new Float64Array(6);
  }

  /** Room for ids up to `id`. @param {number} id */
  room(id) {
    if (id < this.parent.length) return;
    this.parent = grown(this.parent, id + 1);
    this.flags = grown(this.flags, id + 1);
    this.dirty = grown(this.dirty, id + 1);
    if (this.last.length < this.parent.length * 6) {
      const last = new Float32Array(this.parent.length * 6);
      last.set(this.last);
      this.last = last;
    }
  }

  /** Marks a node and its ancestors: their boxes are read at the next collect. @param {number} id */
  mark(id) {
    const parent = this.parent;
    const dirty = this.dirty;
    while (id !== 0 && dirty[id] === 0) {
      dirty[id] = 1;
      id = parent[id];
    }
  }

  /**
   * Runs `n` command words.
   * @param {Int32Array} ops @param {number} n @param {readonly any[] | null} side the DEFINE props, in order
   */
  run(ops, n, side) {
    const solver = this.solver;
    const nodes = this.nodes;
    const tracking = this.tracking;
    let k = 0;
    for (let i = 0; i < n; ) {
      const op = ops[i];
      if (op === STYLE) {
        const id = ops[i + 1];
        solver.set(nodes[id], this.styles[ops[i + 2]]);
        if (tracking) this.mark(id);
        i += 3;
      } else if (op === KIDS) {
        const id = ops[i + 1];
        const count = ops[i + 2];
        const list = new Array(count);
        for (let c = 0; c < count; c++) list[c] = nodes[ops[i + 3 + c]];
        solver.children(nodes[id], list);
        if (tracking) {
          const kids = ops.slice(i + 3, i + 3 + count);
          for (let c = 0; c < count; c++) this.parent[kids[c]] = id;
          this.kids[id] = kids;
          this.mark(id);
        }
        i += 3 + count;
      } else if (op === NEW) {
        const id = ops[i + 1];
        nodes[id] = solver.leaf();
        if (tracking) {
          this.room(id);
          this.parent[id] = 0;
          this.flags[id] = ops[i + 2];
          this.dirty[id] = 1;
          this.kids[id] = null;
          // Never reported yet: its first box always is.
          this.last[id * 6] = NaN;
        }
        i += 3;
      } else if (op === REMOVE) {
        const id = ops[i + 1];
        const node = nodes[id];
        if (node !== undefined) solver.remove(node);
        nodes[id] = undefined;
        if (tracking) {
          const parent = this.parent[id];
          if (parent !== 0) this.mark(parent);
          this.parent[id] = 0;
          this.dirty[id] = 0;
          this.kids[id] = null;
        }
        i += 2;
      } else if (op === DEFINE) {
        const id = ops[i + 1];
        if (this.styles[id] !== undefined) solver.undefine(this.styles[id]);
        this.styles[id] = solver.define(/** @type {Box[]} */ (side)[k++]);
        i += 2;
      } else if (op === SIZE) {
        const id = ops[i + 1];
        const list = /** @type {any[]} */ (side);
        solver.sized(nodes[id], this.styles[ops[i + 2]], auto(list[k]), auto(list[k + 1]), auto(list[k + 2]));
        k += 3;
        if (tracking) this.mark(id);
        i += 3;
      } else if (op === FORGET) {
        for (const style of this.styles) if (style !== undefined) solver.undefine(style);
        this.styles.length = 0;
        i += 1;
      } else throw new Error(`REN canv: unknown layout command ${op}`);
    }
  }

  /** Lays out a node at a width (NaN: its max-content width) and a height (NaN: from its content). @param {number} id @param {number} width @param {number} [height] */
  compute(id, width, height = NaN) {
    this.solver.compute(this.nodes[id], width, height);
  }

  /** Reads a node's last box into `box`. @param {number} id */
  read(id) {
    this.solver.read(this.nodes[id], this.box);
    return this.box;
  }

  /**
   * Lays out the page and the overlay. The page is as wide as the viewport,
   * less a scrollbar while it overflows (as a browser's page); a fitted one
   * is as wide as its content wants and as high as it then is.
   * @param {Spec} spec
   * @returns {Placed}
   */
  arrange(spec) {
    let width = spec.width;
    let height = spec.height;
    let gutter = spec.gutter;
    if (spec.fit) {
      this.compute(spec.root, NaN);
      width = Math.max(1, Math.ceil(this.read(spec.root)[2]));
      this.compute(spec.root, width);
      height = Math.max(1, Math.ceil(this.read(spec.root)[3]));
      gutter = false;
    } else {
      this.compute(spec.root, Math.max(1, width - (gutter ? spec.bar : 0)));
      if (this.read(spec.root)[3] > height !== gutter) {
        gutter = !gutter;
        this.compute(spec.root, Math.max(1, width - (gutter ? spec.bar : 0)));
      }
    }
    // The overlay covers the viewport, as high as it is.
    this.compute(spec.overlay, Math.max(1, width), Number.isFinite(height) ? height : NaN);
    return { width, height, gutter };
  }

  /**
   * The boxes that changed since the last collect, below `roots`, into
   * `records`: a node is read when something below it changed or its
   * parent's size did (a subtree whose size and content did not change kept
   * its layout).
   * @param {readonly number[]} roots
   */
  collect(roots) {
    this.count = 0;
    for (const id of roots) this.visit(id, true);
    return this.count;
  }

  /** @param {number} id @param {boolean} moved its parent was laid out again (changed or resized) */
  visit(id, moved) {
    if (this.nodes[id] === undefined || (this.flags[id] & CONTENT) !== 0) return;
    const dirty = this.dirty[id] !== 0;
    if (!dirty && !moved) return;
    const box = this.read(id);
    const last = this.last;
    const o = id * 6;
    const resized = last[o + 2] !== Math.fround(box[2]) || last[o + 3] !== Math.fround(box[3]);
    if (resized || last[o] !== Math.fround(box[0]) || last[o + 1] !== Math.fround(box[1]) || last[o + 4] !== Math.fround(box[4]) || last[o + 5] !== Math.fround(box[5])) {
      last.set(box, o);
      let records = this.records;
      const r = this.count * RECORD;
      if (r + RECORD > records.length) {
        records = new Float32Array(records.length * 2);
        records.set(this.records);
        this.records = records;
      }
      records[r] = id;
      records.set(box, r + 1);
      this.count++;
    }
    this.dirty[id] = 0;
    if (!dirty && !resized) return;
    const kids = this.kids[id];
    if (kids !== null && kids !== undefined) for (let c = 0; c < kids.length; c++) this.visit(kids[c], true);
  }

  close() {
    for (const style of this.styles) if (style !== undefined) this.solver.undefine(style);
    this.styles.length = 0;
    this.solver.close();
  }
}

/**
 * The scene side's view of where layout runs: commands go in, the page's
 * layout comes back, now (`Local`) or in a later task (`Remote`).
 * @typedef {object} Engine
 * @property {boolean} pushed The boxes that changed come with each layout, rather than read on demand.
 * @property {boolean} busy A layout is in flight; commands wait for its answer.
 * @property {(ops: Int32Array, n: number, side: any[], spec: Spec, done: (placed: Placed, records: Float32Array, count: number) => void) => Int32Array} send Runs the commands and lays out; `done` gets the result (at once when local). Returns the command buffer to reuse.
 * @property {((id: number) => Float64Array)=} read A node's box, when local.
 * @property {() => void} close
 */

/** Layout in this thread: commands run as they are sent; boxes are read on demand, or come with each layout. @implements {Engine} */
export class Local {
  /** @param {boolean} [pushed] send the boxes that changed with each layout (as a worker does), for a scene that writes them out */
  constructor(pushed = false) {
    this.tree = new Tree(pushed);
    this.pushed = pushed;
    this.busy = false;
    /** A node's box, read on demand when boxes are not pushed. @type {((id: number) => Float64Array) | undefined} */
    this.read = pushed ? undefined : id => this.tree.read(id);
  }

  /** @param {Int32Array} ops @param {number} n @param {any[]} side @param {Spec} spec @param {(placed: Placed, records: Float32Array, count: number) => void} done */
  send(ops, n, side, spec, done) {
    const tree = this.tree;
    tree.run(ops, n, side);
    const placed = tree.arrange(spec);
    done(placed, tree.records, this.pushed ? tree.collect([spec.root, spec.overlay]) : 0);
    return ops;
  }

  close() {
    this.tree.close();
  }
}

/**
 * A port: a Worker, a MessagePort, a worker's global scope, or node's
 * worker_threads ends.
 * @typedef {object} Port
 * @property {(data: any, transfer: any[]) => void} postMessage Called with a transfer list.
 * @property {((type: 'message', listener: (event: any) => void) => void)=} addEventListener
 * @property {((type: 'message', listener: (event: any) => void) => void)=} removeEventListener
 * @property {((type: 'message', listener: (data: any) => void) => void)=} on
 * @property {((type: 'message', listener: (data: any) => void) => void)=} off
 * @property {(() => void)=} start
 */

/** Listens to a port's messages; returns what stops. @param {Port} port @param {(data: any) => void} fn */
function listen(port, fn) {
  if (typeof port.addEventListener === 'function') {
    const listener = (/** @type {any} */ event) => fn(event.data);
    port.addEventListener('message', listener);
    if (typeof port.start === 'function') port.start();
    return () => port.removeEventListener?.('message', listener);
  }
  if (typeof port.on === 'function') {
    port.on('message', fn);
    return () => port.off?.('message', fn);
  }
  throw new Error('REN canv: a layout port needs addEventListener or on');
}

/** The last tree id given out: one count for every LayoutPort of this module, so ports sharing one worker never give two Documents one tree. */
let trees = 0;

/**
 * Layout in a worker (`serveLayout` there), shared by every Document given
 * it (`layout` option): each has its own tree there. Pass it as the
 * `layout` option of ren-skia's, ren-three's or a Document's options.
 */
export class LayoutPort {
  /** @param {Port} port */
  constructor(port) {
    this.port = port;
    /** The trees' answer handlers by id. @type {Map<number, (data: any[]) => void>} */
    this.waiting = new Map();
    this.stop = listen(port, data => {
      const answer = this.waiting.get(data[0]);
      if (answer !== undefined) answer(data);
    });
  }

  /** An engine for one Document. */
  engine() {
    return new Remote(this, ++trees);
  }

  /** Stops listening; the worker keeps serving other ports. */
  close() {
    this.stop();
    this.waiting.clear();
  }
}

/**
 * Layout in a worker, over a port served by `serveLayout`.
 * @param {Port} port
 */
export function remoteLayout(port) {
  return new LayoutPort(port);
}

/** One Document's tree in a layout worker. @implements {Engine} */
export class Remote {
  /** @param {LayoutPort} owner @param {number} id */
  constructor(owner, id) {
    this.owner = owner;
    this.id = id;
    this.pushed = true;
    this.busy = false;
    /** The buffer the last answer came in, returned with the next request. @type {Float32Array | null} */
    this.spare = null;
    /** The command buffer the last answer returned. @type {Int32Array | null} */
    this.returned = null;
    /** @type {((placed: Placed, records: Float32Array, count: number) => void) | null} */
    this.done = null;
    owner.waiting.set(id, data => this.answer(data));
  }

  /** @param {Int32Array} ops @param {number} n @param {any[]} side @param {Spec} spec @param {(placed: Placed, records: Float32Array, count: number) => void} done */
  send(ops, n, side, spec, done) {
    this.busy = true;
    this.done = done;
    // Its length before it is transferred (a transferred buffer is empty).
    const length = ops.length;
    const spare = this.spare;
    this.spare = null;
    /** @type {any[]} */
    const transfer = [ops.buffer];
    if (spare !== null) transfer.push(spare.buffer);
    this.owner.port.postMessage([LAYOUT, this.id, ops, n, side.length > 0 ? side : null, spec, spare], transfer);
    // The buffer comes back with the answer: the two take turns.
    const next = this.returned ?? new Int32Array(length);
    this.returned = null;
    return next;
  }

  /** @param {any[]} data */
  answer(data) {
    const [, records, count, width, height, gutter, ops] = data;
    this.busy = false;
    this.spare = records;
    this.returned = ops;
    const done = this.done;
    this.done = null;
    if (done !== null) done({ width, height, gutter }, records, count);
  }

  close() {
    this.owner.waiting.delete(this.id);
    this.owner.port.postMessage([CLOSE, this.id], []);
  }
}

/**
 * Serves layout on a port, in a worker (or any thread): the trees of the
 * Documents on the other side, each laid out when it asks. Messages that
 * arrive before a layout engine is set (`loadLayout`, `useLayout`) wait
 * for it.
 * @param {Port} port
 * @returns {() => void} stops serving and frees the trees; what waited for
 *   an engine is dropped, and an engine set later builds nothing for it
 */
export function serveLayout(port) {
  /** @type {Map<number, Tree>} */
  const trees = new Map();
  /** @type {any[][] | null} */
  let queue = [];
  /** Set by the stop: an engine set later lays out nothing that waited. */
  let stopped = false;
  /** @param {any[]} data */
  const handle = data => {
    if (data[0] === CLOSE) {
      trees.get(data[1])?.close();
      trees.delete(data[1]);
      return;
    }
    const [, id, ops, n, side, spec, spare] = data;
    let tree = trees.get(id);
    if (tree === undefined) trees.set(id, (tree = new Tree(true)));
    tree.run(ops, n, side);
    const placed = tree.arrange(spec);
    const count = tree.collect([spec.root, spec.overlay]);
    // The answer goes in the buffer the other side returned, when it fits.
    const records = spare instanceof Float32Array && spare.length >= count * RECORD ? spare : new Float32Array(Math.max(64, tree.records.length));
    records.set(tree.records.subarray(0, count * RECORD));
    port.postMessage([id, records, count, placed.width, placed.height, placed.gutter, ops], [records.buffer, ops.buffer]);
  };
  const stop = listen(port, data => {
    if (queue !== null) queue.push(data);
    else handle(data);
  });
  whenReady(() => {
    if (stopped) return;
    const waiting = /** @type {any[][]} */ (queue);
    queue = null;
    for (const data of waiting) handle(data);
  });
  return () => {
    stopped = true;
    stop();
    if (queue !== null) queue.length = 0;
    for (const tree of trees.values()) tree.close();
    trees.clear();
  };
}
