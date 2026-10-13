// ren-canv/backend: what a renderer package needs to replay a Document's
// frames on its surface: the opcodes of the command buffer (see draw.js for
// each command's operands) and the Fonts contract text is measured through.
// Applications import `ren-canv` or a renderer package, not this.

export { TEXT_OP, RECT, ROUND, CLIP, SAVE, RESTORE, LINE, OVAL, PATH, IMAGE_OP, BORDER, SHADOW, LAYER, BOLD, ITALIC, commands, operands, Frame, Damage } from './draw.js';

export { MONO, RTL, SLOT } from './text.js';
export { reversed } from './bidi.js';
export { Sfnt } from './sfnt.js';
export { Faces } from './faces.js';
export { Replay2D } from './canvas2d.js';

/** @typedef {import('./text.js').Fonts} Fonts */
/** @typedef {import('./faces.js').Typefaces} Typefaces */
/** @typedef {import('./canvas2d.js').Picture} Picture */
