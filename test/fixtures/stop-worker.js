// A worker for test/worker.test.jsx: a layout served, asked, then stopped
// before any layout engine is set (a thread of its own has none yet).
import { parentPort } from 'node:worker_threads';
import { serveLayout, useLayout } from 'ren-canv/worker';

/** @type {((event: any) => void) | null} */
let listener = null;
/** @type {any[]} */
const posted = [];
const port = {
  addEventListener: (/** @type {string} */ _, /** @type {(event: any) => void} */ f) => void (listener = f),
  removeEventListener: () => void (listener = null),
  postMessage: (/** @type {any} */ data) => void posted.push(data),
};
const stop = serveLayout(/** @type {any} */ (port));
/** @type {any} */ (listener)({ data: [1, 7, new Int32Array(8), 0, null, { root: 0, overlay: 0, width: 10, height: 10, bar: 0, gutter: false, fit: false }, null] });
stop();
let made = 0;
/** @type {string | null} */
let error = null;
try {
  useLayout(() => {
    made++;
    throw new Error('a layout tree was built after the stop');
  });
} catch (e) {
  error = /** @type {Error} */ (e).message;
}
/** @type {any} */ (parentPort).postMessage({ made, posted: posted.length, error });
