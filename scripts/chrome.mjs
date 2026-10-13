// A headless Chrome for the recording scripts (editing-oracle.mjs,
// rows-oracle.mjs): one page and a DevTools session on it. Chrome and its
// profile go however the recording ends: done, failed, thrown, interrupted
// (SIGINT, SIGTERM) or past its deadline (a hung page or socket), so no run
// leaves a Chrome or a profile behind.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * @typedef {object} Session
 * @property {(method: string, params?: object) => Promise<any>} send a DevTools call
 * @property {(expression: string) => Promise<any>} evaluate an expression's value in the page (a throw there throws here)
 * @property {string} profile Chrome's profile folder, removed with it: a place for a page file (a file: page is a secure context, with the clipboard)
 */

/**
 * Runs `record` with a headless Chrome's page, then stops Chrome and removes
 * its profile; the process exits 1 when the recording fails or runs past
 * `deadline` ms, 0 when it is done.
 * @param {(session: Session) => Promise<void>} record
 * @param {{ deadline?: number }} [options]
 */
export async function withChrome(record, { deadline = 10 * 60 * 1000 } = {}) {
  // A short profile path: Chrome's singleton socket must fit a Unix socket path.
  const profile = mkdtempSync(join(tmpdir(), 'o-'));
  // Its own process group: Chrome and every process it starts go together.
  const browser = spawn('google-chrome', ['--headless=new', '--disable-dev-shm-usage', '--no-first-run', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  /** @type {WebSocket | null} */
  let socket = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      socket?.close();
    } catch {}
    try {
      if (browser.pid !== undefined) process.kill(-browser.pid, 'SIGKILL');
    } catch {}
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  /** Ends the process after cleaning up. @param {number} code @param {unknown} [why] */
  const end = (code, why) => {
    if (why !== undefined) console.error(why);
    cleanup();
    process.exit(code);
  };
  const interrupted = () => end(130, 'interrupted');
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  process.once('uncaughtException', error => end(1, error));
  process.once('unhandledRejection', error => end(1, error));
  // timer: deadline, ends a recording whose page or socket hangs.
  const timer = setTimeout(() => end(1, `the recording ran past ${deadline} ms`), deadline);
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let log = '';
      browser.on('exit', code => reject(new Error(`Chrome exited (${code}): ${log.slice(-600)}`)));
      browser.stderr.on('data', chunk => {
        log += chunk;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
        if (m) resolve(m[1]);
      });
    });
    const http = String(endpoint).replace(/^ws:\/\/([^/]+)\/.*$/, 'http://$1');
    const target = (await (await fetch(`${http}/json/list`)).json()).find((/** @type {any} */ t) => t.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    socket = ws;
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let id = 0;
    /** @type {Map<number, (message: any) => void>} */
    const calls = new Map();
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data));
      if (m.id && calls.has(m.id)) {
        /** @type {(message: any) => void} */ (calls.get(m.id))(m);
        calls.delete(m.id);
      }
    };
    /** @param {string} method @param {object} [params] @returns {Promise<any>} */
    const send = (method, params = {}) =>
      new Promise(resolve => {
        calls.set(++id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    /** @param {string} expression */
    const evaluate = async expression => {
      const answer = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (answer.result.exceptionDetails) throw new Error(JSON.stringify(answer.result.exceptionDetails));
      return answer.result.result.value;
    };
    await record({ send, evaluate, profile });
  } catch (error) {
    clearTimeout(timer);
    end(1, error);
  } finally {
    clearTimeout(timer);
    cleanup();
  }
  process.exit(0);
}
