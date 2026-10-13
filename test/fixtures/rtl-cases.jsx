// The views of the right-to-left oracle (scripts/rtl-oracle.mjs records
// them as Chrome renders the markup ren-dom writes for them, into rtl.json;
// test/rtl-oracle.test.jsx renders them on a Document and compares), each
// on its own page 400 wide, in DejaVu Sans (test/fixtures/dejavu.ttf):
// - `sticky`: a Scroll across (or down) with sticky items, scrolled to each
//   of `scrolls` (`scrollLeft`, below 0 right to left; `scrollTop` for a
//   Scroll down): every item's border box where it is held;
// - `clipped`: a Label cut by `lines` or `ellipsis`: which characters show,
//   where, and where the ellipsis goes;
// - `fields`: Edits under a parent's `textAlign`: the side each sets its
//   text on.
// A case's name is its key in the oracle.
import { View, Label, Edit, Scroll } from 'ren-core';

const T = { fontSize: 16, lineHeight: 1.25 };
/** An empty box that keeps its width in a row. @param {number | undefined} w @param {number} h @param {Record<string, any>} [s] */
const sq = (w, h, s = {}) => <View style={{ width: w, height: h, shrink: 0, ...s }} />;
/** A sticky box. @param {number} w @param {Record<string, any>} insets */
const stuck = (w, insets) => sq(w, 10, { position: 'sticky', background: 0xffff0000, ...insets });
/** A Scroll across, 200 wide, its children in a row. @param {'ltr' | 'rtl'} dir @param {any[]} kids @param {Record<string, any>} [s] */
const across = (dir, kids, s = {}) => <Scroll dir={dir} axis="x" style={{ width: 200, height: 50, direction: 'row', ...T, ...s }}>{kids}</Scroll>;

/** @type {{ name: string, view: () => any, scrolls: number[] }[]} */
export const sticky = [
  { name: 'rtl right', view: () => across('rtl', [sq(100, 10), stuck(40, { right: 0 }), sq(300, 10)]), scrolls: [0, -30, -100, -180, -240] },
  { name: 'rtl left', view: () => across('rtl', [sq(300, 10), stuck(40, { left: 10 }), sq(100, 10)]), scrolls: [0, -50, -150, -200, -240] },
  { name: 'rtl right within a row', view: () => across('rtl', [sq(60, 10), <View style={{ direction: 'row', width: 200, shrink: 0, padding: [0, 5, 0, 7], border: 1 }}>{sq(50, 10)}{stuck(30, { right: 4 })}{sq(80, 10)}</View>, sq(300, 10)], { padding: [0, 3, 0, 9], border: 2 }), scrolls: [0, -40, -90, -150, -230, -300, -376] },
  { name: 'rtl left within a row', view: () => across('rtl', [sq(300, 10), <View style={{ direction: 'row', width: 200, shrink: 0, padding: [0, 5, 0, 7], border: 1 }}>{sq(80, 10)}{stuck(30, { left: 6 })}{sq(50, 10)}</View>, sq(60, 10)]), scrolls: [0, -60, -150, -260, -300, -362] },
  { name: 'rtl left and right', view: () => across('rtl', [sq(150, 10), stuck(40, { left: 10, right: 20 }), sq(250, 10)]), scrolls: [0, -50, -120, -240] },
  { name: 'rtl right, margins', view: () => across('rtl', [sq(100, 10), stuck(40, { right: 0, margin: [0, 6, 0, 3] }), sq(300, 10)]), scrolls: [0, -100, -249] },
  { name: 'ltr right', view: () => across('ltr', [sq(250, 10), stuck(40, { right: 0 }), sq(100, 10)]), scrolls: [0, 40, 100, 190] },
  { name: 'rtl left and right, narrow', view: () => across('rtl', [sq(150, 10), stuck(40, { left: 120, right: 90 }), sq(250, 10)]), scrolls: [0, -50, -120, -240] },
  { name: 'ltr right within a row', view: () => across('ltr', [sq(170, 10), <View style={{ direction: 'row', width: 200, shrink: 0, padding: [0, 7, 0, 5] }}>{sq(80, 10)}{stuck(30, { right: 4 })}{sq(80, 10)}</View>, sq(250, 10)]), scrolls: [0, 40, 100, 300, 420] },
  { name: 'ltr left, percent, padded', view: () => across('ltr', [sq(100, 10), stuck(40, { left: '10%' }), sq(400, 10)], { padding: [0, 6, 0, 12], border: 1 }), scrolls: [0, 50, 100, 250, 380] },
  {
    name: 'ltr top, padded',
    view: () => (
      <Scroll style={{ width: 200, height: 60, padding: [6, 0, 0, 0], border: 2, ...T }}>
        {sq(undefined, 30)}
        <View style={{ height: 120 }}>{stuck(50, { top: 2 })}{sq(undefined, 70)}</View>
        {sq(undefined, 200)}
      </Scroll>
    ),
    scrolls: [0, 20, 50, 90, 140],
  },
  {
    name: 'ltr bottom',
    view: () => (
      <Scroll style={{ width: 200, height: 60, padding: [4, 0, 2, 0], ...T }}>
        {sq(undefined, 30)}
        <View style={{ height: 120, padding: [3, 0, 5, 0] }}>{sq(undefined, 70)}{stuck(50, { bottom: 5 })}{sq(undefined, 20)}</View>
        {sq(undefined, 200)}
      </Scroll>
    ),
    scrolls: [0, 20, 50, 90, 140],
  },
];

const LATIN = 'abcdefgh ijklmnop qrstuvwx yz';

/** @type {{ name: string, dir: 'ltr' | 'rtl', text: string, lines?: number, width: number }[]} */
export const clipped = [
  { name: 'Hebrew, right to left', dir: 'rtl', text: 'שלום עולם יפה ומאיר', width: 180 },
  { name: 'Latin in Hebrew, right to left', dir: 'rtl', text: 'אב hello world גד', width: 180 },
  { name: 'Hebrew then Latin, right to left', dir: 'rtl', text: 'שלום abcdefghij', width: 160 },
  { name: 'Latin then Hebrew, right to left', dir: 'rtl', text: 'abcdef שלום עולם', width: 180 },
  { name: 'a left-to-right row, right to left', dir: 'rtl', text: LATIN, width: 200 },
  { name: 'Hebrew in Latin, left to right', dir: 'ltr', text: 'abc אבגדהוזח def', width: 180 },
  { name: 'Hebrew, left to right', dir: 'ltr', text: 'שלום עולם יפה ומאיר', width: 180 },
  { name: 'a cut after a space, left to right', dir: 'ltr', text: 'abcd efgh ijkl', width: 125 },
  { name: 'a cut after a space, right to left', dir: 'rtl', text: 'שלום עולם', width: 115 },
  { name: 'Latin clamped, left to right', dir: 'ltr', text: LATIN + ' ' + LATIN, lines: 2, width: 200 },
  { name: 'Hebrew clamped, right to left', dir: 'rtl', text: 'שלום עולם יפה ומאיר וגם ארוך מאוד מאוד', lines: 2, width: 160 },
  { name: 'Latin clamped, right to left', dir: 'rtl', text: LATIN + ' ' + LATIN, lines: 2, width: 200 },
  { name: 'mixed clamped, right to left', dir: 'rtl', text: 'אבג hello דהו world זחט ijklmnop', lines: 2, width: 170 },
];
/** The size the cut Labels are set at: large enough that each glyph has whole pixels of its color. */
export const CLIP = 32;

/** A cut Label of a case, its text as one string or (`colors`) a run a character in those colors. @param {typeof clipped[number]} c @param {number[] | null} [colors] */
export const cut = (c, colors = null) => {
  const props = c.lines === undefined ? { ellipsis: true } : { lines: c.lines };
  const style = { fontSize: CLIP, lineHeight: 1.25, color: 0xff000000 };
  return () => (
    <View dir={c.dir} style={{ width: c.width, align: 'stretch' }}>
      {colors === null ? <Label {...props} style={style} text={c.text} /> : <Label {...props} style={style} runs={[...c.text].map((ch, i) => ({ text: ch, style: { color: colors[i] } }))} />}
    </View>
  );
};

/** @type {{ name: string, view: () => any }[]} */
export const fields = [
  { name: 'center', view: () => <View style={{ width: 300, textAlign: 'center', ...T }}><Edit value="abc" /><Edit lines={3} value="abc" /><Label>abc</Label></View> },
  { name: 'end', view: () => <View style={{ width: 300, textAlign: 'end', ...T }}><Edit value="abc" /><Edit lines={3} value="abc" /></View> },
  { name: 'end, right to left', view: () => <View dir="rtl" style={{ width: 300, textAlign: 'end', ...T }}><Edit value="abc" /><Edit lines={3} value="abc" /></View> },
  { name: 'start, right to left', view: () => <View dir="rtl" style={{ width: 300, textAlign: 'start', ...T }}><Edit value="abc" /></View> },
  { name: 'its own', view: () => <View style={{ width: 300, textAlign: 'end', ...T }}><Edit value="abc" style={{ textAlign: 'center' }} /><Edit dir="rtl" value="abc" style={{ textAlign: 'end' }} /></View> },
];
