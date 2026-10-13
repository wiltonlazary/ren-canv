// Records how Chrome moves the focus when a focus handler acts, the oracle
// test/action.test.jsx checks a Document against: for each case, A is
// focused in a wrapper with B and C, then B.focus() runs while one handler
// (`on` an event, heard `by` A, B, C or the wrapper `outer`) does `act`:
// focuses or blurs a button, disables it or removes it; `chain` is a
// second such step the first leads to, and `post` an act after B.focus()
// returns. Recorded: the log of blur, focus, focusout and focusin with
// their targets and the focused button when B.focus() returns, then what
// is heard after (`later`: Chrome blurs a disabled button at its next
// frame) and the focused one then (`after`).
// Run it under the machine-wide Chrome lock and commit what it writes:
//   flock "$HOME/.cache/chrome-bench.lock" node scripts/focus-oracle.mjs test/fixtures/focus.json
import { writeFileSync } from 'node:fs';
import { withChrome } from './chrome.mjs';

/** Each case: the handler that acts (`on` an event, `by` whom) and what it does (`act`: `focus:C`, `blur:A`, `disable:B`, `remove:B`). */
const cases = [
  { name: 'plain', on: null, by: null, act: null },
  { name: 'A blur focuses C', on: 'blur', by: 'A', act: 'focus:C' },
  { name: 'wrapper focusout focuses C', on: 'focusout', by: 'outer', act: 'focus:C' },
  { name: 'A blur focuses A again', on: 'blur', by: 'A', act: 'focus:A' },
  { name: 'B focus focuses C', on: 'focus', by: 'B', act: 'focus:C' },
  { name: 'wrapper focusin focuses C', on: 'focusin', by: 'outer', act: 'focus:C' },
  { name: 'B focus focuses A', on: 'focus', by: 'B', act: 'focus:A' },
  { name: 'wrapper focusout focuses B', on: 'focusout', by: 'outer', act: 'focus:B' },
  { name: 'A blur blurs A', on: 'blur', by: 'A', act: 'blur:A' },
  { name: 'B focus blurs B', on: 'focus', by: 'B', act: 'blur:B' },
  { name: 'A blur disables B', on: 'blur', by: 'A', act: 'disable:B' },
  { name: 'wrapper focusout disables B', on: 'focusout', by: 'outer', act: 'disable:B' },
  { name: 'A blur removes B', on: 'blur', by: 'A', act: 'remove:B' },
  { name: 'A blur removes A', on: 'blur', by: 'A', act: 'remove:A' },
  { name: 'wrapper focusout removes B', on: 'focusout', by: 'outer', act: 'remove:B' },
  { name: 'B focus removes B', on: 'focus', by: 'B', act: 'remove:B' },
  { name: 'B focus disables B', on: 'focus', by: 'B', act: 'disable:B' },
  { name: 'A blur focuses C, C focus focuses B', on: 'blur', by: 'A', act: 'focus:C', chain: { on: 'focus', by: 'C', act: 'focus:B' } },
  { name: 'B removed after', on: null, by: null, act: null, post: 'remove:B' },
  { name: 'B disabled after', on: null, by: null, act: null, post: 'disable:B' },
];

const page = `<div id=host></div><script>
const n = t => (t ? t.id : 'null');
const focused = () => (document.activeElement === document.body ? null : document.activeElement.id);
window.run = c => {
  host.innerHTML = '<div id=outer><button id=A>A</button><button id=B>B</button><button id=C>C</button></div>';
  const log = [];
  let steps = [];
  const act = what => {
    const [verb, id] = what.split(':');
    const el = document.getElementById(id);
    if (verb === 'focus') el.focus();
    if (verb === 'blur') el.blur();
    if (verb === 'disable') el.disabled = true;
    if (verb === 'remove') el.remove();
  };
  for (const id of ['A', 'B', 'C', 'outer'])
    for (const type of id === 'outer' ? ['focusin', 'focusout'] : ['focus', 'blur'])
      document.getElementById(id).addEventListener(type, e => {
        log.push(id + ' ' + type + ' ' + n(e.target) + ' ' + n(e.relatedTarget));
        const step = steps[0];
        if (step !== undefined && step.on === type && step.by === id) {
          steps.shift();
          act(step.act);
        }
      });
  document.getElementById('A').focus();
  log.length = 0;
  steps = c.on === null ? [] : [c, ...(c.chain ? [c.chain] : [])];
  document.getElementById('B').focus();
  if (c.post) act(c.post);
  const sync = log.length;
  const now = focused();
  // What Chrome does by its next frame (blurs a disabled button, in a rendering update): two frames on.
  return new Promise(resolve =>
    // timer: feature, the next frame's rendering update is what is recorded.
    requestAnimationFrame(() =>
      // timer: feature, and the one after it, by when that update is done.
      requestAnimationFrame(() => {
        steps = [];
        const out = { log: log.slice(0, sync), focused: now, later: log.slice(sync), after: focused() };
        if (document.activeElement !== document.body) document.activeElement.blur();
        resolve(out);
      }),
    ),
  );
};
</script>`;

await withChrome(async ({ send, evaluate }) => {
  await send('Page.navigate', { url: `data:text/html,${encodeURIComponent(page)}` });
  // The page is loaded once its script has run.
  while ((await evaluate("typeof window.run === 'function'")) !== true);
  // A headless page has the focus only once it is told it does.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const out = [];
  for (const c of cases) out.push({ ...c, ...(await evaluate(`window.run(${JSON.stringify(c)})`)) });
  const version = (await send('Browser.getVersion')).result.product;
  writeFileSync(process.argv[2], JSON.stringify({ recorded: version, cases: out }, null, 1) + '\n');
  console.log('recorded', out.length, 'cases with', version);
});
