// Records how Chrome moves the caret over a textarea's wrapped rows, the
// oracle test/rows.test.jsx checks a multi-line Edit against: for each case
// (a text in a field of a width and a number of lines, set pre-wrap in one
// font), the rows Chrome wraps it into, the width Chrome measures each
// character and cluster at, and for each run of keys (ArrowUp and
// ArrowDown, Home and End, Shift, Ctrl with ArrowLeft) the selection and
// the field's scrollTop after each key. Ctrl+ArrowLeft's word moves are
// also recorded from every caret, for a test that plays the platform.
// Run it under the machine-wide Chrome lock and commit what it writes:
//   flock "$HOME/.cache/chrome-bench.lock" node scripts/rows-oracle.mjs test/fixtures/rows.json
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withChrome } from './chrome.mjs';

const FONT = '"DejaVu Sans Mono", "Noto Sans Devanagari UI", "Noto Color Emoji", monospace';
const SIZE = 16;
const LINE = 20;
const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
const conjunct = 'क्ष';

/** A key and its modifiers: `+` Shift, `^` Ctrl. @param {string} spec */
const key = spec => ({ key: spec.replace(/^[+^]+/, ''), shift: spec.includes('+'), ctrl: spec.includes('^') });
/** Keys pressed from a caret, named: [anchor, caret] to start from, then the keys. @param {string} name @param {number} at @param {string[]} keys */
const run = (name, at, keys, anchor = at) => ({ name, from: [anchor, at], keys: keys.map(key) });
const down = n => Array(n).fill('ArrowDown');
const up = n => Array(n).fill('ArrowUp');

const cases = [
  {
    name: 'words wrapped at spaces, one broken mid-word',
    text: 'The quick brown fox jumps over the lazy dog and a supercalifragilisticexpialidocious word ends it here',
    width: 160,
    lines: 12,
    runs: [
      run('down through short rows and a word broken mid-word', 3, down(7)),
      run('up from inside the broken word', 60, up(5)),
      run('the goal x reset by Left and Right', 7, ['ArrowDown', 'ArrowLeft', 'ArrowLeft', 'ArrowRight', 'ArrowRight', 'ArrowDown']),
      run('Home and End by row, and with Shift', 22, ['Home', 'End', '+Home', 'End', '+End']),
      run('End at a mid-word break, then down and up', 52, ['End', 'Home', 'ArrowDown', 'End', 'ArrowUp', 'End']),
      run('Shift with down and up', 20, ['+ArrowDown', '+ArrowDown', '+ArrowUp', 'ArrowRight']),
      run('three Ctrl+ArrowLeft back to back', 98, ['^ArrowLeft', '^ArrowLeft', '^ArrowLeft']),
      run('the goal x reset by Left and Right back to the same caret', 44, ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowDown']),
      run('the goal x reset by typing', 13, ['ArrowDown', 'ArrowDown', 'x', 'ArrowUp']),
      run('Shift+End twice', 22, ['+End', '+End']),
      run('Shift+Down through soft wraps', 3, ['+ArrowDown', '+ArrowDown', '+ArrowDown', '+ArrowDown', '+ArrowDown']),
      run('End, then Shift+Down', 22, ['End', '+ArrowDown', '+ArrowDown']),
      run('down to a wrap, Shift+Right, down', 3, ['ArrowDown', 'ArrowDown', 'ArrowDown', '+ArrowRight', 'ArrowDown']),
      run('End twice, Home twice', 22, ['End', 'End', 'Home', 'Home']),
    ],
  },
  {
    name: 'a row with a conjunct and a row with a ZWJ family',
    text: `ab ${conjunct} cd ${conjunct}${conjunct}ef ghij klmn ${family}${family} xyz ${family} pq`,
    width: 96,
    lines: 12,
    runs: [
      run('down onto a conjunct and a family', 1, down(5)),
      run('End, then down from the row end', 0, ['End', 'ArrowDown', 'ArrowDown', 'ArrowDown']),
      run('down and back up over clusters', 6, down(4).concat(up(4))),
      run('Home and End over clusters', 4, ['Home', 'End', 'ArrowDown', 'End', 'ArrowDown', 'Home']),
    ],
  },
  {
    name: 'spaces hanging past the field at a wrap',
    text: 'abcdefgh      ijkl mnop',
    width: 96,
    lines: 12,
    runs: [run('End on the hanging spaces, then down and up', 0, ['End', 'ArrowDown', 'ArrowUp']), run('down and up across the hanging spaces', 3, ['ArrowDown', 'ArrowUp', 'End', 'Home'])],
  },
  {
    name: 'a row ending exactly at the field\'s width',
    text: 'abcdefghi jklmnopqr stu',
    width: 96,
    lines: 12,
    runs: [run('End at the full row, then down', 0, ['End', 'ArrowDown', 'ArrowDown'])],
  },
  {
    name: 'a paragraph starting with a space',
    text: ' supercalifragilisticexpialidocious and more',
    width: 96,
    lines: 12,
    runs: [run('down from the leading space', 0, down(5)), run('End and down from the second row', 3, ['End', 'ArrowDown', 'Home'])],
  },
  {
    name: 'leading and repeated spaces',
    text: '   indented words   between   them aaaa   bbbb',
    width: 96,
    lines: 12,
    runs: [run('down through repeated spaces', 1, down(4))],
  },
  {
    name: 'more rows than lines: the caret row scrolled into view',
    text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen',
    width: 96,
    lines: 3,
    runs: [run('down and up, scrolling', 1, down(9).concat(up(9))), run('End, down, Home and up, scrolling', 0, ['End', ...down(6), 'Home', ...up(3)])],
  },
];

await withChrome(async ({ send, evaluate, profile }) => {
  await send('Page.navigate', { url: 'data:text/html,<!doctype html><body></body>' });
  // The page is loaded once its body is there.
  while ((await evaluate('document.body !== null')) !== true);

  const CODES = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35 };
  /** @param {{ key: string, shift: boolean, ctrl: boolean }} k */
  const press = async k => {
    // A character typed.
    if (k.key.length === 1) {
      const typed = { key: k.key, code: `Key${k.key.toUpperCase()}`, windowsVirtualKeyCode: k.key.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: k.key.toUpperCase().charCodeAt(0) };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: k.key, ...typed });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...typed });
      return;
    }
    const common = { key: k.key, code: k.key, windowsVirtualKeyCode: CODES[k.key], nativeVirtualKeyCode: CODES[k.key], modifiers: (k.shift ? 8 : 0) | (k.ctrl ? 2 : 0) };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  };
  /** The field and a hidden copy of it that the rows are read from. */
  const field = (text, width, lines) =>
    evaluate(`(() => {
      const css = 'font-family:' + ${JSON.stringify(FONT)} + ';font-size:${SIZE}px;line-height:${LINE}px;font-kerning:none;font-variant-ligatures:none;letter-spacing:0;word-spacing:0;padding:0;margin:0;border:0;outline:0;width:${width}px;white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;box-sizing:content-box;tab-size:8;';
      document.body.innerHTML = '';
      const t = document.createElement('textarea');
      t.id = 't';
      t.setAttribute('style', css + 'height:${lines * LINE}px;overflow:hidden;resize:none;display:block;');
      const m = document.createElement('div');
      m.setAttribute('style', css + 'position:absolute;left:0;top:1000px;visibility:hidden;');
      document.body.append(t, m);
      t.value = m.textContent = ${JSON.stringify(text)};
      t.focus();
      const node = m.firstChild;
      const top = m.getBoundingClientRect().top;
      const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(m.textContent)];
      const starts = [0];
      let row = 0;
      for (const g of graphemes) {
        const r = document.createRange();
        r.setStart(node, g.index);
        r.setEnd(node, g.index + g.segment.length);
        const at = Math.round((r.getClientRects()[0].top - top) / ${LINE});
        if (at > row) { starts.push(g.index); row = at; }
      }
      const context = document.createElement('canvas').getContext('2d');
      context.font = '${SIZE}px ' + ${JSON.stringify(FONT)};
      context.fontKerning = 'none';
      // Each cluster as the field lays it out (a conjunct shaped, an emoji in its font); a code point alone as the canvas measures it.
      const widths = {};
      for (const g of graphemes) {
        for (const c of g.segment) widths[c] = context.measureText(c).width;
        const r = document.createRange();
        r.setStart(node, g.index);
        r.setEnd(node, g.index + g.segment.length);
        widths[g.segment] = r.getBoundingClientRect().width;
      }
      // The primary font's box, which the caret spans and the field scrolls to show.
      const box = context.measureText('x');
      return { starts, widths, ascent: box.fontBoundingBoxAscent, descent: box.fontBoundingBoxDescent };
    })()`);
  const select = (anchor, caret) => evaluate(`(() => { const t = document.getElementById('t'); t.focus(); t.scrollTop = 0; t.setSelectionRange(${Math.min(anchor, caret)}, ${Math.max(anchor, caret)}, ${anchor > caret ? "'backward'" : "'forward'"}); })()`);
  const state = () => evaluate(`(() => { const t = document.getElementById('t'); const back = t.selectionDirection === 'backward'; return [back ? t.selectionEnd : t.selectionStart, back ? t.selectionStart : t.selectionEnd, t.scrollTop]; })()`);

  const out = [];
  for (const c of cases) {
    const { starts, widths, ascent, descent } = await field(c.text, c.width, c.lines);
    const runs = [];
    for (const r of c.runs) {
      // Each run on the text as it was (a run may type).
      await field(c.text, c.width, c.lines);
      await select(r.from[0], r.from[1]);
      const after = [];
      for (const k of r.keys) {
        await press(k);
        after.push(await state());
      }
      runs.push({ name: r.name, from: r.from, keys: r.keys, after });
    }
    // Ctrl+ArrowLeft from every caret: the platform's word move, for a test that plays it.
    const wordLeft = {};
    const bounds = new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(c.text)].map(g => g.index + g.segment.length));
    await field(c.text, c.width, c.lines);
    for (const at of bounds) {
      await select(at, at);
      await press({ key: 'ArrowLeft', shift: false, ctrl: true });
      wordLeft[at] = (await state())[1];
    }
    out.push({ name: c.name, text: c.text, width: c.width, lines: c.lines, size: SIZE, line: LINE, ascent, descent, starts, widths, runs, wordLeft });
  }
  // A field scrolled to its end, then shortened while it has no focus: where its rows scroll to.
  const long = cases[cases.length - 1];
  await field(long.text, long.width, long.lines);
  await select(0, 0);
  for (let k = 0; k < 12; k++) await press(key('ArrowDown'));
  const scrolled = (await state())[2];
  const shrunk = await evaluate(`(() => { const t = document.getElementById('t'); t.blur(); t.value = 'x'; return t.scrollTop; })()`);
  const emptied = await evaluate(`(() => { const t = document.getElementById('t'); t.value = ''; return t.scrollTop; })()`);
  // A paste and an IME composition in the first case's field, on a file: page (a secure context, so the
  // clipboard can be written): each event the textarea hears, with its value and selection then.
  const page = join(profile, 'page.html');
  writeFileSync(page, '<!doctype html><body></body>');
  await send('Page.navigate', { url: `file://${page}` });
  while ((await evaluate('document.body !== null && location.protocol === "file:"')) !== true);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const first = cases[0];
  /** Events heard from `from` while `act` runs. @param {[number, number]} from @param {() => Promise<void>} act */
  const heard = async (from, act) => {
    await field(first.text, first.width, first.lines);
    await select(from[0], from[1]);
    await evaluate(`(() => { const t = document.getElementById('t'); window.heard = [];
      for (const type of ['keydown', 'paste', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend'])
        t.addEventListener(type, e => window.heard.push({ type, inputType: e.inputType ?? null, data: e.data ?? null, composing: e.isComposing ?? null, value: t.value, start: t.selectionStart, end: t.selectionEnd })); })()`);
    await act();
    return evaluate('window.heard');
  };
  const paste = await heard([4, 10], async () => {
    await evaluate(`navigator.clipboard.writeText('fast ')`);
    const v = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...v, commands: ['paste'] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...v });
  });
  const composition = await heard([4, 4], async () => {
    await send('Input.imeSetComposition', { text: '\u306b', selectionStart: 1, selectionEnd: 1 });
    await send('Input.imeSetComposition', { text: '\u306b\u307b', selectionStart: 2, selectionEnd: 2 });
    await send('Input.insertText', { text: '\u65e5\u672c' });
  });
  const native = { case: first.name, paste: { from: [4, 10], events: paste }, composition: { from: [4, 4], events: composition } };
  const version = (await send('Browser.getVersion')).result.product;
  writeFileSync(process.argv[2], JSON.stringify({ recorded: version, font: FONT, cases: out, shrink: { name: long.name, scrolled, shrunk, emptied }, native }, null, 1) + '\n');
  console.log('recorded', out.length, 'cases with', version);
});
