# ren-canv

The engine of ren-core's drawn renderers. A `Document` is a ren-core `Host`
(`ren-core/host`) over a retained scene of the portable primitives (`View`,
`Layout`, `Scroll`, `Label`, `Edit`, `Action`, `Image`, `Shape`). It lays the
scene out, measures text through a `Fonts`, paints it into a flat typed
command buffer, finds the damaged rectangles between frames, hit-tests and
routes press, key, wheel, focus, editing and IME composition, and in a
document keeps a native text entry and an accessibility mirror beside the
canvas. Plain JavaScript with JSDoc types, strict `tsc` checking and
generated declarations.

A renderer package subclasses `Document` and replays its frames on a surface:

| Package | Measures text with | Draws on |
| --- | --- | --- |
| [ren-skia](https://github.com/wiltonlazary/ren-skia) | the font file's own advances (`Sfnt`), shaped where text needs it | a CanvasKit surface |
| [ren-three](https://github.com/wiltonlazary/ren-three) | the font file's own advances (`Sfnt`), shaped where text needs it | a 2D canvas, as a three.js texture |

The package is published on npm as `@maxenve/ren-canv` under the MIT license;
install it under its import name: `npm install ren-canv@npm:@maxenve/ren-canv`.
Its runtime dependencies are ren-core (linked
from the sibling checkout), taffy-layout (pinned; MIT) and harfbuzzjs
(pinned to 1.6.2; MIT: HarfBuzz's WebAssembly build, of which only its
`dist/harfbuzz.wasm` is used).

| Entry | What |
| --- | --- |
| `ren-canv` | `Document`, `render`, `attach`, layout (`loadLayout`, `useLayout`, `remoteLayout`, `serveLayout`, `Flow`, `CanvasFonts`), shaping (`loadShaper`, `useShaper`, and the `Shaper` and `Glyphs` types), the events (`Press`, `Pointer`, `Change`, `Key`, `Scrolled`), `Item`, `Theme`, `Sfnt` (the font file's measure), `Faces` (typefaces over font files: by family name and as fallbacks), the command buffer for tests (`Frame`, `decode`, `commands`, `operands`, `hex`, `Damage`), and the `Fonts`, `Typefaces` and `Options` types |
| `ren-canv/worker` | a layout worker's imports: `serveLayout`, `loadLayout`, `useLayout` |
| `ren-canv/backend` | what a renderer package replays with: the opcodes (`TEXT_OP`, `RECT`, `ROUND`, `CLIP`, `SAVE`, `RESTORE`, `LINE`, `OVAL`, `PATH`, `IMAGE_OP`, `BORDER`, `SHADOW`, `LAYER`), the face bits (`BOLD`, `ITALIC`, `MONO`, `RTL`, and `SLOT`, the shift of a typeface's slot), `reversed` (a right-to-left run in the order it is drawn from its left), `commands`, `operands`, `Frame`, `Damage`, `Sfnt`, the 2D canvas replay `Replay2D`, and the `Fonts` and `Picture` types |

## Layout: a replaceable engine, Taffy by default

Layout follows ren-core's portable style (CSS flexbox and grid, with CSS's
defaults). The DOM keeps the browser's own layout. The engine sits behind
a neutral boundary (src/engine.js), so it can be replaced or reimplemented
without touching anything else:

- `Boxes` (src/layout.js) keeps a layout node per item, in step with the
  scene, as flat commands (new node, style, per-node content sizes,
  children, remove) whose styles are plain CSS `Box` records (`display`,
  `direction`, `padding`, `minWidth`, `columns` as CSS text, ...). Text is
  measured here: one-line text, Actions and Edits send their content as
  their minimum and basis (one stretched across a parent too short for it,
  found after a layout, keeps its content as a child instead: CSS's
  automatic minimum is along the main axis only); wrapping text has a content child, a wrapping
  row of zero-high pieces as wide as its text side by side, the widest its
  longest word, so it has CSS text's max-content and min-content widths
  with no measuring callback; it is as high as its rows at the width it
  got (a second pass settles heights). A box sized to fit its content (no
  width of its own, not stretched across a column, or absolute) is fitted
  after a layout as CSS's fit-content (`fits`): Taffy lays a row that does
  not wrap, a box holding one and a grid with flexible columns
  (`minmax(0, 1fr)`, `minmax(80px, 2fr)`, lengths) at their max-content
  past the room they have, and an absolute box in its whole containing
  block, not in the room its insets leave it; a box found wider than its
  room is as wide as that room from the next layout (its min-content when
  that is more, found from what the scene knows: set widths, text's longest
  word, a grid's tracks' minimums, a row's items summed; a box whose
  min-content is not known so, a percentage or a track sized by its
  content, keeps the engine's width). It follows the room up to its
  max-content, and is laid out at its max-content again when its content
  changes. A tree the engine lays out right costs nothing more; a fitted
  box costs a layout pass or two more where it changes (node, ABBA, N=20,
  median, 1,000 boxes: a first layout 1.6 times, a resize 4.9 times).
- A `Solver` is the engine itself: `leaf`, `define` (a Box), `set`,
  `sized`, `children`, `remove`, `compute`, `read`. `useLayout(make)` sets
  one. The default is [Taffy](https://github.com/DioxusLabs/taffy) through
  `taffy-layout` (its WebAssembly build, pinned to 3.0.0): `await
  loadLayout()` loads and sets it (in node it reads the module beside
  taffy-layout; in a browser pass the URL of `taffy_wasm_bg.wasm`, which
  ren-show copies beside its page as `taffy.wasm`, or its bytes).
  src/taffy.js is the only module that imports taffy-layout; ren-skia and
  ren-three re-export `loadLayout`. Its cost on a 4,000-node tree (1,000
  wrapping rows of three leaves under a page column; node, median of 7):
  build 3.6 ms, full layout 13.8, relayout at a new width 12.7, 100 leaves
  changed 2.4, reading every box 5.0. No other WebAssembly or JavaScript
  engine on npm lays out materially faster with grid support; the cost is
  the WebAssembly build's (Taffy's algorithm runs 2.4 times faster
  natively), and the layout worker takes it off the main thread.
- Where it runs: in the Document's thread by default (boxes are read only
  for the items drawn), or in a worker. There, `serveLayout(port)` from
  `ren-canv/worker` (with `loadLayout` or `useLayout`) serves the
  Documents given `layout: remoteLayout(port)`: the commands go over the
  port, the worker lays the page out and sends back only the boxes that
  changed, and the Document paints when they come. A change that moves no
  box paints at once. One worker serves any number of Documents.
- CSS's initial content alignment holds: without a `justify`, a Box's
  `justify` is `'normal'`, Taffy's own default (the start in a flex
  container; a grid's `auto` tracks stretched over its free space, as a
  browser shares it), and `align-content` is never set (a grid's auto rows
  stretch too).
- Right to left (ren-core's `dir`, HTML's, inherited: the Box's `dir`),
  a box's children are placed from its right, as CSS's `direction: rtl`:
  a row's main axis and a grid's columns start at the right, and so do
  `justify`, `align` and `self` start (their end at the left); insets and
  margins stay physical. Taffy lays out left to right only, so the adapter
  mirrors (src/taffy.js `mirror`, as a box is read): a child's margin box
  is mirrored in its parent's content box (x' = left + right - x - width,
  its margins swapped), a relative offset is taken right to left (`right`
  before `left`), an absolute box placed by `right` is placed from the
  parent's padding box's right (by `left` it stays, by neither its static
  place is mirrored), and a Scroll's bar's room falls on its left; each
  level mirrors in its parent, here and in a layout worker. A tree with no
  right-to-left box reads its boxes unmirrored (one count, `rtl`, says
  there is none). A right-to-left Scroll keeps its bar down on its left
  and scrolls across from its right: its content overflows to the left,
  and its `scrollLeft` is 0 at its start and below 0 toward its end (a
  wheel to the right goes back toward its start), as the DOM's. A Scroll
  scrolls as far as its content reaches past the room inside its border
  (`scrollHeight` less `clientHeight`).
- Chrome is the oracle: test/oracle.test.jsx lays a hundred and fifty views out
  (flex, grid, wrapping and clipped text, sizes, insets, alignment, right
  to left) in
  DejaVu Sans and checks every box against the one Chrome gives the
  markup ren-dom writes for it, within a 64th of a pixel
  (`scripts/layout-oracle.mjs` records them).
- `Flow` lays the primitives out without drawing them, for a renderer that
  draws them itself: ren-dom's `layout` option (see ren-dom). Each island
  (the top of a view) is laid out at the width it is given; `arrange(done)`
  gives the items whose boxes changed, here or from a layout worker. Its
  `scale` option (the window's devicePixelRatio by default) is what
  borders snap to, as the browser snaps them; `rescale(scale)` changes it,
  and `retheme(tokens)` takes a new theme's metrics (a field's height, an
  entry's width, the text size and leading: ren-dom's `setTheme` calls
  it), every item laid out on them at the next `arrange`.
  `CanvasFonts` measures with a 2D context in a CSS font family, as the
  browser sets DOM text. A measure gets the face (`BOLD`, `ITALIC`) text is
  set in.
- Placement is CSS's with every primitive positioned: `position:
  'absolute'` takes an item out of the flow and places it by its insets
  (`top`, `right`, `bottom`, `left`, `inset`; px or percentages) against its
  parent's padding box, `'relative'` (or none) moves it by them from its
  place in the flow; sizes take percentages. The Box carries them (`position`,
  `inset`) to the engine, here or in a layout worker. The overlay (the
  layer portals render into) is as wide and as high as the viewport, so
  `inset: 0` and percentages there cover it, as a DOM portal layer does.
  A sticky item (`position: 'sticky'`) is laid out in the flow (its
  insets move nothing there) and painted held by its `top`, `right`,
  `bottom` and `left` (px, or percentages of the scrollport) inside its
  nearest Scroll's scrollport (its padding box less its padding and bars;
  the viewport without one), its margin box never past its containing
  block's content box (a Scroll's content as far as it reaches, to its
  left right to left); where both insets of an axis cannot hold, the
  start's wins (`right` right to left). Its `getBoundingClientRect()` is
  where it is held, as the DOM's. test/rtl-oracle.test.jsx checks every
  box, scrolled across left to right and right to left and down, against
  Chrome's (`scripts/rtl-oracle.mjs` records them). A fixed item (`position: 'fixed'`) is laid out out of
  the flow and painted after its layer, in z order, placed by its insets
  against the viewport, over the page's scroll and its ancestors' clips
  (its `getBoundingClientRect()` is that place); its sizes (percentages
  too) are laid out in its parent, but set between two insets on an axis
  without a size (`left` and `right`, `top` and `bottom`) it is as long as
  the viewport between them less its margins, as CSS's (the page's viewport
  stops at its scrollbar), and follows a resize.
- `display: 'contents'` (a View, Layout or Scroll's) makes no box, as
  CSS's: the item's layout node lists nothing and its parent's node lists
  its children in its place (`Boxes` lists them again when they change,
  or when it goes boxless or back; hidden, it is a box again, with no
  display, and its children go with it), so they lay out as its parent's,
  here and in a layout worker (a table row with `role="row"` whose cells
  sit in the table's grid). Its box's own style does nothing (padding,
  border, margin, sizes, placement, paint, transform, opacity, clip); text
  style passes through it and pointer events bubble through it; it is a
  press, hover and pointer target where its children are (its hit regions
  are their boxes, under theirs). Its box is empty at its parent's corner
  (its `getBoundingClientRect()` too). A sticky child of it is held within
  the nearest ancestor that makes a box (its containing block, as CSS's: a
  sticky header cell in a boxless row stays within the table).
- The wheel goes to the Scrolls around the topmost box under the pointer,
  innermost first (then the page), as the DOM's: an item lying over a
  Scroll without being in it keeps the wheel from it.
- Painting follows CSS's stacking contexts. Items paint in tree order;
  an item with a `zIndex` (or an `opacity` below 1, at 0), the page and the
  overlay are contexts. The contexts met inside one with a negative z paint
  over its own box and under its children, those with a positive z over
  everything else in it, in z order and equal ones in tree order, in the
  clip they were met in; a z of 0 paints in place. Hit regions follow the
  painting order, so the topmost takes the pointer. Pieces drawn out of the
  flow's order are damaged when their order alone changes.
- A box that clips (`overflow: 'hidden'`, a Scroll) clips its content to
  its padding box's rounded corners, as CSS does (the radius less the
  border: the `rclip` command); hit regions keep the rectangle. Each
  corner may have its own radius (fills, borders, shadows, focus rings
  and clips: `rround`, `rborder`, `rshadow`), scaled to fit the box as
  CSS scales them. The focus ring is a 2 wide stroke outside the box, as
  the DOM's outline. Borders take each side's width and color (`edges`,
  split at the corners as CSS splits them) and a style: dashed (dashes
  and gaps three widths long) or dotted (round dots), through `dash`. A
  gradient background fills the box in its corners (`gradient`): linear
  along CSS's gradient line at its angle, or radial from the center to the
  farthest corner. A Shape figure's `fill` (a rect, round, oval or closed
  path, not a stroke) is a color in place of its `color`, or a gradient
  laid the same way over its bounds (a path's points' box): the `shade`
  command before the figure, which a replay gives the next fill alone.
- An opacity below 1 composites the item in a layer (`layer`), except an
  empty box that draws one fill (no border, shadow, ring or gradient): its
  fill takes the opacity in its alpha, the same pixels without an
  offscreen layer. Measured with [ren-bench's opacity harness](https://github.com/wiltonlazary/ren-bench/blob/main/bench/skia/opacity.jsx) (60
  pulsing empty round boxes, node, CanvasKit raster, 400 frames, ABBA, load
  9.4-10.4): a frame 19.8 / 21.1 ms with layers, 1.43 / 1.48 ms folded (the
  replay 19.4-20.7 → 1.07-1.12 ms). An opacity-only restyle runs no layout
  (the engine is not called: its style key does not change); the scene's
  sync costs 0.19 ms a frame there.
- An Image fits its box as the style's `objectFit` says (`picture`:
  contain, cover or none, centered and clipped; fill draws `image`).
  A renderer's replay tells the Document a source that failed
  (`failed(source)`: Replay2D's and ren-skia's do): its Images hear
  `onError`, as a DOM img's `error`, and so does an Image that reaches the
  source later, with no load again. When the replay's cache evicts a failed
  entry, it tells the Document `forgot(source)` (an optional argument
  beside `failed` in Replay2D's and ren-skia's constructors): the next draw
  loads the source again, and only a failure of that load is an error.
- Transforms (`scale`, `rotate`, `translate` about `transformOrigin`, as
  CSS's, then `skewX` and `skewY` as CSS's `transform: skew()` after them) are painted (`transform`, around the item and what it holds, a
  Label's text too) and hit-tested (a point maps into the item's space for
  presses, pointer offsets, hover, text selection and wheel), never laid
  out; a transformed item is a stacking context, and its damage is the
  bounds of its transformed pieces. `getBoundingClientRect()` gives the
  bounds of its box under its own and its ancestors' transforms, as the
  DOM's.
  `test/paint.test.jsx` checks the paint commands.
- Text is set in a face (`BOLD`, `ITALIC`, and `MONO` 4 for a family
  naming monospace, inherited): a measure (`Fonts.width`, `metrics`) and
  the text command's flags get it, and a renderer draws MONO in its
  monospace typeface when it has one. Weights take the nearest face: 600
  and above bold.
- Typefaces: a style's `fontFamily` (inherited) is set in the typeface
  the Fonts give for it (`Fonts.typeface`: the slot of the first name of
  the list it has, before a generic family; the root face otherwise), its
  slot carried in the face (`face >>> SLOT`). Text a typeface lacks
  falls back by cluster, as Chrome's: a character with the marks, joiners
  and modifiers that continue it is measured and drawn in the first of the
  typeface and the fallbacks that has all of it (the default ignorables
  need no glyph), in the typeface's own missing glyphs when none has
  (`Fonts.faces`: a piece in a fallback is a text command in that
  typeface's slot). A mark only a fallback has takes its base there when
  the fallback has the base too; a base only a fallback has stays in the
  typeface, as its missing glyph, under a mark only the typeface has.
  `Faces` is such Fonts over font files (`font`, `mono`, `families` by
  name, `fallback` in order), which ren-skia and ren-three build from
  their options; a character no typeface has measures as the missing
  glyph. Each piece is shaped in its own typeface (below).
- Shaping: text whose script or marks a shaper sets otherwise than by the
  typeface's advances is measured, drawn, hit and selected as its shaped
  glyphs: Arabic and the other joining scripts joined (lam-alef one
  glyph), Indic and the other complex scripts in their clusters, marks
  placed on their bases, default ignorables (a soft hyphen, joiners, bidi
  controls) hidden. Which text that is (`complex` in src/shape.js): a
  mark, a format character, a character of a joining or complex script
  (Arabic, Syriac, N'Ko, the Indic scripts, Thai, Lao, Tibetan, Myanmar,
  Khmer, ...), Hangul jamo, emoji modifiers and flags. Everything else
  (Latin, Greek, Cyrillic, CJK, Hebrew without points) keeps the advance
  path, one scan of the text on a measure that misses the cache: a shaper
  would set it at its advances too, since kerning and the optional
  ligatures (common, discretionary, historical, contextual) are off, as
  ren-dom sets DOM text (`font-kerning: none`, `font-variant-ligatures:
  none`; a script's required features stay). Chrome with its defaults
  kerns and ties `fi`, `ffi` in DejaVu Sans; with those two off it sets
  Latin at the advances, as the canvases do.
  - The shaper is replaceable: the engine sits behind a neutral boundary
    (src/shape.js). A `Shaper` gives a font file's typeface a handle
    (`face`) and sets a run of one script in its glyphs (`shape(face,
    text, start, end, rtl, features)`: ids, advances, offsets and cluster
    indices, in font units, in visual order). `useShaper(shaper)` sets
    one, or none (null: the advances). The default is HarfBuzz, the shaper
    Chrome uses, through the pinned harfbuzzjs package's WebAssembly
    (src/harfbuzz.js is the only module that knows it, calling HarfBuzz's
    C functions itself: the package's own entry instantiates its module at
    import from a file beside its script). `await loadShaper()` loads and
    sets it: in node it reads `harfbuzz.wasm` beside harfbuzzjs; in a
    browser pass its URL (copied beside the page, as `taffy.wasm`), a
    Response, the bytes or the compiled module. In node it also loads on
    demand, at once, the first time text needs shaping (unless
    `useShaper` chose); in a browser text measured before `loadShaper`
    is set by the advances. Shaping runs where text is measured, the
    Document's thread: a layout worker gets content sizes and needs no
    shaper. The module is 434 KB (`harfbuzz.wasm`); a typeface's file is
    copied into its memory once per content.
  - Cost (node, load under 3): Latin keeps its cost, ren-bench's Skia frame
    harness (1,000 rows, damage arm, ABBA, N=20, median paired ratio)
    within 0.995–1.006 of the advance path on every operation, its A/A
    control 0.984–1.000; a width not cached costs 1.1 µs for 50 Latin
    characters and 21 µs for 50 Arabic ones shaped (1.1 µs by their
    advances); a cached width costs the same either way.
  - Text is shaped per typeface piece (a fallback's piece in the fallback),
    per run of one script (neutrals join the run before them), each in its
    direction, the text around a run its context; a right-to-left piece
    lays its runs from the right. `Sfnt.shaped` caches the glyphs by text
    and direction; `Sfnt.width` is the shaped advance.
  - Carets follow clusters (`Fonts.offsets`): the caret at an offset is
    the advance of the clusters before it in the text's order, a
    ligature's advance shared evenly among the grapheme clusters it holds,
    an offset inside a cluster at its start. The caret, the selection's
    pieces, a point's offset (`offsetAt`, a press in an Edit) and a row's
    hits read them. Rows wrap by the widths of their texts, each row
    shaped on its own.
  - Drawing agrees with measuring: ren-skia draws the shaped glyph ids at
    their places (the same `Sfnt.shaped`); a 2D canvas (`Replay2D`,
    ren-three) draws the string with kerning off and `textRendering:
    'optimizeSpeed'` (no optional ligatures), the browser shaping it with
    the same HarfBuzz and features, so at the measured width.
  - Chrome is the oracle: test/shaping-oracle.test.js checks the widths,
    each grapheme cluster's box and the caret before it in lines of
    Arabic (joined, with marks, lam-alef), Hebrew with points, Devanagari
    (Noto Sans Devanagari as a fallback), Latin with marks, Latin, and
    marks one typeface lacks (fallback by cluster) against Chrome's, within a 32nd of a pixel
    (`scripts/shaping-oracle.mjs` records them).
- Right-to-left text: each row is laid out by the Unicode bidirectional
  algorithm (src/bidi.js, UAX #9 of Unicode 16.0.0, its data generated by
  scripts/bidi-data.mjs; test/bidi.test.js runs a subset of the Unicode
  BidiCharacterTest cases, and the whole file passes) as a paragraph in
  the item's direction: left to right, the DOM's default, or right to left
  with `dir="rtl"` (inherited; `dir="auto"`: the direction of the first
  strong character of its text, an Edit's value as it is typed, a
  container's descendants' past those with a `dir` and Edits, left to
  right without one, as Chrome resolves it). A row that runs left to right
  whole (no right-to-left character, left to right) is drawn, measured and
  hit as it is (one scan of its characters, `order` in src/text.js);
  otherwise its level runs are drawn in their visual places, a right-to-left
  run a text command of its own (`RTL`, its x its right edge) that a
  replay draws reversed and mirrored (ren-skia) or sets right to left (a 2D
  canvas). `textAlign` 'start' and 'end' land on the sides of the item's
  own direction (inherited as given: 'start' is the right of a
  right-to-left child); an Edit takes only its own (at its start
  without one) and an Action centers, as a browser's form controls reset
  it (test/rtl-oracle.test.jsx checks the side against Chrome's field). The caret stands at the start edge of the character
  after it (its right in a right-to-left run); the arrow keys move it in the
  text's logical order the way its direction runs (right to left, the left
  arrow goes on), as Chrome's fields do; a point maps to the offset nearest
  it in the run under it, and a selection shows as a piece for each visual
  run it reaches. A right-to-left Edit sets its value at its right, its
  caret 2 wide on its left side; one line wider than the field starts at
  its right and scrolls the least that shows the caret, and a multi-line
  Edit's rows align at the right, the spaces a soft wrap leaves hanging
  past its left (`indent` in src/layout.js, which drawing and hitting
  share). The accessibility mirror's element and the native text entry
  take the item's `dir`. test/bidi-oracle.test.js checks each character's
  place in rows of Hebrew, Latin, digits and brackets, left to right and
  right to left, against Chrome's (`scripts/bidi-oracle.mjs` records
  them); test/direction.test.jsx checks the rest.
- Adjacent text in a container (`<View>Count: {n}</View>`) is one
  anonymous box, as CSS wraps a run of text: its first text node lays out,
  draws and selects the run's text, the others take no room. It is CSS's
  `white-space: normal`, as on the DOM: it wraps, each run of spaces,
  tabs and line breaks is one space, none is left at its ends, and white
  space alone takes no room. Inside an Action it keeps its spaces and line
  breaks on one line (`pre`, a DOM button's). A Label keeps them always.
- Text inherits color, size, weight, italic, alignment and line height as
  in CSS, its decorations (underline, strike) reach the text below, and it
  sits in its line box where CSS puts it; the page takes its
  scrollbar's width while it overflows; painted boxes snap to device pixels.
- `textTransform` shows text in a case, as CSS's text-transform (`cased`
  in src/text.js): uppercase and lowercase as JavaScript's (the whole text,
  so a final sigma lowers as it should), capitalize the first letter of
  each word as ICU's word breaks find them (`Intl.Segmenter`, as Chrome's:
  "quick-brown fox's" is "Quick-Brown Fox's"). It inherits, but an Action
  and an Edit take only their own (a browser's form controls reset it), and
  an Edit shows its value as typed. The item keeps the text given (its
  `text`, runs and TEXT children, which ren-json reads); what is measured,
  wrapped, painted, selected and copied is the text shown, as Chrome copies
  a transformed text. It keeps the text's length, so runs, selection and
  `offsetAt` keep their offsets: a character whose case takes more or
  fewer UTF-16 units keeps its own (`ß` stays `ß` in uppercase, where
  Chrome shows `SS`).
- Rounding as Blink's (checked box by box against headless Chrome,
  `src/units.js`): a text width up to a 64th of a pixel, each styled run's
  on its own; a line box the font size to the nearest 64th times the
  leading, down to a 64th; text set at its size down to a 64th
  (`Sfnt.sized`, as FreeType takes sizes); lengths (padding, margins, gaps,
  sizes, insets) in 64ths toward zero; borders in whole device pixels, one
  thinner than a pixel as one; and the canvas's own sub-pixel place kept
  as a shift. Percentages are Taffy's, in 32-bit floats; Taffy wraps a
  flex line that overflows by any amount, so a percentage main size in a
  wrapping row (a height in a wrapping column) is shaved by 2^-16 of
  itself (at most 0.015 px at 1000 px, under the 64th Chrome floors
  away), and percentages that sum to 100% keep one line, as in Chrome.
  The adapter (src/taffy.js) also holds a grid in a column of fixed height
  from shrinking below its content, and clamps a size in pixels by its
  minimum and maximum before a flex column sized by its content uses it.
  `test/layout.test.jsx` pins flexbox and grid to the numbers a browser
  computes; `test/worker.test.jsx` lays out in a worker exactly as in the
  thread, and through a replacement engine.

## Input as the DOM has it

The same component code handles input the same way on the DOM and on the
canvases: the event names, fields and semantics are the DOM's.

- **Pointer events.** `onPointerDown`, `onPointerMove`, `onPointerUp`,
  `onWheel`, `onPointerEnter` and `onPointerLeave`. The event (`Pointer`)
  has `x` and `y` in the surface's logical pixels (also `clientX` and
  `clientY`; these cross to a worker), `offsetX` and `offsetY` from the
  target's padding box, `button`, `buttons`, `pointerId`, the modifier keys,
  and a wheel's `deltaX`, `deltaY` and `deltaMode`. Its target is the
  topmost box drawn under the pointer (the DOM's element under it; offsets
  are from its padding box), and it bubbles through the target's
  ancestors' handlers (`stopPropagation`, `target`, `currentTarget`); enter and leave
  go to each item entered or left and do not bubble. Nothing holds the
  pointer until a handler captures it: `e.currentTarget.setPointerCapture(
  e.pointerId)` keeps its moves and release on that item until the release
  (as on the DOM; a worker cannot capture). `preventDefault` on a
  pointerdown keeps its own response (focus, a selection), as a DOM
  mousedown's; the press still happens (a click is not its default); on a
  wheel, the scroll. `attach` passes the browser event's buttons,
  modifiers and deltas, and scrolls lines and pages as far as a browser does.
  A pointerdown carries no click count (Chrome's `detail` is 0, and a
  prevented one sends no mousedown), so the Document counts runs of clicks
  itself from the presses' platform times: the same button within 500 ms
  and 4 px of the last press is its next click (a double or triple click);
  a count the platform does give wins, and a press made by code keeps its
  own. `prevent` names default actions the canvas cancels, as ren-dom does:
  over an item that names `contextmenu` (or under one that does), the
  browser's context menu stays away, for the app's own (`cancels(type, x,
  y)` answers for a point).
  A touch follows the style's `touchAction`, as CSS's touch-action: the
  topmost item under the press and each ancestor that sets one allow pans
  and a pinch zoom together (`touchAction(x, y)` answers the bits: 1
  pan-x, 2 pan-y, 4 pinch-zoom, -1 none set). They allow nothing: its
  touchstart is cancelled; some pans: its first move is, when it goes
  along a forbidden axis (the larger of its moves across and down); a
  second finger's start and moves, when they forbid a pinch zoom. Where
  none sets one, a touch that presses something (a handler, a selection, a
  field) keeps the page from panning (its touchstart is cancelled), so a
  drag on the canvas stays the app's, and a touch on nothing lets the page
  scroll. When the browser takes the pointer back anyway (a pan or zoom
  the items allow, a palm), `cancel(x, y)` sends `pointercancel` to the
  item holding the pointer (captured), else the one under where it last
  was (the browser's cancel says 0, 0), bubbling, and ends the press with
  no `pointerup`, as the DOM's.
  A press of another button (a right press) reaches the pointer handlers
  alone (`secondary`), so an app can open its own menu there; it presses,
  focuses and selects nothing, as a DOM click is the main button's.
- **Presses.** A press reaches the topmost box drawn under the pointer,
  and the nearest of it and its ancestors that takes presses (an Edit, an
  Action, an item with `onPress`), as a DOM click reaches its element: a
  box lying over a target without being inside it keeps the press from it,
  unless its style's `pointerEvents` is `'none'` (inherited; a child's
  `'auto'` takes the pointer again): then presses, hover, pointer events,
  the wheel and text selection go through it, as CSS's pointer-events.
  The target is the one under the pointer before the pointerdown handlers
  ran, as the DOM's: one that lays a backdrop over it leaves it focused.
  The press (`Press`: `x`, `y`, `target`, `currentTarget`,
  `stopPropagation`) bubbles from that item through its ancestors'
  `onPress`, as a click does, from a pointer, Enter or Space on a focused
  Action, and the mirror. A press focuses the Edit or Action it presses,
  else the nearest View, Layout or Scroll with a `tabIndex` around the
  point, as a DOM click focuses its nearest focusable ancestor.
- **Inert.** `inert` on any primitive makes a region that takes no part
  in input, as the DOM's `inert` attribute: nothing in it takes the focus
  (Tab, `focus()` and `focusFirst` pass it by; made inert while it holds
  the focus, it gives the focus up), the pointer goes through it to what is
  under it as `pointerEvents: 'none'` would send it, with no child taking
  it back, its text is not selected, and the accessibility mirror marks its
  element `inert`, which leaves it out of the accessibility tree.
- **Keys.** `onKey` hears the key pressed while an item has focus, from the
  focused item up through its ancestors (`Key`: `key`, the modifiers,
  `preventDefault` keeps a field from editing, `stopPropagation`). Then
  the root's handlers hear it (ren-core's `$keys`, `listen(root, 'keys')`),
  as a document's keydown listener hears it last, and with nothing focused
  they alone do; a focused `stopPropagation` keeps it from them. Chords
  (Ctrl, Cmd or Alt with a character) reach the handlers and edit nothing;
  `attach` lets the platform have them (copy) unless one prevents it, and
  Ctrl or Cmd+A selects all after them. A modifier with an arrow,
  Backspace, Delete, Home or End (a word or line move, a word deletion)
  is the native entry's under `attach`, which edits and mirrors back;
  without one the plain key's move stands in. ArrowUp and ArrowDown move a
  multi-line Edit's caret along its drawn (wrapped) rows, keeping its x
  through a run of them, and Home and End go to a drawn row's start and
  end, as a textarea's (test/rows.test.jsx replays Chrome's recorded moves). The key's `editable` is true
  while an Edit has focus, so a root-wide shortcut can leave keys typed in
  fields alone.
- **Root-wide scrolls.** When a Scroll scrolls (the wheel, a ref's
  `scrollTop`), the root's handlers (ren-core's `$scrolls`,
  `listen(root, 'scrolls')`) hear it first, as a document's capture-phase
  scroll listener, then its `onScroll`, each with its own event (a scroll
  does not bubble: its `stopPropagation` ends nothing); the page's own scroll reaches
  them too, its target the root. A popup follows its target through it.
- **Element methods.** A ref is an item with the DOM's methods: `focus()`
  (on an item that cannot take the focus, a Label or a View without a
  `tabIndex`, or in an inert region, it does nothing, as on a DOM element
  that is not focusable), `blur()`,
  `setPointerCapture`, `getBoundingClientRect()`, on a Scroll
  `scrollTop` and `scrollLeft` (settable), `scrollHeight`, `scrollWidth`,
  `clientHeight`, `clientWidth` (a Scroll scrolls along its `axis`: `'y'`
  by default, `'x'` or `'both'`, with a bar along each; the wheel's
  `deltaX`, and Shift with the wheel, scroll across), on a Label
  `offsetAt(x, y)` (the offset in its text nearest a point of the surface,
  where it was last drawn; -1 when not: the DOM's counterpart is
  `document.caretPositionFromPoint`), and on an Edit
  an input's caret API: `setSelectionRange(start, end, direction)`
  (clamped to the value; an end before the start collapses at the end; the
  caret at the end unless `'backward'`), `selectionStart` and
  `selectionEnd` (settable) and `selectionDirection`, and `caretRow()`:
  the drawn row its caret is in and its row count, `{ row, rows }` from 0
  (the caret where a row wraps on the next row, unless End put it at the
  row's end; a one-line Edit's is row 0 of 1), test/rows.test.jsx checking
  them against the rows Chrome wraps a textarea into. An unfocused Edit
  keeps a selection set so until it gets focus (at the end of its value
  otherwise); a Scroll sends `onScroll` (`Scrolled`) as it moves. `getBoundingClientRect()` gives the
  item's border box where it was last laid out, in the DOM's shape (`x`,
  `y`, `left`, `top`, `right`, `bottom`, `width`, `height`) and the
  Document's CSS pixels (its canvas's; a ren-three panel's own), the
  offsets of the Scrolls around it and of the page applied, a sticky item
  where it is held, a fixed one where it is placed, and transforms applied
  (the bounds), as the DOM's; it does not lay out. A component measures an anchor with it on every renderer.
- **Scrollbars.** A Scroll draws a bar along each axis it scrolls while
  its content overflows: the theme's `bar` wide, a muted round thumb on a
  soft track, with that room kept beside its content whether or not it
  overflows (the DOM's `scrollbar-gutter: stable`). Its style's
  `scrollbarWidth` (CSS's scrollbar-width, its own) makes it half as wide
  (`'thin'`) or takes the bar and its room away (`'none'`: the wheel,
  touch and `scrollTop` still scroll it), and `scrollbarColor` ([thumb,
  track], inherited as CSS's scrollbar-color) colors it.
- **Tab order.** Tab and Shift+Tab move among the items Tab reaches: the
  Edits and Actions, and the Views, Layouts and Scrolls whose `tabIndex` is
  0 or more, shown, enabled and not inert, those with a `tabIndex` above 0
  first (ascending), then the rest in document order, as the DOM's; a
  `tabIndex` of -1 keeps an Edit or Action out of that order (focusable from
  code and by a press) and makes a View, Layout or Scroll focusable without
  joining it (a skip link's target): Tab from it goes on from its place in
  the document. A keyboard focus rings an Action or a region as it does on
  the DOM's `:focus-visible`, and so does a focus from code while the last
  input was a key, not the pointer (a roving focus the arrow keys move); Enter and Space press only an Action.
- **Focus trap.** Inside a `trap` (a View, Layout or Scroll), Tab and
  Shift+Tab move among its own, cycling. When the focused item inside it
  is removed, the trap, still shown, takes the focus back: its first
  focusable, else itself when it takes the focus (a `tabIndex`). An item's `getRootNode()` is its
  Document, whose `activeElement` is the focused item, as a DOM element's
  root node. An item's `focusFirst()` and `focusLast()` focus the first
  or last item Tab reaches inside it, in document order, and return whether
  one took the focus: ren-core's `$focus(ref)`, which a FocusTrap opens
  with.
- **Focus events.** As the DOM's: the item losing focus hears `onBlur`,
  then `onFocusOut`, the item taking it `onFocus`, then `onFocusIn`, each
  its own event (`target`, `relatedTarget`; focus and blur do not bubble);
  focusout and focusin bubble through the ancestors (`stopPropagation`
  ends them), with `relatedTarget` the item on the other side (null:
  none), so a wrapper hears focus move into or out of it. A focused item
  hidden or disabled gives the focus up the same way: `onBlur`, then
  `onFocusOut` (`relatedTarget` null) through the ancestors it had. A
  focused item removed hears nothing (ren-core drops its handlers before
  it goes); only the ancestors it had hear `onFocusOut`. Chrome fires the
  removed element's own blur too.
  Nothing has the focus while the old item hears them: a handler there
  that moves the focus elsewhere wins, and the item it was going to hears
  nothing, as in Chrome; a focus handler that moves it on leaves its
  item's focusin unheard, as Chrome does (`scripts/focus-oracle.mjs`
  records these).
- **Drop.** `onDrop` hears files dropped on the canvas (`attach` accepts
  the drag and passes the drop to `dropFiles(x, y, files)`): `{ files, x,
  y }`, bubbling from the item under the point, `stopPropagation` ending it.
  The drag before it goes to the items under it as the DOM's: `attach`
  passes the canvas's dragenter and dragover to `dragOver(x, y, files,
  types)` (the file items' count and MIME types) and its dragleave to
  `dragLeave()`; when the item under the drag changes, the new one hears
  `onDragEnter`, then the last one `onDragLeave` (one hidden or removed
  since: its nearest ancestor still attached), and the one under it
  `onDragOver`, each bubbling; a drop ends the drag without a leave. On the
  main thread only (a worker's handlers hear no drag). `dropTarget(x, y)`
  is the item a drag or drop there reaches (the one under it, or its
  nearest ancestor that listens for one; null: none): a host that lays the
  page over other content (ren-three's overlay) takes files where it is
  not painted but an item hears them.
- **Viewport.** The Document's `viewport(report)` (ren-core's `$viewport`
  and `$media`) reports its size in logical pixels (the canvas's; a
  ren-three panel's own) and the window's `prefers-color-scheme: dark` and
  `prefers-reduced-motion: reduce` (its host element's window, else the
  global one; none in node), now and after each `resize` or change of
  preference; it follows the preferences only while one reads them.
- **Resize.** `onResize` hears an item's border box `{ width, height }`
  after the layout that first places it and after each that changes its
  size, as a ResizeObserver on the DOM.
- **Moves.** ren-core's `$moves` (`listen(item, 'move')`) hears an item's
  border box painted somewhere new: after each frame the Document compares
  the listening items' `getBoundingClientRect()` with the place last told
  (the first, where it was when the listening started, is only noted) and
  tells `{ type: 'move', x, y }`, whatever moved it: a layout shift, a
  scroll, a transform, an animation. It measures nothing on a frame that
  does not paint.
- **Cursor.** The portable style's `cursor` (or a hover style's) shows on
  the canvas over the item, as the DOM shows it.
- **An Action holding content.** As a DOM button holds its content, an
  Action with children (not `text` alone) lays them out as a View does
  (the portable style's direction, gap, padding and alignment apply; it
  centers them by default) and paints them inside it. It stays one target:
  a press anywhere on it presses it and focuses it, its content is not a
  target of its own (unless an Edit, an Action or a handler makes it one)
  and its text is not selectable; its hover, press and focus states, keys
  and focus ring are a text Action's. The accessibility mirror names it by
  its `label`, else by the text it holds. An item's `label` reads that
  name, the DOM's accessible name: the label given, else, on an Action or
  an item whose role ARIA names by its content (radio, tab, option,
  menuitem, ...), the text it holds, white space collapsed.
- **Edits as DOM inputs.** A controlled Edit (a bound `value`) shows its
  bound value again when the view does not adopt an edit (ren-core's rule,
  so worker mode too). When the view rewrites the focused Edit's value (a
  mask, a rejected keystroke), the caret goes to the end, as the DOM puts
  it; a value written back as typed keeps it where it was. `disabled`
  takes no focus (a press, Tab and `focus()` pass it by; disabled while
  focused, it gives the focus up) and no edits, and is drawn on the
  theme's `soft` with `muted` text unless its style says otherwise.
  `readOnly` takes focus, selection and copy, not edits (keys, typing,
  composition and the native entry leave the value). `secret` (one line)
  draws a bullet per UTF-16 unit of its value, which stays real; copy
  gives nothing, a double press selects it all, the native text entry is a
  password input and the mirror reads bullets. `autosize` makes a
  multi-line Edit as high as its wrapped rows, from `lines` up to
  `autosize` rows (true: no limit), laid out again as the value changes.
  The placeholder takes the style's `placeholderColor` (inherited), else
  the theme's `muted`.
- **Labels that clip.** `lines` clamps a Label to that many wrapped rows,
  the last kept ending with an ellipsis (…) cut to its width (after the
  spaces it wrapped at); `ellipsis` keeps it on one line and ends each line
  too wide with one. Either lets the Label shrink below its text (its
  automatic minimum is 0, as CSS's for a box that clips). A row is cut
  where it is drawn, as Chrome cuts it: laid out from its start edge, the
  characters past its width less the ellipsis go (spaces as any), and
  those kept stay in their places, the ellipsis on their end side. A
  right-to-left run in a left-to-right row (or one left to right in a
  right-to-left row) keeps its last characters, so a row of mixed
  directions may keep characters apart in the text (`kept`, with their
  levels in the whole row, `levels`); hits, selection and runs map
  through them. test/rtl-oracle.test.jsx checks which characters show,
  where, and the ellipsis against Chrome's screenshot, one line and
  clamped, left to right, right to left and mixed.
- **Styled runs.** A Label's `runs` (ren-core's `{ text, style, onPress }`)
  are measured, wrapped and painted piece by piece: each run's style (the
  text part of the vocabulary) over the Label's inherited text; text is
  measured through a `Measure` (text.js: one `Face`, or `Runs`), so a
  word may span runs and wraps as one. Each row's line box is CSS's: every
  run in it and the Label's own text (its strut) have their own leading on
  one baseline, and the row is as high as the highest above and the
  deepest below it (`tops`, `bases`). A piece is a text command in its
  run's face, size and color, its background a rect behind its text (its
  font's ascent and descent, as a span's), its underline and strike its
  own. `lines` and `ellipsis` cut the joined text; the ellipsis takes the
  run of the character before it. Selection, copy, a double press's word
  and `offsetAt` read the plain text's offsets; the selection fills each
  row's line box. A run's `onPress` hears a press on its characters first
  (a `Press` whose target is the Label), then the Label's own unless it
  stops it; direct mode only.
- **Runs over an Edit.** An Edit's `runs` (ren-core's `{ text, style }`)
  style its value while their texts joined are its value (`edited` in
  scene.js: a draft the view has not answered yet, or a secret's
  bullets, draws plain). A run keeps the Edit's size and family
  (one line height, as a native field and ren-dom's mirror), so rows keep
  the Edit's line and baseline; its weight and italic are its face. The
  value is measured through the runs (`measureOf`): soft wraps (`Lines`),
  the caret's x, the selection and composition marks (`span`), the caret
  under a press (`place`) and an autosized Edit's rows; pieces paint as a
  Label's (`typed` in draw.js: backgrounds, then text and decorations).
  test/edit-runs.test.jsx pins them.
- **Words.** A double press selects a word by Unicode's rules, so `218.41`,
  `3,284` and `can't` are one word, as in a browser.

## Accessibility mirror

Under `attach` (the `aria` option, on by default), a visually hidden DOM
tree beside the canvas mirrors the scene for assistive technology
(src/aria.js), kept in step incrementally: a div per container, a p per
Label, a button per Action (activating it presses the Action), a textbox
per Edit, an img per Image, and a div per Shape marked with a `role`. The
caller's meaning marks (ren-core's Meaning props) are written on each
element as ren-dom writes them: `role`, every `aria-*` state and property
(a boolean as its text), `id` and the microdata (`itemscope`, `itemtype`,
`itemprop`, `itemref`, `content`, `datetime`); a mark no longer given
goes. A container's or a Shape's `label` names it (`aria-label`) unless
an `aria-label` does, so a radio group reads as a radiogroup of radios
with their `aria-checked`, tabs as a tablist of tabs with their
`aria-selected`, and `aria-hidden` decoration is left out
(test/aria.test.jsx).

## Text selection

As in a browser: a press and drag across Labels selects their text in
document order; a double press selects a word, a triple a whole Label, and
Shift extends; Ctrl or Cmd+A selects all (the focused Edit's value, else
the page's text); copy (the platform's shortcut or menu while the canvas
has focus) puts the selected text on the clipboard, a line break between
Labels. Inside an Edit the same gestures select its value. Presses on
Actions and press targets press them instead; `style.select: 'none'`
leaves text out (it inherits). `copied()` returns the selected text.

## A renderer on ren-canv

```js
import { Document } from 'ren-canv';

class Mine extends Document {
  constructor(options) {
    super(fonts, options); // fonts: { width(text, size, face), metrics(size, face), close() }
  }
  get kind() { return 'mine'; }             // Runtime's renderer name
  get drawing() { return this.surface !== null; }
  draw(frame, damage) { /* replay frame.ops and frame.texts; damage null: whole */ }
  canvasFor(element) { /* the canvas of an application root, or null */ }
  sized() { /* the viewport changed: make the surface again */ }
}
```

`present()` lays out and paints when something changed, compares the frame
with the last one and calls `draw` with the damage (null to repaint whole,
never when nothing differs). A damage rectangle grows over each piece it
cuts that has an antialiased edge (text, a rounded fill, a border, a
figure), so a clip never runs along one; a plain fill on whole device
pixels clips exactly and stays out, so two changes beside a column's edge
do not pull in the columns' backgrounds (measured with [ren-bench's busy-screen harness](https://github.com/wiltonlazary/ren-bench/blob/main/bench/skia/busy.jsx), documented in ren-skia's README, Benchmarks). The command buffer's format is in
`src/draw.js`.

## Tests

```sh
npm install        # ren-core and rrx-core (linked), pinned devDependencies
npm test           # declarations, tsc --checkJs --strict, the TypeScript consumer, node:test twice
```

`test/document.test.jsx` drives a Document with a fixed-width measure and no
surface. ren-skia's suite checks the same engine through CanvasKit pixels.
The other suites each cover one part of the engine: `action`, `backend`,
`bidi` and `bidi-oracle`, `contents`, `damage`, `edit` and `edit-runs`, `flow`,
`focusable` (tabIndex and inert), `fonts`, `layout`, `paint`, `place`,
`nonfinite`, `rtl-oracle`, `runs`, `selection`, `shaping` and `shaping-oracle`,
`taffy-load` and `worker`.
`test/timers.test.js` fails a timer call that does not say why it is one, and
`test/exports.test.js` locks the public contract to `test/exports.lock.json`.
