// Paint as CSS draws it: a box's content clipped to its rounded corners,
// per-corner radii, per-side borders and their styles, gradients,
// transforms and an Image's fit, in the frame's commands.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { View, Label, Shape, Image, Scroll } from 'ren-core';
import { Document, render, loadLayout } from 'ren-canv';

await loadLayout();

/** Every character is half its size wide. */
const mono = { width: (/** @type {string} */ text, /** @type {number} */ size) => (text.length * size) / 2, metrics: (/** @type {number} */ size) => ({ ascent: size * 0.8, descent: size * 0.2 }), close() {} };

/** A Document with a fixed measure and no surface. @param {any} [options] */
const page = options => new Document(mono, { width: 200, height: 200, ...options });

/** The commands of a frame named `name`. @param {Document} doc @param {string} name */
const named = (doc, name) => doc.commands().filter(c => c[0] === name);

describe('ren canv paint', () => {
  it("clips a box's content to its rounded padding box, as CSS clips overflow", () => {
    const doc = page();
    render(() => (
      <View style={{ padding: 10 }}>
        <View style={{ width: 100, height: 60, radius: 12, border: 2, overflow: 'hidden' }}>
          <View style={{ height: 60, background: '#ff0000' }} />
        </View>
        <View style={{ width: 100, height: 60, overflow: 'hidden' }}>
          <View style={{ height: 60, background: '#00ff00' }} />
        </View>
      </View>
    ), doc);
    doc.present();
    // The padding box of the first: inside its border; the radius less the border.
    assert.deepEqual(named(doc, 'rclip'), [['rclip', 12, 12, 108, 68, 10, 10, 10, 10]]);
    // A square box clips to its rectangle.
    assert.ok(named(doc, 'clip').some(c => c[1] === 10 && c[2] === 70 && c[3] === 110 && c[4] === 130));
    doc.close();
  });

  it('draws each corner with its own radius, scaled to fit as CSS scales them', () => {
    const doc = page();
    render(() => (
      <View style={{ padding: 10 }}>
        <View style={{ width: 100, height: 40, radius: [12, 0, 6, 0], border: 2, borderColor: '#000', background: '#ff0000', overflow: 'hidden' }}>
          <View style={{ height: 40, background: '#00ff00' }} />
        </View>
        <View style={{ width: 100, height: 40, radius: [40, 40, 0, 0], background: '#0000ff' }} />
        <View style={{ width: 100, height: 40, radius: [5, 5, 5, 5], background: '#0000ff' }} />
      </View>
    ), doc);
    doc.present();
    const rounds = named(doc, 'rround');
    assert.deepEqual(rounds[0], ['rround', 10, 10, 110, 50, '#ffff0000', 12, 0, 6, 0]);
    assert.deepEqual(rounds[1], ['rround', 10, 50, 110, 90, '#ff0000ff', 40, 40, 0, 0], 'two corners of 40 fit a side of 100');
    assert.deepEqual(named(doc, 'rborder'), [['rborder', 10, 10, 110, 50, '#ff000000', 2, 12, 0, 6, 0]]);
    assert.deepEqual(named(doc, 'rclip'), [['rclip', 12, 12, 108, 48, 10, 0, 4, 0]], 'the inner curve: each corner less the border');
    assert.ok(named(doc, 'round').some(c => c[5] === '#ff0000ff' && c[6] === 5), 'four equal corners draw as one radius');
    doc.close();
  });

  it('draws content that overflows a box of no height, as CSS shows overflow', () => {
    const doc = page();
    render(() => (
      <View style={{ padding: 10 }}>
        <View style={{ height: 0 }}>
          <Label text="overflow" />
        </View>
        <View style={{ height: 0, overflow: 'hidden' }}>
          <Label text="clipped" />
        </View>
      </View>
    ), doc);
    doc.present();
    assert.deepEqual(named(doc, 'text').map(c => c[1]), ['overflow']);
    doc.close();
  });

  it('outlines a Shape rect or round with a stroke, as SVG does, and fills it without', () => {
    const doc = page();
    render(() => (
      <Shape
        style={{ width: 100, height: 40 }}
        shapes={[
          { kind: 'rect', x: 0, y: 0, right: 20, bottom: 20, stroke: 2, color: '#000' },
          { kind: 'round', x: 30, y: 0, right: 50, bottom: 20, radius: 4, stroke: 2, color: '#000' },
          { kind: 'rect', x: 60, y: 0, right: 80, bottom: 20, color: '#000' },
        ]}
      />
    ), doc);
    doc.present();
    assert.deepEqual(named(doc, 'border'), [
      ['border', -1, -1, 21, 21, '#ff000000', 0, 2],
      ['border', 29, -1, 51, 21, '#ff000000', 5, 2],
    ], 'centered on the edges');
    assert.deepEqual(named(doc, 'rect').filter(c => c[5] === '#ff000000'), [['rect', 60, 0, 80, 20, '#ff000000']]);
    doc.close();
  });

  it("fills a Shape figure with its fill: a color, or a gradient over its bounds before it", () => {
    const doc = page();
    render(() => (
      <Shape
        style={{ width: 100, height: 40 }}
        shapes={[
          { kind: 'rect', x: 0, y: 0, right: 40, bottom: 20, fill: { linear: 90, stops: [[0, '#f00'], [1, '#00f']] } },
          { kind: 'oval', x: 50, y: 0, right: 70, bottom: 20, fill: { radial: true, stops: [[0, '#fff'], [1, '#000']] } },
          { kind: 'path', points: [0, 30, 20, 30, 10, 40], closed: true, fill: { linear: 0, stops: [[0, '#fff'], [1, '#000']] } },
          { kind: 'round', x: 80, y: 0, right: 100, bottom: 20, fill: '#0f0', color: '#00f' },
          { kind: 'rect', x: 80, y: 30, right: 90, bottom: 40, stroke: 2, fill: { linear: 0, stops: [[0, '#fff'], [1, '#000']] } },
        ]}
      />
    ), doc);
    doc.present();
    assert.deepEqual(named(doc, 'shade'), [
      ['shade', 0, 0, 40, 20, 0, 90, 2, 0, '#ffff0000', 1, '#ff0000ff'],
      ['shade', 50, 0, 70, 20, 1, 0, 2, 0, '#ffffffff', 1, '#ff000000'],
      ['shade', 0, 30, 20, 40, 0, 0, 2, 0, '#ffffffff', 1, '#ff000000'],
    ], 'over each bounds, a path its points\' box; a stroke is not shaded');
    const list = doc.commands().map(c => c[0]);
    assert.deepEqual(list.filter(n => ['shade', 'rect', 'oval', 'path', 'round', 'border'].includes(n)).slice(-8), ['shade', 'rect', 'shade', 'oval', 'shade', 'path', 'round', 'border'], 'each shade just before its fill');
    assert.equal(named(doc, 'round').find(c => c[1] === 80)?.[5], '#ff00ff00', 'a color fill in place of its color');
    doc.close();
  });

  it('draws a line as thick as its stroke, 1 by default', () => {
    const doc = page();
    render(() => (
      <Shape
        style={{ width: 100, height: 40 }}
        shapes={[
          { kind: 'line', x: 0, y: 5, right: 100, bottom: 5 },
          { kind: 'line', x: 0, y: 10, right: 100, bottom: 10, stroke: 3 },
        ]}
      />
    ), doc);
    doc.present();
    assert.deepEqual(named(doc, 'line').map(c => c.at(-1)), [1, 3]);
    doc.close();
  });

  it('dashes a Shape stroke around it and nothing else', () => {
    const doc = page();
    render(() => (
      <Shape
        style={{ width: 100, height: 40 }}
        shapes={[
          { kind: 'line', x: 0, y: 5, right: 100, bottom: 5, dash: [5, 3] },
          { kind: 'rect', x: 0, y: 10, right: 20, bottom: 20, dash: [5, 3] },
        ]}
      />
    ), doc);
    doc.present();
    const list = doc.commands().map(c => c[0]);
    const at = list.indexOf('line');
    assert.deepEqual(list.slice(at - 1, at + 2), ['dash', 'line', 'dash']);
    assert.deepEqual(named(doc, 'dash'), [['dash', 0, 2, 5, 3], ['dash', 0, 0]], 'a filled rect is not dashed');
    doc.close();
  });

  it('draws a border per side with its own color, and dashed or dotted ones', () => {
    const doc = page();
    /** @type {any} */
    let box = null;
    render(() => (
      <View style={{ padding: 10 }}>
        <View ref={(/** @type {any} */ n) => (box = n)} style={{ width: 100, height: 40, borderBottom: 2, borderLeft: 4, borderColor: '#000', borderLeftColor: '#f00', padding: 1 }}>
          <Label text="x" />
        </View>
        <View style={{ width: 100, height: 20, border: 2, borderColor: '#000', borderStyle: 'dashed' }} />
        <View style={{ width: 100, height: 20, border: 2, borderColor: '#000', borderStyle: 'dotted' }} />
      </View>
    ), doc);
    doc.present();
    assert.deepEqual(named(doc, 'edges'), [['edges', 10, 10, 110, 50, 0, 0, 0, 0, 0, 0, 0, 2, 4, '#ff000000', '#ff000000', '#ff000000', '#ffff0000']]);
    const text = named(doc, 'text')[0];
    assert.equal(text[2], 10 + 4 + 1, 'the content starts past the left border');
    assert.equal(box.clientHeight, 38, 'less the bottom border only');
    assert.deepEqual(named(doc, 'dash'), [['dash', 0, 2, 6, 6], ['dash', 0, 0], ['dash', 1, 2, 0, 4], ['dash', 0, 0]]);
    assert.equal(named(doc, 'border').length, 2, 'one width and color: a stroke');
    doc.close();
  });

  it('fills a box with a linear or radial gradient, in its corners', () => {
    const doc = page();
    render(() => (
      <View style={{ padding: 10 }}>
        <View style={{ width: 100, height: 20, radius: 4, background: { linear: 90, stops: [[0, '#f00'], [1, '#00f']] } }} />
        <View style={{ width: 100, height: 20, background: { radial: true, stops: [[0, '#fff'], [0.5, '#000'], [1, '#000']] } }} />
      </View>
    ), doc);
    doc.present();
    assert.deepEqual(named(doc, 'gradient'), [
      ['gradient', 10, 10, 110, 30, 4, 4, 4, 4, 0, 90, 2, 0, '#ffff0000', 1, '#ff0000ff'],
      ['gradient', 10, 30, 110, 50, 0, 0, 0, 0, 1, 0, 3, 0, '#ffffffff', 0.5, '#ff000000', 1, '#ff000000'],
    ]);
    assert.equal(named(doc, 'rect').length + named(doc, 'round').length, 0, 'no plain fill under it');
    doc.close();
  });

  it('transforms an item and its content about its origin, painted and hit, not laid out', () => {
    const doc = page();
    /** @type {string[]} */
    const pressed = [];
    /** @type {any} */
    let grown = null;
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ padding: 10, gap: 10, align: 'start' }}>
        <View ref={(/** @type {any} */ n) => (grown = n)} style={{ width: 40, height: 20, scale: 2, background: '#f00' }} onPress={() => pressed.push('scaled')}>
          <View ref={(/** @type {any} */ n) => (refs.child = n)} style={{ width: 10, height: 10 }} />
        </View>
        <View style={{ width: 40, height: 20, translate: [100, 0], background: '#0f0' }} onPress={() => pressed.push('moved')} />
        <Label text="axis" style={{ rotate: -90, transformOrigin: [0, 0] }} />
      </View>
    ), doc);
    doc.present();
    const tf = named(doc, 'transform');
    assert.deepEqual(tf[0], ['transform', 2, 0, 0, 2, -30, -20], 'scale 2 about the center (30, 20)');
    assert.deepEqual(tf[1], ['transform', 1, 0, 0, 1, 100, 0]);
    const [, a, b, c, d, e, f] = tf[2];
    assert.deepEqual([a, b, c, d, e, f].map(v => Math.round(v * 1000) / 1000), [0, -1, 1, 0, -60, 80], 'a Label turned a quarter left about its top-left');
    const list = doc.commands().map(x => x[0]);
    assert.ok(list.lastIndexOf('transform') < list.indexOf('text'), 'its text is drawn in the turn');
    assert.deepEqual(grown.getBoundingClientRect(), { x: -10, y: 0, left: -10, top: 0, right: 70, bottom: 40, width: 80, height: 40 }, 'its rect is the bounds of its transformed box, as the DOM\'s');
    assert.deepEqual(refs.child.getBoundingClientRect(), { x: -10, y: 0, left: -10, top: 0, right: 10, bottom: 20, width: 20, height: 20 }, 'and its content\'s, in its transform');
    doc.press(5, 5);
    doc.release(5, 5);
    assert.deepEqual(pressed, ['scaled'], 'the scaled box reaches past its layout box');
    doc.press(125, 45);
    doc.release(125, 45);
    assert.deepEqual(pressed, ['scaled', 'moved'], 'the moved box is pressed where it is drawn');
    doc.press(15, 45);
    assert.deepEqual(pressed, ['scaled', 'moved'], 'not where it was laid out');
    doc.close();
  });

  it("skews an item after its other transforms, as CSS's skew(): painted, hit and in its rect", () => {
    const doc = page();
    /** @type {string[]} */
    const pressed = [];
    /** @type {any} */
    let leaning = null;
    render(() => (
      <View style={{ padding: 10, align: 'start' }}>
        <View ref={(/** @type {any} */ n) => (leaning = n)} style={{ width: 40, height: 20, skewX: 45, background: '#f00' }} onPress={() => pressed.push('skewed')} />
        <View style={{ width: 40, height: 20, margin: [100, 0, 0, 0], skewY: 45, scale: 2, background: '#00f' }} />
      </View>
    ), doc);
    doc.present();
    const [first, second] = named(doc, 'transform').map(([, ...m]) => m.map(v => Math.round(v * 1000) / 1000));
    // About the center (30, 20): x' = x + y - 20; the bottom edge leans 20 right of the top.
    assert.deepEqual(first, [1, 0, 1, 1, -20, 0]);
    // Scale 2, then skewY 45 about its center: [2, 2; 0, 2].
    assert.deepEqual(second.slice(0, 4), [2, 2, 0, 2]);
    assert.deepEqual(leaning.getBoundingClientRect(), { x: 0, y: 10, left: 0, top: 10, right: 60, bottom: 30, width: 60, height: 20 });
    doc.press(5, 12);
    doc.release(5, 12);
    assert.deepEqual(pressed, ['skewed'], 'its top leans left of its layout box');
    doc.press(45, 12);
    doc.release(45, 12);
    assert.deepEqual(pressed, ['skewed'], 'and leaves its top right corner');
    doc.close();
  });

  it('sets a family naming monospace in the monospace face, and weights in the nearest face', () => {
    // A measure with a monospace face: 0.6 of the size a character; the regular, half.
    const fonts = { ...mono, width: (/** @type {string} */ text, /** @type {number} */ size, face = 0) => text.length * size * ((face & 4) !== 0 ? 0.6 : 0.5) };
    const doc = new Document(fonts, { width: 400, height: 200 });
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ align: 'start' }}>
        <View style={{ fontFamily: '"Fira Code", monospace', align: 'start' }}>
          <Label ref={(/** @type {any} */ n) => (refs.code = n)} text="code" style={{ fontSize: 10 }} />
        </View>
        <Label ref={(/** @type {any} */ n) => (refs.prose = n)} text="prose" style={{ fontSize: 10, fontFamily: 'serif' }} />
        <Label text="medium" style={{ fontWeight: 500 }} />
        <Label text="semibold" style={{ fontWeight: 600 }} />
      </View>
    ), doc);
    doc.present();
    assert.equal(refs.code.getBoundingClientRect().width, 24, 'inherited: four characters of 6');
    assert.equal(refs.prose.getBoundingClientRect().width, 25, 'another family: the one typeface');
    const flags = Object.fromEntries(named(doc, 'text').map(c => [c[1], c[6]]));
    assert.deepEqual(flags, { code: 4, prose: 0, medium: 0, semibold: 1 });
    doc.close();
  });

  it('fits an Image as object-fit asks, and tells its Image a source failed', () => {
    const doc = page();
    /** @type {string[]} */
    const heard = [];
    render(() => (
      <View style={{ align: 'start' }}>
        <Image source="a.png" style={{ width: 40, height: 20 }} />
        <Image source="b.png" style={{ width: 40, height: 20, objectFit: 'cover' }} onError={(/** @type {any} */ e) => heard.push(`${e.type} ${e.source}`)} />
      </View>
    ), doc);
    doc.present();
    assert.deepEqual(named(doc, 'image'), [['image', 'a.png', 0, 0, 40, 20]], 'fill: the image over its box');
    assert.deepEqual(named(doc, 'picture'), [['picture', 'b.png', 0, 20, 40, 40, 2]]);
    doc.failed('b.png');
    doc.failed('a.png');
    assert.deepEqual(heard, ['error b.png']);
    doc.close();
  });

  it('draws an empty box\'s opacity in its fill\'s alpha, not a layer', () => {
    const doc = page();
    render(() => (
      <View style={{ align: 'start' }}>
        <View style={{ width: 40, height: 20, radius: 10, background: '#ff0000', opacity: 0.5 }} />
        <View style={{ width: 40, height: 20, background: '#00ff00', opacity: 0.5 }}>
          <Label text="x" />
        </View>
      </View>
    ), doc);
    doc.present();
    assert.deepEqual(named(doc, 'round'), [['round', 0, 0, 40, 20, '#80ff0000', 10]], 'one fill: its alpha');
    assert.deepEqual(named(doc, 'layer'), [['layer', 0.5]], 'what holds more takes a layer');
    doc.close();
  });

  it('strikes text through, a decoration its children inherit', () => {
    const doc = page();
    render(() => (
      <View style={{ strike: true, align: 'start' }}>
        <Label text="gone" style={{ fontSize: 10, lineHeight: 2 }} />
      </View>
    ), doc);
    doc.present();
    const [, , x, y, , color] = named(doc, 'text')[0];
    // Four characters of 5: from x to x + 20, 3 above the baseline.
    assert.deepEqual(named(doc, 'line'), [['line', x, /** @type {number} */ (y) - 3, /** @type {number} */ (x) + 20, /** @type {number} */ (y) - 3, color, 1]]);
    doc.close();
  });

  it('scales corners that overflow their box, as CSS does', () => {
    const doc = page();
    render(() => <View style={{ width: 100, height: 40, radius: [40, 40, 40, 0], background: '#0000ff' }} />, doc);
    doc.present();
    // The sides of 40 hold 80 of radius: everything scales by a half.
    assert.deepEqual(named(doc, 'rround'), [['rround', 0, 0, 100, 40, '#ff0000ff', 20, 20, 20, 0]]);
    doc.close();
  });
  it("draws a Scroll's bars as its scrollbarWidth and scrollbarColor say, the room for them too", () => {
    /** The Scroll's drawn bar track and its content's width, for a style. @param {any} style */
    const drawn = style => {
      const doc = new Document(mono, { width: 200, height: 200 });
      /** @type {any} */
      let row = null;
      render(() => (
        <View style={style.outer ?? null}>
          <Scroll style={{ height: 50, width: 100, ...style.own }}>
            <View ref={(/** @type {any} */ n) => (row = n)} style={{ height: 200, shrink: 0 }} />
          </Scroll>
        </View>
      ), doc);
      doc.present();
      const tracks = named(doc, 'rect').filter(c => c[1] >= 80 && c[2] === 0 && c[3] === 100 && c[4] === 50);
      const width = row.w;
      doc.close();
      return [tracks.map(c => [c[1], c[5]]), width];
    };
    // The theme's bar (8 wide): its soft track.
    assert.deepEqual(drawn({}), [[[92, '#ffe6ebdd']], 92]);
    assert.deepEqual(drawn({ own: { scrollbarWidth: 'auto' } }), drawn({}));
    assert.deepEqual(drawn({ own: { scrollbarWidth: 'thin', scrollbarColor: ['#f00', '#0f0'] } }), [[[96, '#ff00ff00']], 96], 'half the bar, in its colors');
    assert.deepEqual(drawn({ own: { scrollbarWidth: 'none' } }), [[], 100], 'no bar and no room for one');
    // The colors inherit, as CSS's scrollbar-color; the width does not.
    assert.deepEqual(drawn({ outer: { scrollbarColor: ['#f00', '#00f'], scrollbarWidth: 'none' } }), [[[92, '#ff0000ff']], 92]);
  });
});
