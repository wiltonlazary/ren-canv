// What a renderer package builds on besides the Document: fonts read from
// the font file itself (Sfnt), the 2D canvas replay (Replay2D, checked
// against a recording context: node has no 2D canvas), a page that fits
// its content, and an attach that leaves input to the host.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window as HappyWindow } from 'happy-dom';
import { View, Label, Edit } from 'ren-core';
import { Document, Sfnt, render, attach, loadLayout } from 'ren-canv';
import { Replay2D, Frame, Damage, SHADOW, RTL, SLOT } from 'ren-canv/backend';
import { RSHADOW } from '../src/draw.js';

/** The happy-dom windows this file's tests open, each closed after its test (its window.close() frees nothing). @type {HappyWindow[]} */
const windows = [];
/** happy-dom's Window, tracked for closing. */
class Window extends HappyWindow {
  /** @param {ConstructorParameters<typeof HappyWindow>} args */
  constructor(...args) {
    super(...args);
    windows.push(this);
  }
}
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

/** The layout engine (Taffy's WebAssembly), once, before any Document. */
await loadLayout();

/** DejaVu Sans (test/fixtures, with its license): 2048 units per em. */
const font = readFileSync(new URL('./fixtures/dejavu.ttf', import.meta.url));

describe('ren canv backend', () => {
  it('reads advances and metrics from the font file', () => {
    const fonts = new Sfnt(font);
    assert.equal(fonts.units, 2048);
    // DejaVu Sans: a space is 651 units, 'a' 1255.
    assert.equal(fonts.width(' ', 2048), 651);
    assert.equal(fonts.width('a', 2048), 1255);
    assert.equal(fonts.width('aa a', 17), fonts.width('aa', 17) * 1.5 + fonts.width(' ', 17), 'widths add up');
    assert.deepEqual(fonts.metrics(2048), { ascent: 1901, descent: 483 });
    assert.ok(fonts.width('日😀', 20) > 0, 'a missing glyph measures as the missing glyph');
    // A fractional size is set down to a 64th, as Chrome sets text (FreeType's 26.6 sizes): headless
    // Chrome makes 'Documents and the quick brown fox' at 10.4px as wide as at 10.390625px.
    assert.equal(fonts.sized(10.4), 10.390625);
    assert.equal(fonts.width('a', 10.4), fonts.width('a', 10.390625));
    assert.deepEqual(fonts.metrics(10.4), fonts.metrics(10.390625));
    assert.equal(fonts.sized(16), 16);
    fonts.close();
  });

  it('keeps widths and heights for a bounded number of set sizes (an animated font size)', () => {
    const fonts = new Sfnt(font);
    const fresh = new Sfnt(font);
    // 500 font sizes, as a style animating fontSize gives, each measured as layout does.
    for (let k = 0; k < 500; k++) {
      const size = 12 + k * 0.01;
      assert.equal(fonts.width('animated', size), fresh.width('animated', fresh.sized(size)));
      assert.deepEqual(fonts.metrics(size), fresh.metrics(fresh.sized(size)));
      fresh.close();
    }
    assert.ok(fonts.sizes.size <= 64, `${fonts.sizes.size} width caches`);
    assert.ok(fonts.heights.size <= 64, `${fonts.heights.size} height entries`);
    // Keyed by the size text is set at: sizes within one 64th share an entry.
    fonts.width('a', 20);
    fonts.width('a', 20.01);
    fonts.metrics(20);
    fonts.metrics(20.01);
    assert.equal([...fonts.sizes.keys()].filter(s => s >= 20).length, 1);
    assert.equal([...fonts.heights.keys()].filter(s => s >= 20).length, 1);
    // Still right after the churn, including the most recent sizes kept.
    assert.equal(fonts.width('a', 2048), 1255);
    assert.equal(fonts.width('animated', 16.99), fresh.width('animated', 16.984375));
    fonts.close();
  });

  it('replays text in its typeface slot\'s family, and a right-to-left piece from its right edge', () => {
    /** @type {any[]} */
    const calls = [];
    const ctx = /** @type {any} */ (new Proxy({ canvas: { width: 200, height: 100 }, globalAlpha: 1, direction: 'inherit' }, {
      get: (target, name) => (name in target ? /** @type {any} */ (target)[name] : (/** @type {any[]} */ ...args) => void calls.push([String(name), ...args])),
      set: (target, name, value) => {
        calls.push([`=${String(name)}`, value]);
        /** @type {any} */ (target)[name] = value;
        return true;
      },
    }));
    const frame = new Frame();
    frame.text('ab', 5, 15, 16, 0xff000000, 2 << SLOT);
    frame.text('\u05d0\u05d1', 40, 15, 16, 0xff000000, RTL | 4);
    frame.end();
    new Replay2D('Face', null, () => {}, 'Mono', () => {}, () => {}, [null, 'Named', 'Backup']).run(ctx, frame, 1, 0);
    const text = calls.filter(c => c[0] === '=font' || c[0] === '=direction' || c[0] === 'fillText');
    assert.deepEqual(text, [
      ['=font', '16px "Backup"'],
      ['fillText', 'ab', 5, 15],
      ['=font', '16px "Mono"'],
      ['=direction', 'rtl'],
      ['fillText', '\u05d0\u05d1', 40, 15],
      ['=direction', 'inherit'],
    ], "slot 2's family; right to left, the browser sets the run in its visual order from x, its right edge");
  });

  it('replays commands on a 2D context: text with its font, boxes, borders, clips and layers', () => {
    /** @type {any[]} */
    const calls = [];
    const record = (/** @type {string} */ name) => (/** @type {any[]} */ ...args) => void calls.push([name, ...args]);
    const ctx = /** @type {any} */ (new Proxy({ canvas: { width: 200, height: 100 }, globalAlpha: 1 }, {
      get: (target, name) => (name in target ? /** @type {any} */ (target)[name] : record(String(name))),
      set: (target, name, value) => {
        calls.push([`=${String(name)}`, value]);
        /** @type {any} */ (target)[name] = value;
        return true;
      },
    }));
    const frame = new Frame();
    frame.enter(0, 0, 200, 100);
    frame.layer(0.5);
    frame.rect(0, 0, 10, 10, 0xff336699);
    frame.edge(10, 0, 0, 20, 20, 0xff000000, 4, 2);
    frame.text('hi', 5, 15, 17, 0xff000000, 3);
    frame.leave();
    frame.leave();
    frame.end();
    const replay = new Replay2D('Face');
    replay.run(ctx, frame, 2, 0);
    const names = calls.map(c => c[0]);
    assert.deepEqual(calls.find(c => c[0] === 'setTransform'), ['setTransform', 2, 0, 0, 2, 0, 0], 'scaled to device pixels');
    assert.deepEqual(calls.find(c => c[0] === 'clearRect'), ['clearRect', 0, 0, 100, 50], 'a transparent background: cleared, not filled');
    assert.deepEqual(calls.find(c => c[0] === '=font'), ['=font', 'italic bold 17px "Face"']);
    assert.deepEqual(calls.find(c => c[0] === 'fillText'), ['fillText', 'hi', 5, 15]);
    assert.deepEqual(calls.find(c => c[0] === '=globalAlpha'), ['=globalAlpha', 0.5]);
    assert.deepEqual(calls.find(c => c[0] === '=lineWidth'), ['=lineWidth', 2], 'the border stroke');
    assert.deepEqual(calls.find(c => c[0] === '=fontKerning'), ['=fontKerning', 'none'], 'glyphs land where the measure put them');
    assert.deepEqual(calls.find(c => c[0] === '=textRendering'), ['=textRendering', 'optimizeSpeed'], 'no optional ligatures (fi, ffi): as measured');
    assert.equal(names.filter(n => n === 'save').length, names.filter(n => n === 'restore').length, 'saves and restores balance');
    // Damage: only the commands that reach the rectangle, clipped to it.
    calls.length = 0;
    const damage = new Damage();
    damage.add(100, 50, 120, 60, 200, 100);
    replay.run(ctx, frame, 1, 0xffffffff, damage);
    assert.deepEqual(calls.find(c => c[0] === 'clearRect'), ['clearRect', 100, 50, 20, 10]);
    assert.ok(!calls.some(c => c[0] === 'fillText'), 'the text is outside');
    // Shifted under a device pixel (a Document's shift): translated, a damaged rectangle widened to the device pixels it touches.
    calls.length = 0;
    const moved = new Damage();
    moved.add(100, 50, 120, 60, 200, 100);
    replay.run(ctx, frame, 1, 0xffffffff, moved, -0.5, 0.25);
    assert.deepEqual(calls.find(c => c[0] === 'setTransform'), ['setTransform', 1, 0, 0, 1, -0.5, 0.25]);
    assert.deepEqual(calls.find(c => c[0] === 'clearRect'), ['clearRect', 99.5, 49.75, 21, 11]);
    // At a fractional scale, unshifted (a ren-three panel), whole logical pixels fall between device ones:
    // the rectangle still takes the device pixels it touches whole, or a moved item leaves a trace.
    calls.length = 0;
    const fraction = new Damage();
    fraction.add(101, 51, 121, 61, 200, 100);
    replay.run(ctx, frame, 1.5, 0xffffffff, fraction);
    const [, x, y, w, h] = calls.find(c => c[0] === 'clearRect');
    assert.deepEqual([x * 1.5, y * 1.5, (x + w) * 1.5, (y + h) * 1.5].map(v => Math.round(v * 1e6) / 1e6), [151, 76, 182, 92]);
  });

  it('replays a shadow under the item\'s transform: rotated, scaled, and in place with none', () => {
    /**
     * A 2D context that keeps its transform and, as the canvas spec says,
     * places a fill's shadow at the transformed points plus the shadow
     * offset, untransformed, in device pixels.
     */
    const context = () => {
      let m = [1, 0, 0, 1, 0, 0];
      /** @type {any[]} */
      const stack = [];
      /** @type {number[][]} */
      let points = [];
      /** @type {number[][]} */
      const shadows = [];
      /** @param {number[]} a @param {number[]} b */
      const times = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
      /** @param {number} x @param {number} y */
      const point = (x, y) => void points.push([m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const ctx = {
        canvas: { width: 400, height: 400 },
        shadowColor: '',
        shadowBlur: 0,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        fillStyle: '',
        save() {
          stack.push([m, this.shadowBlur, this.shadowOffsetX, this.shadowOffsetY]);
        },
        restore() {
          [m, this.shadowBlur, this.shadowOffsetX, this.shadowOffsetY] = stack.pop();
        },
        getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
        setTransform: (/** @type {number[]} */ ...t) => void (m = t),
        transform: (/** @type {number[]} */ ...t) => void (m = times(m, t)),
        beginPath: () => void (points = []),
        moveTo: point,
        lineTo: point,
        arcTo: (/** @type {number} */ x1, /** @type {number} */ y1, /** @type {number} */ x2, /** @type {number} */ y2) => (point(x1, y1), point(x2, y2)),
        rect: (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w, /** @type {number} */ h) => (point(x, y), point(x + w, y + h)),
        fill() {
          if (this.shadowOffsetX === 0 && this.shadowOffsetY === 0) return;
          const xs = points.map(p => p[0] + this.shadowOffsetX);
          const ys = points.map(p => p[1] + this.shadowOffsetY);
          shadows.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), this.shadowBlur].map(v => Math.round(v * 1000) / 1000));
        },
        closePath() {}, clearRect() {}, fillRect() {}, clip() {}, stroke() {}, setLineDash() {}, fillText() {},
      };
      return { ctx, shadows };
    };
    for (const [name, t, scale, want] of /** @type {[string, number[] | null, number, number[]][]} */ ([
      ['none', null, 1, [50, 90, 150, 110, 4]],
      ['none at a device scale of 1.5', null, 1.5, [75, 135, 225, 165, 6]],
      ['rotate 90 about (100, 100)', [0, 1, -1, 0, 200, 0], 1, [90, 50, 110, 150, 4]],
      ['scale 2', [2, 0, 0, 2, 0, 0], 1, [100, 180, 300, 220, 8]],
    ]))
      for (const op of [SHADOW, RSHADOW]) {
        const frame = new Frame();
        frame.enter(0, 0, 400, 400);
        if (t !== null) frame.transform(Float64Array.from(t));
        if (op === SHADOW) frame.edge(SHADOW, 50, 90, 150, 110, 0xff000000, 0, 4);
        else frame.corners(RSHADOW, 50, 90, 150, 110, 0xff000000, 4, Float64Array.from([2, 2, 2, 2]));
        if (t !== null) frame.leave();
        frame.leave();
        frame.end();
        const { ctx, shadows } = context();
        new Replay2D('Face').run(/** @type {any} */ (ctx), frame, scale, 0);
        assert.deepEqual(shadows, [want], `${op === SHADOW ? 'a shadow' : 'a shadow with corners'}, ${name}`);
      }
  });

  it('replays a shade as the fill of the next figure alone', () => {
    /** @type {any[]} */
    const calls = [];
    /** @type {any[]} */
    const fills = [];
    const gradient = { stops: /** @type {any[]} */ ([]), addColorStop(/** @type {number} */ at, /** @type {string} */ color) {
      this.stops.push([at, color]);
    } };
    const ctx = /** @type {any} */ (new Proxy({ canvas: { width: 200, height: 100 } }, {
      get: (target, name) => {
        if (name === 'createLinearGradient') return (/** @type {number[]} */ ...args) => (calls.push(['linear', ...args]), gradient);
        return name in target ? /** @type {any} */ (target)[name] : (/** @type {any[]} */ ...args) => void calls.push([String(name), ...args]);
      },
      set: (target, name, value) => {
        if (name === 'fillStyle') fills.push(value);
        /** @type {any} */ (target)[name] = value;
        return true;
      },
    }));
    const frame = new Frame();
    frame.shade(0, 0, 40, 20, { radial: false, angle: 90, stops: [0, 0xffff0000, 1, 0xff0000ff] });
    frame.rect(0, 0, 40, 20, 0xff000000);
    frame.rect(50, 0, 60, 10, 0xff00ff00);
    frame.end();
    new Replay2D('Face').run(ctx, frame, 1, 0);
    assert.deepEqual(calls.find(c => c[0] === 'linear')?.slice(1).map((/** @type {number} */ v) => Math.round(v * 1000) / 1000), [0, 10, 40, 10], 'along the box, at 90 degrees');
    assert.deepEqual(gradient.stops, [[0, 'rgba(255,0,0,1)'], [1, 'rgba(0,0,255,1)']]);
    assert.equal(fills[0], gradient, 'the next fill takes it');
    assert.equal(fills[1], 'rgba(0,255,0,1)', 'the one after takes its own color');
  });

  it('replays a fitted image in its box, and reports a source that fails', async () => {
    /** @type {any[]} */
    const calls = [];
    const ctx = /** @type {any} */ (new Proxy({ canvas: { width: 200, height: 100 } }, { get: (target, name) => (name in target ? /** @type {any} */ (target)[name] : (/** @type {any[]} */ ...args) => void calls.push([String(name), ...args])), set: () => true }));
    /** @type {string[]} */
    const failed = [];
    const image = { width: 100, height: 50 };
    /** @type {(value?: any) => void} */
    let loaded = () => {};
    /** @type {(value?: any) => void} */
    let reported = () => {};
    const both = Promise.all([new Promise(resolve => (loaded = resolve)), new Promise(resolve => (reported = resolve))]);
    const replay = new Replay2D('Face', source => (source === 'ok.png' ? image : Promise.reject(new Error('404'))), () => loaded(), null, source => {
      failed.push(source);
      reported();
    });
    replay.image('ok.png');
    replay.image('gone.png');
    // The one loaded asks for a redraw, the one that failed is reported.
    await both;
    assert.deepEqual(failed, ['gone.png']);
    const frame = new Frame();
    frame.image('ok.png', 0, 0, 40, 40, 1);
    frame.image('ok.png', 0, 0, 40, 40, 2);
    frame.end();
    replay.run(ctx, frame, 1, 0);
    const draws = calls.filter(c => c[0] === 'drawImage').map(c => c.slice(2));
    assert.deepEqual(draws, [[0, 10, 40, 20], [-20, 0, 80, 40]], 'contain, then cover (cut by a clip)');
  });

  it('reports a failed source that leaves the cache (forgot), and loads it again when drawn next', async () => {
    let loads = 0;
    /** @type {string[]} */
    const failed = [];
    /** @type {string[]} */
    const forgotten = [];
    const replay = new Replay2D('Face', source => {
      if (source !== 'bad.png') return /** @type {any} */ ({ width: 1, height: 1 });
      loads++;
      throw new Error('404');
    }, () => {}, null, source => failed.push(source), source => forgotten.push(source));
    replay.image('bad.png');
    await Promise.resolve();
    assert.deepEqual(failed, ['bad.png']);
    // Whole repaints of 40 other images push it out of the cache.
    for (let f = 0; f < 3; f++) {
      replay.frame++;
      replay.whole = replay.frame;
      for (let i = 0; i < 40; i++) replay.image(`ok${f}-${i}.png`);
      replay.evict();
    }
    assert.deepEqual(forgotten, ['bad.png'], 'its failure is let go with it');
    replay.frame++;
    replay.image('bad.png');
    assert.equal(loads, 2, 'drawn again, it is loaded again');
  });

  it('keeps at most the cache size when it has no loader', () => {
    const ctx = /** @type {any} */ (new Proxy({ canvas: { width: 200, height: 100 } }, { get: (target, name) => (name in target ? /** @type {any} */ (target)[name] : () => {}), set: () => true }));
    const replay = new Replay2D('Face');
    for (let i = 0; i < 40; i++) {
      const frame = new Frame();
      frame.image(`${i}.png`, 0, 0, 10, 10, 1);
      frame.end();
      replay.run(ctx, frame, 1, 0);
    }
    assert.ok(/** @type {any} */ (replay).images.size <= 32, 'no source stays marked loading');
  });

  // The image cache's contract (canvas2d.js, above IMAGES), a case each.
  /** A replay counting loads that settle between frames, and a frame of images. */
  const cache = () => {
    const ctx = /** @type {any} */ (new Proxy({ canvas: { width: 200, height: 100 } }, { get: (target, name) => (name in target ? /** @type {any} */ (target)[name] : () => {}), set: () => true }));
    const counted = { loads: 0 };
    /** @type {Promise<any>[]} */
    const pending = [];
    const replay = new Replay2D('Face', () => {
      counted.loads++;
      const load = Promise.resolve({ width: 1, height: 1 });
      pending.push(load);
      return load;
    });
    /** @param {Frame} frame @param {Damage | null} [damage] */
    const draw = async (frame, damage = null) => {
      replay.run(ctx, frame, 1, 0, damage);
      // The loads settle between frames (the replay's own `then` came first).
      await Promise.all(pending.splice(0));
    };
    return { replay, counted, draw };
  };
  /** A frame of these images in a row, and a box away from them. @param {string[]} sources */
  const row = sources => {
    const frame = new Frame();
    sources.forEach((source, k) => frame.image(source, k, 0, k + 1, 1, 0));
    frame.rect(150, 50, 160, 60, 0xff336699);
    frame.end();
    return frame;
  };
  const forty = Array.from({ length: 40 }, (_, k) => `${k}.png`);

  it('image cache (a) steady: 40 images over several whole frames load 40 times', async () => {
    const { counted, draw } = cache();
    for (let n = 0; n < 5; n++) await draw(row(forty));
    assert.equal(counted.loads, 40);
  });

  it('image cache (b) prepend: a new image drawn first loads once more, evicting nothing mid-frame', async () => {
    const { counted, draw } = cache();
    for (let n = 0; n < 3; n++) await draw(row(forty));
    await draw(row(['new.png', ...forty]));
    assert.equal(counted.loads, 41, 'only the new image loads');
    await draw(row(['new.png', ...forty]));
    assert.equal(counted.loads, 41, 'and none the frame after');
  });

  it('image cache (c) shrink: fewer drawn whole, back to at most the cache size, keeping those drawn', async () => {
    const { replay, counted, draw } = cache();
    for (let n = 0; n < 3; n++) await draw(row(forty));
    await draw(row(forty.slice(0, 5)));
    assert.ok(replay.images.size <= 32, `${replay.images.size} cached`);
    for (const source of forty.slice(0, 5)) assert.ok(replay.images.has(source), `${source} kept`);
    assert.equal(counted.loads, 40);
  });

  it('image cache (d) damage-only frame: images it does not reach stay, still on screen', async () => {
    const { replay, counted, draw } = cache();
    await draw(row(forty));
    await draw(row(forty));
    // Damage away from the images: they are not drawn, yet still shown.
    const damage = new Damage();
    damage.add(150, 50, 160, 60, 200, 100);
    await draw(row(forty), damage);
    assert.equal(replay.images.size, 40, 'none evicted while on screen');
    await draw(row(forty));
    assert.equal(counted.loads, 40, 'the next whole repaint reloads none');
  });

  it('image cache (e) scroll-box churn: 500 damage-only frames of a new image each stay bounded', async () => {
    const { replay, counted, draw } = cache();
    await draw(row(forty));
    let most = 0;
    for (let k = 0; k < 500; k++) {
      // A small box scrolls through thumbnails beside the 40, one new each frame.
      const frame = new Frame();
      forty.forEach((source, i) => frame.image(source, i, 0, i + 1, 1, 0));
      frame.image(`thumb${k}.png`, 150, 50, 160, 60, 0);
      frame.end();
      const damage = new Damage();
      damage.add(150, 50, 160, 60, 200, 100);
      await draw(frame, damage);
      most = Math.max(most, replay.images.size);
      for (const source of forty) assert.ok(replay.images.has(source), `${source} on screen, kept`);
      assert.ok(replay.images.has(`thumb${k}.png`), 'the one in the box kept');
    }
    // Past what a whole repaint kept (the 40 and the box's one) by the cache size, a frame is drawn whole.
    assert.ok(most <= 41 + 32 + 1, `at most ${most} cached`);
    assert.equal(counted.loads, 540, 'no image on screen reloads');
  });

  it('image cache (e) with no more than the cache size on screen: at most 2 × 32 + 1', async () => {
    const { replay, draw } = cache();
    await draw(row([]));
    let most = 0;
    for (let k = 0; k < 500; k++) {
      const frame = new Frame();
      frame.image(`thumb${k}.png`, 0, 0, 10, 10, 0);
      frame.end();
      const damage = new Damage();
      damage.add(0, 0, 10, 10, 200, 100);
      await draw(frame, damage);
      most = Math.max(most, replay.images.size);
      assert.ok(replay.images.has(`thumb${k}.png`));
    }
    assert.ok(most <= 2 * 32 + 1, `at most ${most} cached`);
  });

  it('image cache (f) marks a source whose loader throws failed, without aborting the frame', async () => {
    /** @type {string[]} */
    const calls = [];
    const ctx = /** @type {any} */ (new Proxy({ canvas: { width: 200, height: 100 } }, { get: (target, name) => (name in target ? /** @type {any} */ (target)[name] : () => void calls.push(String(name))), set: () => true }));
    /** @type {string[]} */
    const failed = [];
    let loads = 0;
    const replay = new Replay2D('Face', source => {
      loads++;
      if (source === 'bad.png') throw new Error('no such image');
      return { width: 1, height: 1 };
    }, () => {}, null, source => void failed.push(source));
    const frame = new Frame();
    frame.enter(0, 0, 200, 100);
    frame.image('bad.png', 0, 0, 10, 10, 0);
    frame.leave();
    frame.rect(0, 0, 10, 10, 0xff336699);
    frame.end();
    replay.run(ctx, frame, 1, 0);
    assert.equal(calls.filter(n => n === 'save').length, calls.filter(n => n === 'restore').length, 'saves and restores balance');
    assert.ok(calls.includes('fillRect'), 'the frame went on past the image');
    assert.deepEqual(replay.images.get('bad.png'), { image: null, loading: false, drawn: 1, failed: true });
    assert.deepEqual(failed, [], 'told after the frame');
    await Promise.resolve();
    assert.deepEqual(failed, ['bad.png']);
    replay.run(ctx, frame, 1, 0);
    assert.equal(loads, 1, 'a failed source is not retried while cached');
  });

  it('fits a page to its content', () => {
    const fonts = new Sfnt(font);
    const doc = new Document(fonts, { fit: true, width: 1, height: 1 });
    render(() => <View style={{ padding: 10 }}><Label text="fits" /></View>, doc);
    assert.equal(doc.width, Math.ceil(20 + fonts.width('fits', 17)));
    assert.equal(doc.height, Math.ceil(20 + 17 * 1.4));
    doc.close();
  });

  it('attaches only the entry and the mirror when the host routes input', () => {
    const window = new Window();
    const canvas = window.document.createElement('canvas');
    window.document.body.appendChild(canvas);
    /** @type {string[]} */
    const listened = [];
    const add = canvas.addEventListener.bind(canvas);
    canvas.addEventListener = /** @type {any} */ ((/** @type {string} */ name, /** @type {any} */ fn, /** @type {any} */ o) => {
      listened.push(name);
      add(name, fn, o);
    });
    const doc = new Document(new Sfnt(font), { width: 200, height: 100 });
    render(() => <View><Edit value="" /></View>, doc);
    const stop = attach(doc, canvas, { input: false });
    assert.deepEqual(listened, []);
    assert.ok(window.document.querySelector('[data-ren-entry]') && window.document.querySelector('[data-ren-aria]'));
    stop();
    doc.close();
  });

  it('keeps distant damage apart: many small changes are not one whole repaint', () => {
    const damage = new Damage();
    // Ten changes on a 5 x 2 grid, far apart: ten rectangles.
    for (let i = 0; i < 10; i++) damage.add((i % 5) * 200, Math.floor(i / 5) * 300, (i % 5) * 200 + 20, Math.floor(i / 5) * 300 + 20, 1000, 600);
    assert.equal(damage.n, 10);
    // Twenty: within the limit, each joined to its nearest; far less than the whole page.
    for (let i = 0; i < 10; i++) damage.add((i % 5) * 200 + 60, Math.floor(i / 5) * 300 + 100, (i % 5) * 200 + 80, Math.floor(i / 5) * 300 + 120, 1000, 600);
    assert.ok(damage.n <= 16 && damage.n > 1, `${damage.n} rectangles`);
    assert.ok(damage.area() < 1000 * 600 * 0.25, `area ${damage.area()}`);
  });
});
