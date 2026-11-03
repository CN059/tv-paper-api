/**
 * Server routing tests: one port must serve both the JSON API and the console.
 *
 * Spawns the real server against a stub driver via an inline credential, so no
 * TradingView and no network are involved.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8891;
const BASE = `http://127.0.0.1:${PORT}`;

let child: ReturnType<typeof Bun.spawn> | null = null;
let webRoot = '';

/**
 * A fixture console rather than the real build: routing is what this file tests,
 * and depending on `web/dist` would make the suite fail whenever the console has
 * not been built (as it is in the CI server job, which builds nothing).
 */
async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tv-web-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><div id="root"></div><script src="/assets/app.js"></script>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("fixture")');
  return root;
}

beforeAll(async () => {
  webRoot = await makeFixture();
  // A malformed cookie is fine: these tests never reach upstream, they check routing.
  // process.execPath is this Bun binary; spawning 'bun' relies on PATH working,
  // which it does not on every Windows shell.
  child = Bun.spawn([process.execPath, 'src/server.ts'], {
    // fileURLToPath, not .pathname: on Windows the latter yields /C:/... which is invalid.
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(PORT), TV_SESSIONID: 'sessionid=routing-test', WEB_ROOT: webRoot },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(300) });
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error('server did not start');
});

afterAll(async () => {
  child?.kill();
  if (webRoot) await rm(webRoot, { recursive: true, force: true });
});

describe('single-port routing', () => {
  test('serves the console at / as HTML', async () => {
    const res = await fetch(`${BASE}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('id="root"');
  });

  test('falls back to index.html for SPA routes', async () => {
    const res = await fetch(`${BASE}/dashboard`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('serves hashed assets as JavaScript', async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
    expect(asset).toBeDefined();

    const res = await fetch(`${BASE}${asset}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  test('answers /api/health with the active mode', async () => {
    const body = await (await fetch(`${BASE}/api/health`)).json();

    expect(body.ok).toBe(true);
    expect(body.mode).toBe('headless');
  });

  test('does not expose the API without the /api prefix', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('rejects unknown API routes with 404 and JSON', async () => {
    const res = await fetch(`${BASE}/api/nope`);

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('refuses path traversal', async () => {
    const res = await fetch(`${BASE}/../package.json`);
    // Bun normalises the URL, so either a 404 or the SPA shell is acceptable -
    // what matters is that no file outside web/dist is served.
    const body = await res.text();
    expect(body).not.toContain('"name": "tv-paper-api"');
  });
});
