/**
 * End-to-end test: drives a real TradingView renderer and asserts the exact wire
 * request each command produces.
 *
 * The page's `window.fetch` is replaced with a recorder that answers canned
 * paper-trading payloads, so the shim, account resolution, body serialisation and
 * the bridge are exercised for real while the server's auth and fills are
 * simulated. Nothing here places a real order.
 *
 * Requires TradingView running with a debug port; skips otherwise:
 *   bun test
 *   TVCDP_PORT=9334 bun test
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { evaluate, findChartTarget } from '../src/cdp.ts';
import { runCommand, type DriverOptions } from '../src/driver.ts';
import { CHART_URL_MATCH } from '../src/page-shim.ts';

const CDP_PORT = Number(process.env.TVCDP_PORT ?? 9333);
const driver: DriverOptions = { mode: 'attached', port: CDP_PORT };
const available = (await findChartTarget(CDP_PORT)) !== null;

interface RecordedCall {
  url: string;
  host: string;
  path: string;
  method: string;
  credentials?: string;
  headers: Record<string, string>;
  body: string | null;
}

const RECORDER = `
(() => {
  if (window.__recorder) return false;
  const respond = (path, body) => {
    if (typeof body === 'string' && body.includes('__HTTP_500__')) {
      return { status: 500, payload: { error: 'boom' } };
    }
    if (path === 'trading/accounts') {
      return { status: 200, payload: [
        { accountId: 'paper-1', default: true, currency: 'USD', initialBalance: 100000, hidden: false },
      ] };
    }
    if (/^trading\\/account\\//.test(path)) {
      return { status: 200, payload: {
        balance: 99800.5,
        positions: [{ symbol: 'NASDAQ:AAPL', qty: 1, price: 180.2, pl: 12.5 }],
        orders: [{ id: 42, symbol: 'NASDAQ:AAPL', type: 'limit', side: 'buy', qty: 2, price: 175 }],
      } };
    }
    if (/^trading\\/place\\//.test(path)) {
      return { status: 200, payload: { id: 7, symbol: 'NASDAQ:AAPL', qty: 1, side: 'buy', type: 'market' } };
    }
    if (/^trading\\/(close_position|reverse|cancel)\\//.test(path)) {
      return { status: 200, payload: { id: 9 } };
    }
    return { status: 404, payload: { error: 'unmocked ' + path } };
  };
  window.__recorder = { calls: [] };
  const real = window.fetch;
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : (input.href ?? input.url ?? String(input));
    const url = new URL(raw, location.href);
    const path = url.pathname.replace(/^\\/+/, '');
    const headers = {};
    new Headers(init.headers || {}).forEach((value, key) => { headers[key] = value; });
    window.__recorder.calls.push({
      url: url.href, host: url.host, path, method: init.method || 'GET',
      credentials: init.credentials, headers, body: init.body ?? null,
    });
    const { status, payload } = respond(path, init.body);
    return new Response(JSON.stringify(payload), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  };
  window.__recorder.restore = () => { window.fetch = real; delete window.__recorder; };
  return true;
})()
`;

const inPage = <T>(expression: string) => evaluate<T>(driver, expression);
const readCalls = () => inPage<RecordedCall[]>('window.__recorder.calls');
const clearCalls = () => inPage<number>('window.__recorder.calls.length = 0');

/** Parsed JSON body of the first recorded call whose path starts with `prefix`. */
async function bodyOf(prefix: string): Promise<Record<string, unknown>> {
  const call = (await readCalls()).find((c) => c.path.startsWith(prefix));
  const parsed: unknown = JSON.parse(call?.body ?? '{}');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

async function pathOf(prefix: string): Promise<string | undefined> {
  return (await readCalls()).find((c) => c.path.startsWith(prefix))?.path;
}

// The recorder must be installed before any describe block runs, because each
// block reads the same page state.
beforeAll(async () => {
  if (!available) return;
  expect(await inPage<boolean>(RECORDER)).toBe(true);
  await clearCalls();
});

afterAll(async () => {
  if (!available) return;
  await inPage('window.__recorder && window.__recorder.restore()');
});

describe.skipIf(!available)('paper trading over CDP', () => {
  test('accounts: reads the list from the pro papertrading host', async () => {
    await clearCalls();
    const result = await runCommand(driver, { cmd: 'accounts' });

    expect(result.ok).toBe(true);
    expect(result.accounts).toHaveLength(1);

    const [call] = await readCalls();
    expect(call?.method).toBe('POST');
    expect(call?.host).toBe('papertrading.tradingview.com');
    expect(call?.body).toBe('{}');
    expect(call?.credentials).toBe('include');
    expect(call?.headers['content-type']).toContain('application/x-www-form-urlencoded');
  });

  test('accounts: sends no auth header, because the cookie is the credential', async () => {
    await clearCalls();
    await runCommand(driver, { cmd: 'accounts' });

    const [call] = await readCalls();
    expect(Object.keys(call?.headers ?? {}).filter((h) => h.startsWith('x-'))).toEqual([]);
  });

  test('place: resolves the default account and matches the app serializer', async () => {
    await clearCalls();
    const result = await runCommand(driver, {
      cmd: 'place',
      symbol: 'NASDAQ:AAPL',
      side: 'buy',
      qty: 1,
      type: 'market',
    });

    expect(result.ok).toBe(true);
    expect(await pathOf('trading/place/')).toBe('trading/place/paper-1');
    expect(await bodyOf('trading/place/')).toEqual({
      symbol: 'NASDAQ:AAPL',
      type: 'market',
      qty: 1,
      side: 'buy',
    });
  });

  test('place: limit order carries numeric price and brackets', async () => {
    await clearCalls();
    await runCommand(driver, {
      cmd: 'place',
      symbol: 'BTCUSD',
      side: 'sell',
      qty: 0.5,
      type: 'limit',
      price: 60000,
      sl: 61000,
      tp: 58000,
    });

    expect(await bodyOf('trading/place/')).toMatchObject({
      price: 60000,
      sl: 61000,
      tp: 58000,
      side: 'sell',
      type: 'limit',
    });
  });

  test('place: outsideRth maps to the wire field outside_rth', async () => {
    await clearCalls();
    await runCommand(driver, {
      cmd: 'place',
      symbol: 'NASDAQ:AAPL',
      side: 'buy',
      qty: 1,
      outsideRth: true,
    });

    expect((await bodyOf('trading/place/')).outside_rth).toBe(true);
  });

  test('close: omits qty when not supplied', async () => {
    await clearCalls();
    await runCommand(driver, { cmd: 'close', symbol: 'NASDAQ:AAPL' });

    const call = (await readCalls()).find((c) => c.path.startsWith('trading/close_position/'));
    expect(call?.body).toBe('{"symbol":"NASDAQ:AAPL"}');
  });

  test('close: includes qty when supplied', async () => {
    await clearCalls();
    await runCommand(driver, { cmd: 'close', symbol: 'NASDAQ:AAPL', qty: 1 });

    const call = (await readCalls()).find((c) => c.path.startsWith('trading/close_position/'));
    expect(call?.body).toBe('{"symbol":"NASDAQ:AAPL","qty":1}');
  });

  test('reverse: sends only the symbol', async () => {
    await clearCalls();
    await runCommand(driver, { cmd: 'reverse', symbol: 'NASDAQ:AAPL' });

    const call = (await readCalls()).find((c) => c.path.startsWith('trading/reverse/'));
    expect(call?.body).toBe('{"symbol":"NASDAQ:AAPL"}');
  });

  test('cancel: sends the numeric order id', async () => {
    await clearCalls();
    await runCommand(driver, { cmd: 'cancel', id: 42 });

    const call = (await readCalls()).find((c) => c.path.startsWith('trading/cancel/'));
    expect(call?.body).toBe('{"id":42}');
  });

  test('positions: returns positions and orders from the snapshot', async () => {
    const result = await runCommand(driver, { cmd: 'positions' });

    expect(result.ok).toBe(true);
    expect(result.positions).toHaveLength(1);
    expect(result.orders).toHaveLength(1);
  });

  test('server errors surface as ok:false with the status', async () => {
    const result = await runCommand(driver, {
      cmd: 'close',
      symbol: '__HTTP_500__',
      account: 'paper-1',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });
});

describe.skipIf(!available)('explicit account selection', () => {
  test('a supplied account id bypasses the accounts lookup', async () => {
    await clearCalls();
    const result = await runCommand(driver, {
      cmd: 'place',
      symbol: 'NASDAQ:AAPL',
      side: 'buy',
      qty: 1,
      account: 'custom-9',
    });

    expect(await pathOf('trading/place/')).toBe('trading/place/custom-9');
    expect(result.accountId).toBe('custom-9');
  });
});

test.skipIf(!available)('the chart target is reachable', async () => {
  const target = await findChartTarget(CDP_PORT);
  expect(target?.url).toContain(CHART_URL_MATCH);
});
