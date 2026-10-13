// ren-canv/worker: what a layout worker imports: the service that lays out
// the pages of Documents on the main thread (`remoteLayout(port)` there),
// and the engine: Taffy (`loadLayout`), or another one (`useLayout`). No
// Document, text or painting.
//
//   // layout.js, a module worker
//   import { serveLayout, loadLayout } from 'ren-canv/worker';
//   serveLayout(self);
//   loadLayout(new URL('./taffy.wasm', import.meta.url));

export { serveLayout, useLayout } from './engine.js';
export { loadLayout } from './taffy.js';
