// ren-canv: the engine of ren-core's drawn renderers. A Document is a ren-core
// Host over a retained scene of the portable primitives, with its own layout,
// text, painting into a flat command buffer, damage tracking, hit testing,
// input routing, editing, the native text entry and the accessibility
// mirror. A renderer package subclasses it and replays its frames on a
// surface: ren-skia on CanvasKit, ren-three on a 2D canvas drawn into a
// three.js scene.

export { Document, Press, Pointer, Change, Key, Scrolled, render, attach } from './document.js';
export { Item } from './scene.js';
export { decode, commands, operands, hex, Frame, Damage } from './draw.js';
export { Theme } from 'ren-core/host';
export { Sfnt } from './sfnt.js';
export { Faces } from './faces.js';
export { remoteLayout, serveLayout, useLayout } from './engine.js';
export { loadLayout } from './taffy.js';
export { useShaper } from './shape.js';
export { loadShaper } from './harfbuzz.js';
export { Flow, CanvasFonts } from './flow.js';

/** @typedef {import('./document.js').Options} Options */
/** @typedef {import('./text.js').Fonts} Fonts */
/** @typedef {import('./faces.js').Typefaces} Typefaces */
/** @typedef {import('./engine.js').LayoutPort} LayoutPort */
/** @typedef {import('./engine.js').Solver} Solver */
/** @typedef {import('./engine.js').Box} Box */
/** @typedef {import('./shape.js').Shaper} Shaper */
/** @typedef {import('./shape.js').Glyphs} Glyphs */
