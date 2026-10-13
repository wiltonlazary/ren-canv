// The views of the layout oracle (scripts/layout-oracle.mjs records their
// boxes as Chrome lays out the markup ren-dom writes for them, into
// layout.json; test/oracle.test.jsx lays them out on a Document and
// compares): flex columns and rows, grids, wrapping and clipped text,
// sizes, insets, alignment and right to left, each on its own page 400 by 600, in
// DejaVu Sans (test/fixtures/dejavu.ttf) at 16 px with a line height of
// 1.25. A case's name is its key in the oracle.
import { View, Label, Action, Edit, Scroll } from 'ren-core';

const LONG = 'The quick brown fox jumps over the lazy dog again';
const T = { fontSize: 16, lineHeight: 1.25 };
/** A column 200 wide holding `c`. @param {any} c */
const B = c => <View style={{ width: 200, ...T }}>{c}</View>;
/** An empty box. @param {number | undefined} w @param {number} h @param {Record<string, any>} [s] */
const sq = (w, h, s = {}) => <View style={{ width: w, height: h, ...s }} />;

/** @type {{ name: string, view: () => any }[]} */
export const cases = [];
/** @param {string} name @param {() => any} view */
const add = (name, view) => cases.push({ name, view });

// A long Label in a View of a 200 px column, aligned each way.
for (const self of ['start', 'center', 'end', 'stretch', undefined]) {
  add(`col self=${self} label`, () => B(<View style={{ self }}><Label>{LONG}</Label></View>));
  add(`col self=${self} label wrap`, () => B(<View style={{ self }}><Label style={{ wrap: true }}>{LONG}</Label></View>));
  add(`col self=${self} direct label wrap`, () => B(<Label style={{ self, wrap: true }}>{LONG}</Label>));
  add(`col self=${self} direct label`, () => B(<Label style={{ self }}>{LONG}</Label>));
}
for (const align of ['start', 'center', 'end', 'stretch']) {
  add(`col align=${align} view label wrap`, () => <View style={{ width: 200, align, ...T }}><View><Label style={{ wrap: true }}>{LONG}</Label></View></View>);
  add(`col align=${align} view text`, () => <View style={{ width: 200, align, ...T }}><View>{LONG}</View></View>);
  add(`row align=${align} wrap label`, () => <View style={{ width: 200, direction: 'row', align, ...T }}><Label style={{ wrap: true }}>{LONG}</Label><View style={{ width: 30, height: 50 }} /></View>);
}
add('row two wrapping labels', () => <View style={{ width: 200, direction: 'row', ...T }}><Label style={{ wrap: true }}>{LONG}</Label><Label style={{ wrap: true }}>short one</Label></View>);
add('col maxWidth self start', () => B(<View style={{ self: 'start', maxWidth: 120 }}><Label style={{ wrap: true }}>{LONG}</Label></View>));
add('col minWidth self start', () => B(<View style={{ self: 'start', minWidth: 180 }}><Label>abc</Label></View>));
add('col minWidth>parent self start', () => B(<View style={{ self: 'start', minWidth: 260 }}><Label>abc</Label></View>));
add('row maxWidth grow', () => <View style={{ width: 300, direction: 'row', ...T }}><View style={{ grow: 1, maxWidth: 100, height: 10 }} /><View style={{ grow: 1, height: 10 }} /></View>);
add('row minWidth shrink', () => <View style={{ width: 100, direction: 'row', ...T }}><View style={{ width: 80, minWidth: 70, height: 10 }} /><View style={{ width: 80, height: 10 }} /></View>);
add('grid 1fr 2fr', () => <View style={{ width: 300, display: 'grid', columns: '1fr 2fr', gap: 10, ...T }}><Label style={{ wrap: true }}>{LONG}</Label><View style={{ height: 20 }} /></View>);
add('grid auto 1fr', () => <View style={{ width: 300, display: 'grid', columns: 'auto 1fr', ...T }}><Label>abc def</Label><Label style={{ wrap: true }}>{LONG}</Label></View>);
add('grid self start', () => <View style={{ width: 300, display: 'grid', columns: '1fr 1fr', ...T }}><Label style={{ self: 'start', wrap: true }}>{LONG}</Label><View style={{ height: 80 }} /></View>);
add('grid align center', () => <View style={{ width: 300, height: 100, display: 'grid', columns: '1fr 1fr', align: 'center', ...T }}><Label>abc</Label><View style={{ height: 80 }} /></View>);
add('row justify between', () => <View style={{ width: 300, direction: 'row', justify: 'between', ...T }}><Label>a</Label><Label>bb</Label><Label>ccc</Label></View>);
add('row wrap items', () => <View style={{ width: 200, direction: 'row', wrap: true, gap: 8, ...T }}>{[60, 70, 80, 50, 90].map(w => sq(w, 20))}</View>);
add('col maxHeight', () => <View style={{ width: 200, maxHeight: 50, ...T }}><Label style={{ wrap: true }}>{LONG}</Label></View>);
add('col minHeight justify end', () => <View style={{ width: 200, minHeight: 100, justify: 'end', ...T }}><Label>abc</Label></View>);
add('nested self start in row-in-col', () => B(<View style={{ direction: 'row' }}><View style={{ self: 'start' }}><Label style={{ wrap: true }}>{LONG}</Label></View></View>));
add('col self start text child', () => B(<View style={{ self: 'start' }}>{LONG}</View>));
add('col self start wrap view text', () => B(<View style={{ self: 'start', wrap: true }}>{LONG}</View>));
add('row grow wrap label', () => <View style={{ width: 200, direction: 'row', ...T }}><View style={{ grow: 1 }}><Label style={{ wrap: true }}>{LONG}</Label></View><View style={{ width: 50, height: 10 }} /></View>);
add('padded self start wrap', () => B(<View style={{ self: 'start', padding: 10, border: 2 }}><Label style={{ wrap: true }}>{LONG}</Label></View>));
add('col self center long word', () => B(<View style={{ self: 'center' }}><Label style={{ wrap: true }}>Supercalifragilisticexpialidocious and more</Label></View>));
add('label lines=2 self start', () => B(<View style={{ self: 'start' }}><Label lines={2}>{LONG + ' ' + LONG}</Label></View>));
add('label ellipsis self start', () => B(<View style={{ self: 'start' }}><Label ellipsis>{LONG}</Label></View>));
add('label ellipsis stretch', () => B(<Label ellipsis>{LONG}</Label>));
add('label ellipsis bg stretch', () => B(<Label ellipsis style={{ background: 0xff00ff00 }}>{LONG}</Label>));
add('row label nowrap shrink', () => <View style={{ width: 200, direction: 'row', ...T }}><Label>{LONG}</Label><View style={{ width: 30, height: 10 }} /></View>);
add('row label wrap shrink', () => <View style={{ width: 200, direction: 'row', ...T }}><Label style={{ wrap: true }}>{LONG}</Label><View style={{ width: 30, height: 10 }} /></View>);
add('scroll self start wrap', () => B(<View style={{ self: 'start', overflow: 'hidden' }}><Label style={{ wrap: true }}>{LONG}</Label></View>));
add('width 50% self start', () => B(<View style={{ self: 'start', width: '50%' }}><Label style={{ wrap: true }}>{LONG}</Label></View>));
add('abs wrap label', () => B(<View style={{ position: 'absolute', top: 0, left: 0 }}><Label style={{ wrap: true }}>{LONG}</Label></View>));
add('abs wrap label right', () => B(<View style={{ position: 'absolute', top: 0, left: 100 }}><Label style={{ wrap: true }}>{LONG}</Label></View>));
// The automatic minimum is along the parent's main axis only.
add('row h10 label stretch', () => <View style={{ width: 300, height: 10, direction: 'row', ...T }}><Label>abc</Label></View>);
add('col label bg narrow', () => <View style={{ width: 100, ...T }}><Label style={{ background: 0xffff0000 }}>{LONG}</Label></View>);
add('col action long', () => <View style={{ width: 100, ...T }}><Action>{LONG}</Action></View>);
add('col edit narrow', () => <View style={{ width: 100, ...T }}><Edit value="x" /></View>);
add('grid label in 1fr', () => <View style={{ width: 100, display: 'grid', columns: '1fr', ...T }}><Label>{LONG}</Label></View>);
add('row label minHeight stretch', () => <View style={{ width: 300, height: 10, direction: 'row', ...T }}><Label style={{ minHeight: 30 }}>abc</Label></View>);
add('col label minWidth stretch', () => <View style={{ width: 100, ...T }}><Label style={{ minWidth: 150 }}>{LONG}</Label></View>);
// A View's bare text is white-space: normal, as the DOM's: it wraps, and runs of white space collapse.
add('view text newline', () => B(<View>{'abc\ndef'}</View>));
add('view text double space wide', () => <View style={{ width: 400, ...T }}><View style={{ self: 'start' }}>{'abc    def'}</View></View>);
add('view text spaces at the ends', () => <View style={{ width: 400, ...T }}><View style={{ self: 'start' }}>{'   abc def   '}</View></View>);
add('view text tabs and blank lines', () => <View style={{ width: 400, ...T }}><View style={{ self: 'start' }}>{'a\t\tb\n\n\nc'}</View></View>);
add('view text runs joined', () => <View style={{ width: 400, ...T }}><View style={{ self: 'start' }}>{'Count:  '}{' 12'}</View></View>);
add('view text between boxes in a row', () => <View style={{ width: 300, direction: 'row', gap: 10, ...T }}>{sq(20, 10)}{'  some  text  '}{sq(20, 10)}</View>);
add('view blank text between boxes', () => <View style={{ width: 300, direction: 'row', gap: 10, ...T }}>{sq(20, 10)}{'   '}{sq(20, 10)}</View>);
add('view text wraps in a row', () => <View style={{ width: 150, direction: 'row', ...T }}>{LONG}</View>);
add('action holding view text keeps its spaces', () => <View style={{ width: 400, align: 'start', ...T }}><Action><View>{'abc    def'}</View></Action></View>);
for (const justify of ['center', 'end', 'between', 'around', 'evenly']) add(`row justify ${justify}`, () => <View style={{ width: 300, direction: 'row', justify, ...T }}>{sq(40, 10)}{sq(50, 10)}{sq(60, 10)}</View>);
for (const justify of ['center', 'end', 'between']) add(`col justify ${justify} h200`, () => <View style={{ width: 100, height: 200, justify, ...T }}>{sq(40, 10)}{sq(50, 20)}</View>);
add('grid minmax auto-fill', () => <View style={{ width: 330, display: 'grid', columns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 10, ...T }}>{[1, 2, 3, 4].map(() => sq(undefined, 20))}</View>);
add('grid span and lines', () => <View style={{ width: 300, display: 'grid', columns: '1fr 1fr 1fr', rows: '30px auto', ...T }}><View style={{ column: 'span 2', height: 10 }} /><View style={{ column: '3', row: '1 / 3', height: 10 }} />{sq(undefined, 50)}</View>);
add('grid justify center tracks', () => <View style={{ width: 300, display: 'grid', columns: '50px 50px', justify: 'center', ...T }}>{sq(undefined, 10)}{sq(undefined, 10)}</View>);
add('grid self end', () => <View style={{ width: 300, height: 100, display: 'grid', columns: '1fr', rows: '100px', ...T }}><View style={{ self: 'end', width: 30, height: 30 }} /></View>);
add('col wrap', () => <View style={{ width: 300, height: 60, wrap: true, gap: 5, ...T }}>{[20, 30, 20, 25].map(h => sq(40, h))}</View>);
add('aspect ratio', () => <View style={{ width: 200, ...T }}><View style={{ aspectRatio: 2 }} /><View style={{ width: 50, aspectRatio: 0.5 }} /></View>);
add('percent sizes', () => <View style={{ width: 300, height: 200, direction: 'row', ...T }}><View style={{ width: '25%', height: '50%' }} /><View style={{ width: '50%', maxWidth: '30%', height: 10 }} /></View>);
add('margin and padding', () => <View style={{ width: 300, padding: [5, 10, 15, 20], border: 3, ...T }}><View style={{ margin: [4, 8], height: 10 }} /><View style={{ margin: 6, height: 10, self: 'center', width: 50 }} /></View>);
add('shrink 0 overflow', () => <View style={{ width: 100, direction: 'row', ...T }}>{sq(80, 10, { shrink: 0 })}{sq(80, 10)}</View>);
add('grow ratios min', () => <View style={{ width: 300, direction: 'row', ...T }}>{sq(undefined, 10, { grow: 1, minWidth: 150 })}{sq(undefined, 10, { grow: 2 })}{sq(undefined, 10, { grow: 1, maxWidth: 30 })}</View>);
add('maxHeight overflow hidden wrap', () => <View style={{ width: 150, maxHeight: 30, overflow: 'hidden', ...T }}><Label style={{ wrap: true }}>{LONG}</Label></View>);
add('minHeight col label', () => <View style={{ width: 150, minHeight: 90, align: 'center', justify: 'center', ...T }}><Label>abc</Label></View>);
add('row align center wrap labels', () => <View style={{ width: 300, direction: 'row', align: 'center', gap: 10, ...T }}><Label style={{ wrap: true }}>{LONG}</Label><Label>xyz</Label></View>);
add('row wrap with wrapping label', () => <View style={{ width: 200, direction: 'row', wrap: true, ...T }}>{sq(150, 10)}<Label style={{ wrap: true }}>{LONG}</Label></View>);
add('fontSize mixed label', () => <View style={{ width: 200, ...T }}><Label style={{ fontSize: 24, lineHeight: 1.5, wrap: true }}>{LONG}</Label><Label style={{ fontSize: 10 }}>small</Label></View>);
add('label padding wrap', () => <View style={{ width: 200, ...T }}><Label style={{ wrap: true, padding: 12, border: 1 }}>{LONG}</Label></View>);
add('label textAlign center wrap', () => <View style={{ width: 200, ...T }}><Label style={{ wrap: true, textAlign: 'center' }}>{LONG}</Label></View>);
add('label width fixed wrap', () => <View style={{ width: 300, ...T }}><Label style={{ wrap: true, width: 120 }}>{LONG}</Label></View>);
add('label maxWidth wrap stretch', () => <View style={{ width: 300, ...T }}><Label style={{ wrap: true, maxWidth: 120 }}>{LONG}</Label></View>);
add('label minWidth nowrap', () => <View style={{ width: 300, ...T }}><Label style={{ minWidth: 200, self: 'start' }}>abc</Label></View>);
add('row label grow wrap two', () => <View style={{ width: 250, direction: 'row', ...T }}><Label style={{ wrap: true, grow: 1 }}>{LONG}</Label><Label style={{ wrap: true, grow: 1 }}>{LONG}</Label></View>);
// A wrapping row inside a box sized to fit its content.
add('self start row wrap boxes', () => B(<View style={{ self: 'start', direction: 'row', wrap: true }}>{sq(100, 10)}{sq(100, 10)}{sq(100, 10)}</View>));
add('self start > row wrap boxes', () => B(<View style={{ self: 'start' }}><View style={{ direction: 'row', wrap: true }}>{sq(100, 10)}{sq(100, 10)}{sq(100, 10)}</View></View>));
add('abs row wrap boxes', () => B(<View style={{ position: 'absolute', direction: 'row', wrap: true }}>{sq(100, 10)}{sq(100, 10)}{sq(100, 10)}</View>));
add('self start > row > row wrap boxes', () => B(<View style={{ self: 'start' }}><View style={{ direction: 'row' }}><View style={{ direction: 'row', wrap: true }}>{sq(100, 10)}{sq(100, 10)}{sq(100, 10)}</View></View></View>));
add('self start row > row wrap boxes', () => B(<View style={{ self: 'start', direction: 'row' }}><View style={{ direction: 'row', wrap: true }}>{sq(100, 10)}{sq(100, 10)}{sq(100, 10)}</View></View>));
add('self start row > wrap label', () => B(<View style={{ self: 'start', direction: 'row' }}><Label style={{ wrap: true }}>{LONG}</Label></View>));
add('abs row > wrap label', () => B(<View style={{ position: 'absolute', direction: 'row' }}><Label style={{ wrap: true }}>{LONG}</Label></View>));
// Boxes sized to fit their content (fit-content): their max-content, the room they have, or their min-content.
add('self center > row > row wrap boxes', () => B(<View style={{ self: 'center' }}><View style={{ direction: 'row' }}><View style={{ direction: 'row', wrap: true }}>{sq(100, 10)}{sq(100, 10)}{sq(100, 10)}</View></View></View>));
add('self end padded row > row wrap boxes', () => B(<View style={{ self: 'end', direction: 'row', padding: 5, margin: 4 }}><View style={{ direction: 'row', wrap: true, columnGap: 4 }}>{sq(60, 10)}{sq(60, 10)}{sq(60, 10)}</View></View>));
add('self start row > boxes past the room', () => B(<View style={{ self: 'start', direction: 'row' }}>{sq(100, 10)}{sq(100, 10)}{sq(100, 10)}</View>));
add('self start row > label and wrap label', () => B(<View style={{ self: 'start', direction: 'row', columnGap: 6 }}><Label>abc</Label><Label style={{ wrap: true }}>{LONG}</Label></View>));
add('self start row > wrap label past min-content', () => <View style={{ width: 30, ...T }}><View style={{ self: 'start', direction: 'row' }}><Label style={{ wrap: true }}>{LONG}</Label></View></View>);
add('abs right row > wrap label', () => B(<View style={{ position: 'absolute', top: 0, right: 50, direction: 'row' }}><Label style={{ wrap: true }}>{LONG}</Label></View>));
add('abs pct left > wrap label', () => B(<View style={{ position: 'absolute', top: 0, left: '25%' }}><Label style={{ wrap: true }}>{LONG}</Label></View>));
add('abs left > row > row wrap boxes', () => B(<View style={{ position: 'absolute', top: 0, left: 20 }}><View style={{ direction: 'row' }}><View style={{ direction: 'row', wrap: true }}>{sq(80, 10)}{sq(80, 10)}{sq(80, 10)}</View></View></View>));
add('padded abs wrap label', () => <View style={{ width: 200, padding: 10, ...T }}><View style={{ position: 'absolute', top: 0, left: 30, margin: 5 }}><Label style={{ wrap: true }}>{LONG}</Label></View></View>);
// A grid with flexible tracks and no width of its own, where nothing stretches it: fitted to the room it has
// (CSS's fit-content), never past it at its max-content; under its max-content when that is less, and at its
// tracks' minimums when those are more.
const CUT = { ellipsis: true };
const thirds = (/** @type {Record<string, any>} */ s, /** @type {string} */ text, columns = 'repeat(3, minmax(0, 1fr))') => <View style={{ display: 'grid', columns, ...s }}>{[1, 2, 3].map(() => <Label {...CUT}>{text}</Label>)}</View>;
add('self start > grid fr', () => B(<View style={{ self: 'start' }}>{thirds({}, LONG)}</View>));
add('grid fr self start', () => B(thirds({ self: 'start', padding: 4, columnGap: 6 }, LONG)));
add('self start padded > row > grid fr grow', () => B(<View style={{ self: 'start', padding: 3 }}><View style={{ direction: 'row' }}><View style={{ position: 'absolute', top: 0, left: 0, width: 10, height: 10 }} />{thirds({ grow: 1, minWidth: 0 }, LONG)}</View></View>));
add('self start > row > box and grid fr', () => B(<View style={{ self: 'start' }}><View style={{ direction: 'row', columnGap: 10 }}>{sq(40, 10)}{thirds({ grow: 1, minWidth: 0 }, LONG)}</View></View>));
add('self start > grid fr short', () => B(<View style={{ self: 'start' }}>{thirds({}, 'abc')}</View>));
add('self start > grid fr minimums past the room', () => B(<View style={{ self: 'start' }}>{thirds({}, LONG, 'repeat(3, minmax(80px, 1fr))')}</View>));
// Right to left (dir="rtl"): a row's main axis, a grid's columns and the start of justify and align from the
// right, insets and margins physical, nested boxes each in their parent.
const RTL = { width: 300, direction: 'row', ...T };
add('rtl row', () => <View dir="rtl" style={RTL}>{sq(40, 10)}{sq(60, 20)}{sq(30, 10)}</View>);
for (const justify of ['end', 'center', 'between'])
  add(`rtl row justify ${justify}`, () => <View dir="rtl" style={{ ...RTL, justify }}>{sq(40, 10)}{sq(60, 20)}{sq(30, 10)}</View>);
add('rtl row margins and grow', () => <View dir="rtl" style={RTL}>{sq(40, 10, { margin: [0, 20, 0, 5] })}{sq(undefined, 10, { grow: 1, margin: [2, 3, 4, 9] })}{sq(30, 10)}</View>);
add('rtl row padding and border', () => <View dir="rtl" style={{ ...RTL, padding: [5, 10, 15, 30], border: 2, borderRight: 1, borderLeft: 4 }}>{sq(40, 10)}{sq(60, 20)}</View>);
add('rtl row wrap', () => <View dir="rtl" style={{ ...RTL, width: 200, wrap: true, gap: 8 }}>{[60, 70, 80, 50, 90].map(w => sq(w, 20))}</View>);
add('rtl row labels', () => <View dir="rtl" style={{ ...RTL, columnGap: 6 }}><Label>abc</Label><Label>שלום</Label><Label style={{ wrap: true, grow: 1 }}>{LONG}</Label></View>);
for (const align of ['start', 'center', 'end', 'stretch'])
  add(`rtl col align ${align}`, () => <View dir="rtl" style={{ width: 300, align, padding: [0, 7, 0, 13], ...T }}>{sq(40, 10)}{sq(undefined, 10, { minWidth: 20 })}<Label>abc</Label></View>);
add('rtl col self', () => <View dir="rtl" style={{ width: 300, ...T }}>{sq(40, 10, { self: 'start' })}{sq(40, 10, { self: 'end' })}{sq(40, 10, { self: 'center' })}</View>);
add('rtl grid', () => <View dir="rtl" style={{ width: 300, display: 'grid', columns: '50px 1fr 80px', columnGap: 10, rowGap: 4, ...T }}>{sq(undefined, 10)}{sq(undefined, 20)}{sq(undefined, 10)}{sq(30, 10)}{sq(undefined, 10, { self: 'end' })}</View>);
add('rtl grid placed', () => <View dir="rtl" style={{ width: 300, display: 'grid', columns: 'repeat(3, 1fr)', justify: 'start', ...T }}>{sq(undefined, 10, { column: 3 })}{sq(undefined, 10, { column: '1 / 3' })}</View>);
add('rtl grid auto tracks', () => <View dir="rtl" style={{ width: 300, display: 'grid', columns: 'auto auto', ...T }}><Label>abc</Label><Label>defgh</Label></View>);
add('rtl > ltr row', () => <View dir="rtl" style={RTL}>{sq(40, 10)}<View dir="ltr" style={{ direction: 'row', width: 120 }}>{sq(30, 10)}{sq(50, 10)}</View></View>);
add('rtl > row > col', () => <View dir="rtl" style={RTL}><View style={{ width: 150, padding: [0, 4, 0, 16] }}>{sq(40, 10)}<View style={{ direction: 'row' }}>{sq(20, 10)}{sq(30, 10)}</View></View>{sq(40, 10)}</View>);
add('rtl abs insets', () => <View dir="rtl" style={{ width: 300, height: 100, padding: [3, 6, 9, 12], border: 2, borderRight: 1, borderLeft: 4, ...T }}>{sq(40, 10, { position: 'absolute', top: 0, left: 10 })}{sq(40, 10, { position: 'absolute', top: 20, right: 10, margin: [0, 5, 0, 2] })}{sq(40, 10, { position: 'absolute', top: 40 })}{sq(40, 10, { position: 'absolute', top: 60, left: 10, right: 30 })}{sq(undefined, 10, { position: 'absolute', top: 80, left: 10, right: '10%' })}</View>);
add('rtl relative insets', () => <View dir="rtl" style={RTL}>{sq(40, 10, { position: 'relative', left: 10 })}{sq(40, 10, { position: 'relative', right: 10 })}{sq(40, 10, { position: 'relative', left: 5, right: 15 })}</View>);
add('rtl auto', () => <View style={{ width: 300, ...T }}><View dir="auto" style={{ direction: 'row' }}><Label>שלום</Label>{sq(40, 10)}</View><View dir="auto" style={{ direction: 'row' }}><Label>abc</Label>{sq(40, 10)}</View></View>);
add('rtl inherited', () => <View dir="rtl" style={{ width: 300, ...T }}><View style={{ direction: 'row' }}>{sq(40, 10)}{sq(50, 10)}</View></View>);
add('rtl scroll', () => <Scroll dir="rtl" style={{ width: 200, height: 50, padding: [0, 3, 0, 9], ...T }}>{sq(undefined, 100)}{sq(40, 10, { self: 'start' })}</Scroll>);
add('rtl scroll across', () => <Scroll dir="rtl" axis="x" style={{ width: 200, height: 50, direction: 'row', ...T }}>{sq(150, 10, { shrink: 0 })}{sq(120, 10, { shrink: 0 })}</Scroll>);
