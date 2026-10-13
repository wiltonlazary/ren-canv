// The 2D canvas executor: replays a frame's flat command buffer (draw.js's
// vocabulary) on a CanvasRenderingContext2D, whole or only inside the
// damaged rectangles. ren-three draws its primitives with it into a canvas
// that becomes a three.js texture; any page can use it without CanvasKit.
//
// Text is drawn in the named font family (the application registers the
// face, e.g. with a FontFace made from the same bytes Sfnt measures) with
// kerning and the optional ligatures off, so glyphs land where the measure
// put them; the browser shapes what needs it (joined scripts, clusters,
// marks), as Sfnt measures it shaped. Bold and italic
// ask the browser for the face's bold and italic, synthesized from the one
// face when there is none (as CanvasKit's embolden and skew do).

import { TEXT_OP, RECT, ROUND, CLIP, SAVE, RESTORE, LINE, OVAL, PATH, IMAGE_OP, BORDER, SHADOW, LAYER, RCLIP, RROUND, RBORDER, RSHADOW, DASH, EDGES, GRADIENT, TRANSFORM, PICTURE, SHADE, BOLD, ITALIC, operands } from './draw.js';
import { MONO, RTL, SLOT } from './text.js';

/** @typedef {import('./draw.js').Frame} Frame */
/** @typedef {import('./draw.js').Damage} Damage */

/**
 * Loads an image source into something `drawImage` draws; null when there is none.
 * @typedef {(source: string) => CanvasImageSource | Promise<CanvasImageSource | null> | null} Picture
 */

/**
 * The image cache's size. The cache's contract (ren-skia's Replay keeps the same
 * eviction rule; there a load that finishes between frames evicts at once, here
 * it asks for a redraw and that frame's `run` evicts):
 * - nothing is evicted during a frame (`run`): an image a frame draws stays
 *   until the frame ends, however many it draws;
 * - at the end of `run`, the least recently drawn entries that are neither
 *   loading nor drawn since the last whole repaint (a `run` without damage)
 *   go, until at most IMAGES remain (or none of the rest may go): a
 *   damage-only frame skips what lies outside its damage, so an image not
 *   drawn in it may still be on screen;
 * - bounded under damage repaint: a damage-only frame that starts with more
 *   than IMAGES entries beyond what the last whole repaint kept (at least
 *   IMAGES) is drawn whole instead (the same pixels), so what left the
 *   screen may go. Between frames the cache so holds at most that many plus
 *   the new images one frame draws: 2 × IMAGES + 1 for one new image a frame
 *   over at most IMAGES on screen, with no load pending (a load in flight is
 *   kept until it settles). No image on screen is evicted;
 * - a loader that throws or rejects (or gives null) marks its entry failed
 *   (not loading, no image; kept, so not retried while cached) and reports
 *   the source to `failed` after the frame; it never aborts the frame.
 */
const IMAGES = 32;

/** An ARGB color as a CSS color. @param {number} c */
const css = c => `rgba(${(c >>> 16) & 255},${(c >>> 8) & 255},${c & 255},${((c >>> 24) & 255) / 255})`;

export class Replay2D {
  /**
   * @param {string} family the font family text is drawn in
   * @param {Picture | null} [load] loads an Image source
   * @param {() => void} [redraw] called when an image finishes loading
   * @param {string | null} [mono] the family text in the monospace face (flag 4) is drawn in; `family` without one
   * @param {(source: string) => void} [failed] called when an image source fails to load (a Document's `failed`)
   * @param {(source: string) => void} [forgot] called when a failed source leaves the cache, so a later draw loads it again (a Document's `forgot`)
   * @param {readonly (string | null)[]} [faces] the family each typeface slot of a text command is drawn in, by slot (Faces's: the named typefaces, then the fallbacks); `family` (or `mono`) for a slot without one
   */
  constructor(family, load = null, redraw = () => {}, mono = null, failed = () => {}, forgot = () => {}, faces = []) {
    this.failed = failed;
    this.forgot = forgot;
    /** The shift of the frame being drawn (`run`). */
    this.sx = 0;
    this.sy = 0;
    this.family = family;
    this.mono = mono;
    this.faces = faces;
    this.load = load;
    this.redraw = redraw;
    /** CSS colors by ARGB, cached. @type {Map<number, string>} */
    this.colors = new Map();
    /** Least recently drawn first; `drawn` is the frame (`run`) that last drew each. @type {Map<string, { image: CanvasImageSource | null, loading: boolean, drawn: number, failed: boolean }>} */
    this.images = new Map();
    /** The count of frames drawn, the current one's stamp. */
    this.frame = 0;
    /** The stamp of the last frame drawn whole (without damage). */
    this.whole = 0;
    /** What the last whole repaint left cached, at least IMAGES: past it by IMAGES, a damage-only frame is drawn whole. */
    this.kept = IMAGES;
  }

  /** @param {number} c */
  color(c) {
    let s = this.colors.get(c);
    if (s === undefined) {
      s = css(c);
      if (this.colors.size > 256) this.colors.clear();
      this.colors.set(c, s);
    }
    return s;
  }

  /**
   * Draws a frame on `ctx`, scaled, over a background (transparent when its
   * alpha is 0): all of it, or only inside `damage`'s rectangles, leaving
   * the rest as the previous frame left it. Shifted by `shiftX`, `shiftY`
   * logical pixels (a Document's, under a device pixel).
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx @param {Frame} frame @param {number} scale @param {number} background ARGB @param {Damage | null} [damage]
   * @param {number} [shiftX] @param {number} [shiftY]
   */
  run(ctx, frame, scale, background, damage = null, shiftX = 0, shiftY = 0) {
    this.frame++;
    this.sx = shiftX;
    this.sy = shiftY;
    // Damage keeps images it skips; past the bound, a whole repaint lets those off screen go.
    if (damage !== null && this.images.size > this.kept + IMAGES) damage = null;
    if (damage === null) this.whole = this.frame;
    if (damage === null) this.pass(ctx, frame, scale, background, -Infinity, -Infinity, Infinity, Infinity);
    else {
      const b = damage.box;
      for (let k = 0; k < damage.n * 4; k += 4) this.pass(ctx, frame, scale, background, b[k], b[k + 1], b[k + 2], b[k + 3]);
    }
    this.evict();
    if (damage === null) this.kept = Math.max(IMAGES, this.images.size);
  }

  /**
   * Replays the commands that can touch a rectangle, clipped to it and
   * cleared first; an infinite one clears and replays everything.
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx @param {Frame} frame @param {number} scale @param {number} background
   * @param {number} left @param {number} top @param {number} right @param {number} bottom
   */
  pass(ctx, frame, scale, background, left, top, right, bottom) {
    const o = frame.ops;
    const texts = frame.texts;
    const cull = left !== -Infinity;
    ctx.save();
    const sx = this.sx ?? 0;
    const sy = this.sy ?? 0;
    ctx.setTransform(scale, 0, 0, scale, sx * scale, sy * scale);
    if (cull) {
      // The rectangle takes the device pixels it touches whole (shifted, or
      // at a fractional scale): a pixel cleared in part keeps a trace of the
      // last frame.
      left = Math.floor((left + sx) * scale) / scale - sx;
      top = Math.floor((top + sy) * scale) / scale - sy;
      right = Math.ceil((right + sx) * scale) / scale - sx;
      bottom = Math.ceil((bottom + sy) * scale) / scale - sy;
    }
    if (cull) {
      ctx.beginPath();
      ctx.rect(left, top, right - left, bottom - top);
      ctx.clip();
      ctx.clearRect(left, top, right - left, bottom - top);
      if ((background >>> 24) !== 0) {
        ctx.fillStyle = this.color(background);
        ctx.fillRect(left, top, right - left, bottom - top);
      }
    } else {
      const canvas = ctx.canvas;
      // Shifted, the whole canvas from its corner.
      const shifted = sx !== 0 || sy !== 0;
      const x = shifted ? -sx : 0;
      const y = shifted ? -sy : 0;
      const w = canvas.width / scale + (shifted ? 1 : 0);
      const h = canvas.height / scale + (shifted ? 1 : 0);
      ctx.clearRect(x, y, w, h);
      if ((background >>> 24) !== 0) {
        ctx.fillStyle = this.color(background);
        ctx.fillRect(x, y, w, h);
      }
    }
    /** @type {any} */ (ctx).fontKerning = 'none';
    // No optional ligatures (fi, ffi), as text is measured; a script's own (Arabic's joining, lam-alef) stay.
    /** @type {any} */ (ctx).textRendering = 'optimizeSpeed';
    ctx.textBaseline = 'alphabetic';
    let depth = 0;
    /** The gradient the next fill takes (a Shape figure's fill), or null. @type {CanvasGradient | null} */
    let shade = null;
    // The depth a transform was set at (-1: none): inside one, boxes are not on the screen's axes, so nothing is culled.
    let bent = -1;
    let i = 0;
    let s = 0;
    try {
      while (i < frame.n) {
        const code = o[i++];
        if (cull && bent < 0 && code !== SAVE && code !== RESTORE && code !== CLIP && code !== PATH && code !== LAYER && code !== RCLIP && code !== DASH && code !== GRADIENT && code !== TRANSFORM) {
          let outside;
          if (code === TEXT_OP) {
            const size = o[i + 2];
            outside = o[i + 1] - size * 1.25 > bottom || o[i + 1] + size * 0.5 < top || o[i] > right;
          } else {
            const pad = code === LINE || code === OVAL ? o[i + 5] + 1 : code === SHADOW ? o[i + 6] * 1.5 + 1 : code === RSHADOW ? o[i + 5] * 1.5 + 1 : 1;
            outside = Math.min(o[i], o[i + 2]) - pad > right || Math.max(o[i], o[i + 2]) + pad < left || Math.min(o[i + 1], o[i + 3]) - pad > bottom || Math.max(o[i + 1], o[i + 3]) + pad < top;
          }
          if (outside) {
            if (code === TEXT_OP || code === IMAGE_OP || code === PICTURE) s++;
            // A shade's figure lies in its box: both are outside.
            else if (code === SHADE) i += o[i + 6] * 2;
            shade = null;
            i += operands[code];
            continue;
          }
        }
        switch (code) {
          case SAVE:
            ctx.save();
            depth++;
            continue;
          case RESTORE:
            if (depth > 0) {
              ctx.restore();
              depth--;
              if (depth < bent) bent = -1;
            }
            continue;
          case TRANSFORM:
            ctx.transform(o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5]);
            if (bent < 0) bent = depth;
            break;
          case LAYER:
            ctx.save();
            depth++;
            ctx.globalAlpha *= o[i];
            break;
          case CLIP:
            ctx.beginPath();
            ctx.rect(o[i], o[i + 1], o[i + 2] - o[i], o[i + 3] - o[i + 1]);
            ctx.clip();
            break;
          case RCLIP:
            ctx.beginPath();
            corners(ctx, o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5], o[i + 6], o[i + 7]);
            ctx.clip();
            break;
          case EDGES:
            this.edges(ctx, o, i);
            break;
          case GRADIENT: {
            const x = o[i];
            const y = o[i + 1];
            const right = o[i + 2];
            const bottom = o[i + 3];
            const count = o[i + 10];
            const [x0, y0, x1, y1, radius] = line(x, y, right, bottom, o[i + 8] === 1, o[i + 9]);
            const g = o[i + 8] === 1 ? ctx.createRadialGradient(x0, y0, 0, x0, y0, radius) : ctx.createLinearGradient(x0, y0, x1, y1);
            for (let k = 0; k < count; k++) g.addColorStop(o[i + 11 + k * 2], this.color(o[i + 12 + k * 2]));
            ctx.fillStyle = g;
            ctx.beginPath();
            corners(ctx, x, y, right, bottom, o[i + 4], o[i + 5], o[i + 6], o[i + 7]);
            ctx.fill();
            i += count * 2;
            break;
          }
          case SHADE: {
            const count = o[i + 6];
            const [x0, y0, x1, y1, radius] = line(o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 4] === 1, o[i + 5]);
            shade = o[i + 4] === 1 ? ctx.createRadialGradient(x0, y0, 0, x0, y0, radius) : ctx.createLinearGradient(x0, y0, x1, y1);
            for (let k = 0; k < count; k++) shade.addColorStop(o[i + 7 + k * 2], this.color(o[i + 8 + k * 2]));
            i += count * 2 + operands[code];
            continue;
          }
          case DASH: {
            const count = o[i + 1];
            /** @type {number[]} */
            const lengths = [];
            for (let k = 0; k < count; k++) lengths.push(o[i + 2 + k]);
            ctx.setLineDash(lengths);
            ctx.lineCap = o[i] === 1 ? 'round' : 'butt';
            i += count;
            break;
          }
          case RROUND:
            ctx.fillStyle = this.color(o[i + 4]);
            ctx.beginPath();
            corners(ctx, o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 5], o[i + 6], o[i + 7], o[i + 8]);
            ctx.fill();
            break;
          case RBORDER: {
            // A stroke inside the box: its middle half a width in, each radius following it.
            const w = o[i + 5];
            const h = w / 2;
            ctx.strokeStyle = this.color(o[i + 4]);
            ctx.lineWidth = w;
            ctx.beginPath();
            corners(ctx, o[i] + h, o[i + 1] + h, o[i + 2] - h, o[i + 3] - h, Math.max(0, o[i + 6] - h), Math.max(0, o[i + 7] - h), Math.max(0, o[i + 8] - h), Math.max(0, o[i + 9] - h));
            ctx.stroke();
            break;
          }
          case RSHADOW: {
            const far = 100000;
            ctx.save();
            ctx.shadowColor = this.color(o[i + 4]);
            shadowed(ctx, far, o[i + 5], scale);
            ctx.fillStyle = '#000';
            ctx.beginPath();
            corners(ctx, o[i] - far, o[i + 1], o[i + 2] - far, o[i + 3], o[i + 6], o[i + 7], o[i + 8], o[i + 9]);
            ctx.fill();
            ctx.restore();
            break;
          }
          case TEXT_OP: {
            const flags = o[i + 4];
            const named = this.faces[flags >>> SLOT] ?? null;
            ctx.font = `${(flags & ITALIC) !== 0 ? 'italic ' : ''}${(flags & BOLD) !== 0 ? 'bold ' : ''}${o[i + 2]}px "${named !== null ? named : (flags & MONO) !== 0 && this.mono !== null ? this.mono : this.family}"`;
            ctx.fillStyle = this.color(o[i + 3]);
            if ((flags & RTL) !== 0) {
              // Right to left from x, its right edge: the browser sets the run in its visual order, its brackets mirrored.
              const was = ctx.direction;
              ctx.direction = 'rtl';
              ctx.fillText(texts[s++], o[i], o[i + 1]);
              ctx.direction = was;
            } else ctx.fillText(texts[s++], o[i], o[i + 1]);
            break;
          }
          case RECT:
            ctx.fillStyle = shade ?? this.color(o[i + 4]);
            ctx.fillRect(o[i], o[i + 1], o[i + 2] - o[i], o[i + 3] - o[i + 1]);
            break;
          case ROUND:
            ctx.fillStyle = shade ?? this.color(o[i + 4]);
            ctx.beginPath();
            round(ctx, o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 5]);
            ctx.fill();
            break;
          case BORDER: {
            const w = o[i + 6];
            ctx.strokeStyle = this.color(o[i + 4]);
            ctx.lineWidth = w;
            ctx.beginPath();
            round(ctx, o[i] + w / 2, o[i + 1] + w / 2, o[i + 2] - w / 2, o[i + 3] - w / 2, Math.max(0, o[i + 5] - w / 2));
            ctx.stroke();
            break;
          }
          case SHADOW: {
            // The box drawn far off the canvas, its shadow brought back:
            // canvas shadowBlur is CSS's blur (both twice the sigma).
            const far = 100000;
            ctx.save();
            ctx.shadowColor = this.color(o[i + 4]);
            shadowed(ctx, far, o[i + 6], scale);
            ctx.fillStyle = '#000';
            ctx.beginPath();
            round(ctx, o[i] - far, o[i + 1], o[i + 2] - far, o[i + 3], o[i + 5]);
            ctx.fill();
            ctx.restore();
            break;
          }
          case LINE:
            ctx.strokeStyle = this.color(o[i + 4]);
            ctx.lineWidth = o[i + 5];
            ctx.beginPath();
            ctx.moveTo(o[i], o[i + 1]);
            ctx.lineTo(o[i + 2], o[i + 3]);
            ctx.stroke();
            break;
          case OVAL: {
            const cx = (o[i] + o[i + 2]) / 2;
            const cy = (o[i + 1] + o[i + 3]) / 2;
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.abs(o[i + 2] - o[i]) / 2, Math.abs(o[i + 3] - o[i + 1]) / 2, 0, 0, Math.PI * 2);
            if (o[i + 5] > 0) {
              ctx.strokeStyle = this.color(o[i + 4]);
              ctx.lineWidth = o[i + 5];
              ctx.stroke();
            } else {
              ctx.fillStyle = shade ?? this.color(o[i + 4]);
              ctx.fill();
            }
            break;
          }
          case PATH: {
            const stroke = o[i + 1];
            const closed = o[i + 2] !== 0;
            const count = o[i + 3];
            const p = i + 4;
            ctx.beginPath();
            ctx.moveTo(o[p], o[p + 1]);
            for (let k = 2; k < count; k += 2) ctx.lineTo(o[p + k], o[p + k + 1]);
            if (closed) ctx.closePath();
            if (!closed || stroke > 0) {
              ctx.strokeStyle = this.color(o[i]);
              ctx.lineWidth = stroke > 0 ? stroke : 1;
              ctx.stroke();
            } else {
              ctx.fillStyle = shade ?? this.color(o[i]);
              ctx.fill();
            }
            i += count;
            break;
          }
          case PICTURE: {
            const picture = this.image(texts[s++]);
            if (picture !== null) {
              const any = /** @type {any} */ (picture);
              fitted(any.naturalWidth ?? any.width, any.naturalHeight ?? any.height, o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 4]);
              ctx.save();
              ctx.beginPath();
              ctx.rect(o[i], o[i + 1], o[i + 2] - o[i], o[i + 3] - o[i + 1]);
              ctx.clip();
              ctx.drawImage(picture, FIT[0], FIT[1], FIT[2] - FIT[0], FIT[3] - FIT[1]);
              ctx.restore();
            }
            break;
          }
          case IMAGE_OP: {
            const picture = this.image(texts[s++]);
            if (picture !== null) ctx.drawImage(picture, o[i], o[i + 1], o[i + 2] - o[i], o[i + 3] - o[i + 1]);
            break;
          }
          default:
            throw new Error(`REN canv: unknown opcode ${code}`);
        }
        // A shade is its next fill's alone.
        shade = null;
        i += operands[code];
      }
    } finally {
      while (depth-- > 0) ctx.restore();
      ctx.restore();
    }
  }

  /**
   * A border with each side's own width and color (draw.js's edges
   * command at `o[i]`): solid, the ring between the box and its inner
   * box, each side's part cut at the corners' diagonals; dashed or dotted,
   * a stroke along the middle of each side.
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx @param {Float64Array} o @param {number} i
   */
  edges(ctx, o, i) {
    const x = o[i];
    const y = o[i + 1];
    const right = o[i + 2];
    const bottom = o[i + 3];
    const style = o[i + 8];
    const [t, r, b, l] = [o[i + 9], o[i + 10], o[i + 11], o[i + 12]];
    // The sides' parts, as outer then inner corners: top, right, bottom, left.
    const cut = [
      [x, y, right, y, right - r, y + t, x + l, y + t],
      [right, y, right, bottom, right - r, bottom - b, right - r, y + t],
      [right, bottom, x, bottom, x + l, bottom - b, right - r, bottom - b],
      [x, bottom, x, y, x + l, y + t, x + l, bottom - b],
    ];
    const widths = [t, r, b, l];
    for (let side = 0; side < 4; side++) {
      const w = widths[side];
      const color = o[i + 13 + side];
      if (w <= 0 || color >>> 24 === 0) continue;
      ctx.save();
      if (style === 0) {
        const p = cut[side];
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        for (let k = 2; k < 8; k += 2) ctx.lineTo(p[k], p[k + 1]);
        ctx.closePath();
        ctx.clip();
        ctx.beginPath();
        corners(ctx, x, y, right, bottom, o[i + 4], o[i + 5], o[i + 6], o[i + 7]);
        corners(ctx, x + l, y + t, right - r, bottom - b, Math.max(0, o[i + 4] - Math.max(l, t)), Math.max(0, o[i + 5] - Math.max(r, t)), Math.max(0, o[i + 6] - Math.max(r, b)), Math.max(0, o[i + 7] - Math.max(l, b)));
        ctx.fillStyle = this.color(color);
        ctx.fill('evenodd');
      } else {
        const p = cut[side];
        // The middle of the side, from corner to corner.
        const h = w / 2;
        const dx = side === 1 ? -h : side === 3 ? h : 0;
        const dy = side === 0 ? h : side === 2 ? -h : 0;
        ctx.setLineDash(style === 2 ? [0, 2 * w] : [3 * w, 3 * w]);
        ctx.lineCap = style === 2 ? 'round' : 'butt';
        ctx.lineWidth = w;
        ctx.strokeStyle = this.color(color);
        ctx.beginPath();
        ctx.moveTo(p[0] + dx, p[1] + dy);
        ctx.lineTo(p[2] + dx, p[3] + dy);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** The loaded image of a source, starting its load when it is new. @param {string} source @returns {CanvasImageSource | null} */
  image(source) {
    const known = this.images.get(source);
    if (known !== undefined) {
      known.drawn = this.frame;
      this.images.delete(source);
      this.images.set(source, known);
      return known.image;
    }
    const entry = { image: /** @type {CanvasImageSource | null} */ (null), loading: true, drawn: this.frame, failed: false };
    this.images.set(source, entry);
    const load = this.load;
    if (load === null) {
      entry.loading = false;
      return null;
    }
    /** @type {ReturnType<Picture>} */
    let loading;
    try {
      loading = load(source);
    } catch {
      // Told after the frame that asked for it (a handler may change the view).
      entry.loading = false;
      entry.failed = true;
      queueMicrotask(() => this.failed(source));
      return null;
    }
    Promise.resolve(loading).then(image => {
      entry.image = image;
      entry.loading = false;
      if (image !== null) this.redraw();
      else {
        entry.failed = true;
        this.failed(source);
      }
    }, () => {
      entry.loading = false;
      entry.failed = true;
      this.failed(source);
    });
    return null;
  }

  /** Between frames: over the size, drops the least recently drawn that is neither loading nor drawn since the last whole repaint. */
  evict() {
    for (const [source, entry] of this.images) {
      // Least recently drawn first: from the first drawn since the last whole repaint on, all were.
      if (this.images.size <= IMAGES || entry.drawn >= this.whole) break;
      if (entry.loading) continue;
      this.images.delete(source);
      // A failed source is loaded again when next drawn: its failure is no longer known.
      if (entry.failed) this.forgot(source);
    }
  }
}

/** An image's fitted box, reused: left, top, right, bottom. */
const FIT = new Float64Array(4);

/**
 * Where an image of `w` × `h` goes in a box, into FIT, as CSS's
 * object-fit: 1 contain (all of it, as large as fits), 2 cover (the box
 * filled, cut), 3 none (its own size), centered (object-position's
 * default); anything else fills the box.
 * @param {number} w @param {number} h @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} fit
 */
function fitted(w, h, x, y, right, bottom, fit) {
  const bw = right - x;
  const bh = bottom - y;
  let k = 1;
  if (!(w > 0 && h > 0) || fit < 1 || fit > 3) k = NaN;
  else if (fit === 1) k = Math.min(bw / w, bh / h);
  else if (fit === 2) k = Math.max(bw / w, bh / h);
  if (k !== k) {
    FIT[0] = x;
    FIT[1] = y;
    FIT[2] = right;
    FIT[3] = bottom;
    return FIT;
  }
  const dw = w * k;
  const dh = h * k;
  FIT[0] = x + (bw - dw) / 2;
  FIT[1] = y + (bh - dh) / 2;
  FIT[2] = FIT[0] + dw;
  FIT[3] = FIT[1] + dh;
  return FIT;
}

/**
 * Where a gradient runs in a box: a linear one along the line through its
 * center at `angle` degrees (0 up, 90 right) as long as CSS makes it (its
 * corners project onto its ends); a radial one from the center to the
 * farthest corner. Returns x0, y0, x1, y1 and the radius.
 * @param {number} x @param {number} y @param {number} right @param {number} bottom @param {boolean} radial @param {number} angle
 * @returns {[number, number, number, number, number]}
 */
function line(x, y, right, bottom, radial, angle) {
  const cx = (x + right) / 2;
  const cy = (y + bottom) / 2;
  const w = right - x;
  const h = bottom - y;
  if (radial) return [cx, cy, cx, cy, Math.sqrt(w * w + h * h) / 2];
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half, 0];
}

/**
 * Sets a shadow that brings back a box drawn `far` to its left: a canvas
 * places shadows in device pixels, untransformed, so the offset is the
 * current transform's image of (far, 0) (far times the scale with no
 * transform but the device scale; along the rotated axis under a rotate or
 * skew), and the blur (CSS's, twice the sigma) grows as that axis does.
 * @param {any} ctx @param {number} far @param {number} blur @param {number} scale the device scale, without `getTransform`
 */
function shadowed(ctx, far, blur, scale) {
  const t = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const a = t === null ? scale : t.a;
  const b = t === null ? 0 : t.b;
  ctx.shadowBlur = blur * Math.hypot(a, b);
  ctx.shadowOffsetX = far * a;
  ctx.shadowOffsetY = far * b;
}

/**
 * A path of a box with its own radius at each corner (top-left, top-right,
 * bottom-right, bottom-left), which the painter has already scaled to fit
 * as CSS does.
 * @param {any} ctx @param {number} x @param {number} y @param {number} right @param {number} bottom
 * @param {number} tl @param {number} tr @param {number} br @param {number} bl
 */
function corners(ctx, x, y, right, bottom, tl, tr, br, bl) {
  ctx.moveTo(x + tl, y);
  ctx.lineTo(right - tr, y);
  if (tr > 0) ctx.arcTo(right, y, right, y + tr, tr);
  ctx.lineTo(right, bottom - br);
  if (br > 0) ctx.arcTo(right, bottom, right - br, bottom, br);
  ctx.lineTo(x + bl, bottom);
  if (bl > 0) ctx.arcTo(x, bottom, x, bottom - bl, bl);
  ctx.lineTo(x, y + tl);
  if (tl > 0) ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

/** A rounded rectangle path (a plain one with no radius). @param {any} ctx @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} radius */
function round(ctx, x, y, right, bottom, radius) {
  const w = right - x;
  const h = bottom - y;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r === 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(right, y, right, bottom, r);
  ctx.arcTo(right, bottom, x, bottom, r);
  ctx.arcTo(x, bottom, x, y, r);
  ctx.arcTo(x, y, right, y, r);
  ctx.closePath();
}
