// ren-canv as a TypeScript consumer sees it: a Document over a measure of
// its own, and a backend reading the command buffer.
import { View, Label } from 'ren-core';
import { Document, render, attach, decode, Theme, type Fonts } from 'ren-canv';
import { TEXT_OP, operands, type Frame } from 'ren-canv/backend';

declare const canvas: HTMLCanvasElement;
const fonts: Fonts = { width: (text, size) => text.length * size, metrics: size => ({ ascent: size, descent: 0 }), close() {} };
class Mine extends Document {
  override get drawing() {
    return true;
  }
  override draw(frame: Frame) {
    void (frame.ops[0] === TEXT_OP), operands;
  }
}
const doc = new Mine(fonts, { width: 100, height: 100, theme: { accent: 0xff000000 } });
const dispose: () => void = render(() => <View><Label text="x" /></View>, doc);
const stop: () => void = attach(doc, canvas);
const theme: Theme = new Theme();
void decode(doc.frame), dispose, stop, theme;
