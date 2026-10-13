// Whole 64ths of a pixel, as Blink's LayoutUnit keeps lengths: one rounding
// per direction, each allowing for the float noise of the arithmetic before
// it (a sum of advances, a product), so an exact 64th stays itself.

/** Up to the next 64th: a text width (LayoutUnit::FromFloatCeil). @param {number} v */
export const up64 = v => Math.ceil(v * 64 - 1e-6) / 64;

/** Down to a 64th: a line box, a size glyphs are set at. @param {number} v */
export const down64 = v => Math.floor(v * 64 + 1e-6) / 64;

/** To the nearest 64th: a font size as a line box takes it (LayoutUnit::FromFloatRound). @param {number} v */
export const near64 = v => Math.round(v * 64) / 64;

/** Toward zero, to a 64th: a length (LayoutUnit's constructor). @param {number} v */
export const toward64 = v => Math.trunc(v * 64 + (v < 0 ? -1e-6 : 1e-6)) / 64;
