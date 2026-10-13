// Numbers that are no finite length, through every numeric prop and
// portable style field, on a Document that draws: NaN, ±Infinity, 1e39
// (past what Taffy's f32 boxes hold) and a 40-digit percent. Every frame
// must end, and every number of its commands must be finite (a NaN box
// once kept the painter's damage loop going forever). The cases run in a
// worker thread (fixtures/nonfinite.js), laid out there or through a layout
// served on a port (the worker-layout path), that tells each one before it runs
// it, so one that hangs (5 s of wall clock; a `{ timeout }` cannot stop a
// synchronous loop) is ended from here, reported, and the rest run in a
// new thread.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

/** How long one case may run before its thread is ended as hung. */
const HANG = 5000;

/**
 * Runs the cases from `from` in a thread: what broke, and where it stopped.
 * @param {import('node:test').TestContext} t @param {number} from @param {boolean} remote laid out through a served layout
 * @returns {Promise<{ failures: string[], hung: number | null, count: number }>}
 */
function runFrom(t, from, remote) {
  /** @type {string[]} */
  const failures = [];
  const worker = new Worker(new URL('./fixtures/nonfinite.js', import.meta.url), { workerData: { from, remote } });
  /** @type {{ close: (() => any) | null }} */
  const slot = { close: () => worker.terminate() };
  t.after(() => {
    const close = slot.close;
    slot.close = null;
    return close?.();
  });
  /** @type {{ index: number, name: string } | null} */
  let last = null;
  let at = performance.now();
  return new Promise((resolve, reject) => {
    // timer: deadline, ends the thread when one case has run too long (a frame that loops).
    const guard = setInterval(() => {
      if (performance.now() - at < HANG) return;
      clearInterval(guard);
      void worker.terminate();
      failures.push(`${last?.name}: no end after ${HANG} ms`);
      resolve({ failures, hung: last?.index ?? from, count: 0 });
    }, 100);
    worker.on('message', m => {
      if (m.done) {
        clearInterval(guard);
        resolve({ failures, hung: null, count: m.count });
        return;
      }
      if (m.failures !== undefined) {
        failures.push(...m.failures);
        return;
      }
      last = m;
      at = performance.now();
    });
    worker.on('error', error => {
      clearInterval(guard);
      reject(error);
    });
  });
}

describe('numbers that are no finite length', () => {
  for (const remote of [false, true])
    it(`end every frame and draw only finite numbers, through every numeric prop and style field, laid out ${remote ? 'through a served layout' : 'in the thread'}`, { timeout: 300000 }, async t => {
      /** @type {string[]} */
      const failures = [];
      let from = 0;
      let count = 0;
      for (;;) {
        const result = await runFrom(t, from, remote);
        failures.push(...result.failures);
        if (result.hung === null) {
          count = result.count;
          break;
        }
        from = result.hung + 1;
      }
      if (failures.length > 0) console.log(failures.join('\n'));
      assert.ok(count > 200, `only ${count} cases ran`);
      assert.deepEqual(failures.map(f => f.slice(0, 200)), [], 'cases that hung, threw or drew a number that is not finite');
    });
});
