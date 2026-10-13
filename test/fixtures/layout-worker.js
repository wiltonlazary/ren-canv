// A layout worker for test/worker.test.jsx: Taffy served on the parent port.
import { parentPort } from 'node:worker_threads';
import { serveLayout, loadLayout } from 'ren-canv/worker';

serveLayout(/** @type {any} */ (parentPort));
loadLayout();
