// loadLayout after a failed load (bad bytes, a missing file): the failure is not kept, a second call
// loads. Its own file, since a process loads Taffy once.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadLayout } from 'ren-canv';

describe('loadLayout', () => {
  it('loads on a second call after the first load failed', async () => {
    let bad;
    assert.doesNotThrow(() => (bad = loadLayout(new Uint8Array([1, 2, 3]))), 'bad bytes reject, not throw');
    await assert.rejects(bad);
    await assert.rejects(loadLayout(new URL('file:///nowhere/taffy_wasm_bg.wasm')));
    const bytes = readFileSync(fileURLToPath(new URL('taffy_wasm_bg.wasm', import.meta.resolve('taffy-layout/wasm'))));
    await loadLayout(new Response(bytes, { headers: { 'content-type': 'application/wasm' } }));
  });
});
