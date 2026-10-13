// HarfBuzz as the shaper: a Shaper (shape.js) over the WebAssembly build
// of the harfbuzzjs package (pinned), HarfBuzz itself compiled, called
// through its C functions here. This is the only module that knows
// HarfBuzz. The package's own JavaScript entry instantiates its module at
// import, from a file beside the script; this one takes the module's bytes,
// URL or compiled form, as `loadLayout` takes Taffy's, so a page decides
// where the file is and nothing loads until it is asked for.

import { useShaper, settled } from './shape.js';

/** @typedef {import('./shape.js').Shaper} Shaper */
/** @typedef {import('./shape.js').Glyphs} Glyphs */

/** HarfBuzz's directions. */
const LTR = 4;
const RTL = 5;
/** A blob's memory mode: read only, never written. */
const READONLY = 1;

/** A 32-bit FNV-1a hash of bytes. @param {Uint8Array} bytes */
const hash = bytes => {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
};

/** An OpenType tag as HarfBuzz's number. @param {string} tag */
const tagOf = tag => ((tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16) | (tag.charCodeAt(2) << 8) | tag.charCodeAt(3)) >>> 0;

/**
 * HarfBuzz's shaping over its WebAssembly instance. A typeface is made
 * once per font file content (its bytes copied into the module's memory
 * and kept: as many as there are distinct font files), its font at the
 * typeface's units per em, so glyph advances and offsets are in its units.
 * @implements {Shaper}
 */
export class HarfBuzz {
  /** @param {WebAssembly.Instance} instance */
  constructor(instance) {
    const x = /** @type {any} */ (instance.exports);
    this.x = x;
    /** @type {WebAssembly.Memory} */
    this.memory = x.memory;
    this.buffer = x.hb_buffer_create();
    /** The text's UTF-16 units in the module's memory, grown as needed. */
    this.text = 0;
    this.room = 0;
    /** Encoded feature lists, by the list given. @type {WeakMap<object, { at: number, count: number }>} */
    this.features = new WeakMap();
    /** Fonts by the bytes object given. @type {WeakMap<object, number>} */
    this.given = new WeakMap();
    /** Fonts by content: [length:hash] → copies in memory. @type {Map<string, { at: number, length: number, font: number }[]>} */
    this.byContent = new Map();
    /** The glyphs of the last shaping, reused. */
    this.out = { count: 0, ids: new Uint32Array(64), advances: new Int32Array(64), dx: new Int32Array(64), dy: new Int32Array(64), clusters: new Uint32Array(64) };
  }

  /** @param {Uint8Array} bytes */
  face(bytes) {
    const known = this.given.get(bytes);
    if (known !== undefined) return known;
    const x = this.x;
    const key = `${bytes.length}:${hash(bytes)}`;
    let alike = this.byContent.get(key);
    if (alike === undefined) this.byContent.set(key, (alike = []));
    for (const entry of alike) {
      const held = new Uint8Array(this.memory.buffer, entry.at, entry.length);
      let same = true;
      for (let i = 0; i < bytes.length && same; i++) same = held[i] === bytes[i];
      if (same) {
        this.given.set(bytes, entry.font);
        return entry.font;
      }
    }
    const at = x.malloc(bytes.length);
    new Uint8Array(this.memory.buffer, at, bytes.length).set(bytes);
    const blob = x.hb_blob_create(at, bytes.length, READONLY, 0, 0);
    const face = x.hb_face_create(blob, 0);
    const font = x.hb_font_create(face);
    alike.push({ at, length: bytes.length, font });
    this.given.set(bytes, font);
    return font;
  }

  /** The feature list in memory: 16 bytes each (tag, value, start, end). @param {Readonly<Record<string, number>>} features */
  encoded(features) {
    let found = this.features.get(features);
    if (found === undefined) {
      const tags = Object.keys(features);
      const at = this.x.malloc(Math.max(1, tags.length) * 16);
      const words = new Uint32Array(this.memory.buffer, at, tags.length * 4);
      tags.forEach((tag, i) => {
        words[i * 4] = tagOf(tag);
        words[i * 4 + 1] = features[tag];
        words[i * 4 + 2] = 0;
        words[i * 4 + 3] = 0xffffffff;
      });
      found = { at, count: tags.length };
      this.features.set(features, found);
    }
    return found;
  }

  /**
   * @param {number} font @param {string} text @param {number} start @param {number} end @param {boolean} rtl
   * @param {Readonly<Record<string, number>>} features
   * @returns {Glyphs}
   */
  shape(font, text, start, end, rtl, features) {
    const x = this.x;
    const { at, count: featureCount } = this.encoded(features);
    if (text.length > this.room) {
      if (this.text !== 0) x.free(this.text);
      this.room = Math.max(256, text.length * 2);
      this.text = x.malloc(this.room * 2);
    }
    const units = new Uint16Array(this.memory.buffer, this.text, text.length);
    for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
    const buffer = this.buffer;
    x.hb_buffer_clear_contents(buffer);
    x.hb_buffer_add_utf16(buffer, this.text, text.length, start, end - start);
    x.hb_buffer_set_direction(buffer, rtl ? RTL : LTR);
    x.hb_buffer_guess_segment_properties(buffer);
    x.hb_shape(font, buffer, at, featureCount);
    const count = x.hb_buffer_get_length(buffer);
    const infos = new Uint32Array(this.memory.buffer, x.hb_buffer_get_glyph_infos(buffer, 0), count * 5);
    const positions = new Int32Array(this.memory.buffer, x.hb_buffer_get_glyph_positions(buffer, 0), count * 5);
    let out = this.out;
    if (out.ids.length < count) {
      const n = Math.max(count, out.ids.length * 2);
      out = this.out = { count: 0, ids: new Uint32Array(n), advances: new Int32Array(n), dx: new Int32Array(n), dy: new Int32Array(n), clusters: new Uint32Array(n) };
    }
    out.count = count;
    for (let i = 0; i < count; i++) {
      out.ids[i] = infos[i * 5];
      out.clusters[i] = infos[i * 5 + 2];
      out.advances[i] = positions[i * 5];
      out.dx[i] = positions[i * 5 + 2];
      out.dy[i] = positions[i * 5 + 3];
    }
    return out;
  }
}

/** The module's imports: what its C library asks of the host. @param {() => WebAssembly.Memory} memory */
const imports = memory => ({
  wasi_snapshot_preview1: {
    /** @param {number} code */
    proc_exit(code) {
      throw new Error(`REN canv: the shaper exited (${code})`);
    },
  },
  env: {
    _emscripten_runtime_keepalive_clear() {},
    _abort_js() {
      throw new Error('REN canv: the shaper aborted');
    },
    _setitimer_js() {
      return 0;
    },
    /** Grows the memory to `size` bytes: 1 when it did. @param {number} size */
    emscripten_resize_heap(size) {
      const m = memory();
      const have = m.buffer.byteLength;
      const want = size >>> 0;
      if (want <= have) return 1;
      try {
        m.grow(Math.ceil((want - have) / 65536));
        return 1;
      } catch {
        return 0;
      }
    },
  },
});

/** The shaper of an instantiated module, set. @param {WebAssembly.Instance} instance */
function ready(instance) {
  /** @type {any} */ (instance.exports).__wasm_call_ctors();
  useShaper(new HarfBuzz(instance));
  loaded = true;
}

let loaded = false;
/** @type {Promise<void> | null} */
let loading = null;

/** The module's imports, bound to the instance made with them. */
function bound() {
  /** @type {WebAssembly.Memory | null} */
  let memory = null;
  return { set: (/** @type {WebAssembly.Instance} */ i) => (memory = /** @type {any} */ (i.exports).memory), imports: imports(() => /** @type {WebAssembly.Memory} */ (memory)) };
}

/** Instantiates a compiled module or its bytes at once. @param {WebAssembly.Module | ArrayBuffer | ArrayBufferView} source */
function now(source) {
  const module = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(/** @type {any} */ (source));
  const b = bound();
  const instance = new WebAssembly.Instance(module, /** @type {any} */ (b.imports));
  b.set(instance);
  ready(instance);
}

/** The module's bytes beside harfbuzzjs, in node; null elsewhere. */
function beside() {
  const proc = /** @type {any} */ (globalThis).process;
  if (typeof proc?.getBuiltinModule !== 'function') return null;
  const fs = proc.getBuiltinModule('node:fs');
  const url = proc.getBuiltinModule('node:url');
  return fs.readFileSync(url.fileURLToPath(import.meta.resolve('harfbuzzjs/dist/harfbuzz.wasm')));
}

/**
 * Loads HarfBuzz's WebAssembly once and makes it the shaper. In node it
 * reads the module beside harfbuzzjs; in a browser pass the URL of
 * `harfbuzz.wasm` (from harfbuzzjs's `dist`, copied beside the page), a
 * Response, its bytes or the compiled module. Text measured before it is
 * set keeps the typefaces' advances until it is laid out again, so a page
 * awaits it before it renders shaped text.
 * @param {string | URL | Response | ArrayBuffer | Uint8Array | WebAssembly.Module} [source]
 * @returns {Promise<void>}
 */
export function loadShaper(source) {
  if (loaded) return Promise.resolve();
  if (source === undefined) source = beside() ?? undefined;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source) || source instanceof WebAssembly.Module) {
    // Bad bytes reject, as any failed load does; they are not thrown.
    try {
      now(/** @type {any} */ (source));
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve();
  }
  if (source === undefined) return Promise.reject(new Error('REN canv: loadShaper needs the URL or the bytes of harfbuzz.wasm here'));
  const given = source;
  return (loading ??= (async () => {
    const response = given instanceof Response ? given : await fetch(given);
    if (!response.ok) throw new Error(`REN canv: harfbuzz.wasm did not load (${response.status})`);
    const b = bound();
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), /** @type {any} */ (b.imports));
    b.set(instance);
    ready(instance);
  })().catch(e => {
    // A failed load (a fetch that failed) may be tried again.
    loading = null;
    throw e;
  }));
}

/**
 * The shaper, loaded on demand where it can be at once: in node, the first
 * time text needs one, unless a shaper was set or none chosen
 * (`useShaper`). Elsewhere `loadShaper` loads it.
 */
export function demand() {
  if (loaded || tried || settled()) return;
  tried = true;
  try {
    const bytes = beside();
    if (bytes !== null) now(bytes);
  } catch {
    // No module beside harfbuzzjs: text keeps the typefaces' advances.
  }
}

/** Whether `demand` tried to load the shaper once. */
let tried = false;
