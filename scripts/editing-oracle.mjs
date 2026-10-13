// Records how Chrome steps the caret and erases in a textarea, the oracle
// test/editing.test.jsx checks an Edit against: for each case, the carets
// ArrowRight and ArrowLeft visit, and what Backspace and Delete take at each.
// Run it under the machine-wide Chrome lock and commit what it writes:
//   flock "$HOME/.cache/chrome-bench.lock" node scripts/editing-oracle.mjs test/fixtures/editing.json
import { writeFileSync } from 'node:fs';
import { withChrome } from './chrome.mjs';
const cases = [
  ['flags', 'a\u{1F1E7}\u{1F1F7}\u{1F1EF}\u{1F1F5}b'],
  ['odd flag run', '\u{1F1E7}\u{1F1F7}\u{1F1EF}x'],
  ['ZWJ family', 'a\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}b'],
  ['ZWJ ending in a modifier', 'a\u{1F469}\u{1F3FD}‍\u{1F4BB}b\u{1F44B}\u{1F3FD}'],
  ['long ZWJ chain ending in a modifier', `x${Array(40).fill('\u{1F468}').join('‍')}\u{1F3FD}y`],
  ['VS16', '❤️x☺️'],
  ['keycaps', '1️⃣2️⃣#️⃣'],
  ['text-style VS15', '❤︎x'],
  ['eye in speech bubble', 'a\u{1F441}️‍\u{1F5E8}️b'],
  ['decomposed accents', 'café á̂b'],
  ['Devanagari conjunct', 'xक्षy'],
  ['Devanagari vowel sign', 'xकितy'],
  ['conjunct with vowel sign', 'xस्त्रीy'],
  ['long Indic conjunct', `x${'क्'.repeat(60)}काy`],
  ['Tamil', 'xக்ஷy'],
  ['Hangul jamo', 'x각y'],
  ['Thai', 'xกำy'],
  ['family across the window', `${'a'.repeat(60)}\u{1F468}‍\u{1F469}‍\u{1F467}b`],
  ['flags across the window', `${'b'.repeat(62)}${'\u{1F1E7}\u{1F1F7}'.repeat(3)}c`],
  ['accents across the window', `${'c'.repeat(63)}é́d`],
  ['conjunct across the window', `${'d'.repeat(62)}क्ष्रe`],
];
await withChrome(async ({ send, evaluate: run }) => {
  await send('Page.navigate', { url: 'data:text/html,<textarea id=t cols=400 rows=3 style="white-space:pre;width:6000px"></textarea>' });
  // The page is loaded once its textarea is there.
  while ((await run("document.getElementById('t') !== null")) !== true);
  const KEYS = { ArrowRight: 39, ArrowLeft: 37, Backspace: 8, Delete: 46 };
  const press = async key => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: KEYS[key], nativeVirtualKeyCode: KEYS[key] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: KEYS[key], nativeVirtualKeyCode: KEYS[key] });
  };
  const set = (text, at) => run(`(() => { const t = document.getElementById('t'); t.focus(); t.value = ${JSON.stringify(text)}; t.setSelectionRange(${at}, ${at}); return t.selectionStart; })()`);
  const state = () => run(`(() => { const t = document.getElementById('t'); return [t.value, t.selectionStart, t.selectionEnd]; })()`);
  const out = [];
  for (const [name, text] of cases) {
    const right = [0];
    await set(text, 0);
    for (let k = 0; k <= text.length; k++) { await press('ArrowRight'); const [, at] = await state(); if (at === right[right.length - 1]) break; right.push(at); }
    const left = [text.length];
    await set(text, text.length);
    for (let k = 0; k <= text.length; k++) { await press('ArrowLeft'); const [, at] = await state(); if (at === left[left.length - 1]) break; left.push(at); }
    const backspace = [];
    const del = [];
    for (const at of right) {
      if (at > 0) { await set(text, at); await press('Backspace'); const [value, caret] = await state(); backspace.push([at, caret, text.length - value.length]); }
      if (at < text.length) { await set(text, at); await press('Delete'); const [value, caret] = await state(); del.push([at, caret, text.length - value.length]); }
    }
    out.push({ name, text, right, left, backspace, delete: del });
  }
  const version = (await send('Browser.getVersion')).result.product;
  writeFileSync(process.argv[2], JSON.stringify({ recorded: version, cases: out }, null, 1) + '\n');
  console.log('recorded', out.length, 'cases with', version);
});
