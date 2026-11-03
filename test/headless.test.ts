/**
 * Headless transport tests: no browser, no desktop app, no network.
 *
 * The global `fetch` is replaced with a recorder so the exact wire request for
 * each command is asserted, including the headers the edge requires. Nothing
 * here reaches TradingView.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Credential } from '../src/credential.ts';
import {
  accountSnapshot,
  accounts,
  cancelOrder,
  closePosition,
  placeOrder,
  type DriverOptions,
} from '../src/driver.ts';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

const calls: Recorded[] = [];
const realFetch = globalThis.fetch;

interface Reply {
  status?: number;
  payload?: unknown;
}

/** Route each recorded call to a canned reply; the default is an account list. */
let responder: (call: Recorded) => Reply = () => ({ status: 200, payload: [{ accountId: 'paper-1', default: true }] });

beforeEach(() => {
  calls.length = 0;
  responder = () => ({ status: 200, payload: [{ accountId: 'paper-1', default: true }] });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });

    const call: Recorded = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);

    const { status = 200, payload = {} } = responder(call);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const credential: Credential = { cookie: 'sessionid=secret', segment: 'pro', account: 'paper-1' };
const driver: DriverOptions = { mode: 'headless', credential };

describe('headless requests', () => {
  test('POSTs to the pro paper host over https', async () => {
    await accounts(driver);

    expect(calls[0]?.url).toBe('https://papertrading.tradingview.com/trading/accounts');
    expect(calls[0]?.method).toBe('POST');
  });

  test('sends the captured cookie', async () => {
    await accounts(driver);
    expect(calls[0]?.headers.cookie).toBe('sessionid=secret');
  });

  test('sends the Origin/Referer the edge requires', async () => {
    await accounts(driver);

    expect(calls[0]?.headers.origin).toBe('https://www.tradingview.com');
    expect(calls[0]?.headers.referer).toBe('https://www.tradingview.com/chart/');
  });

  test('presents the desktop User-Agent, matching the captured session', async () => {
    await accounts(driver);
    expect(calls[0]?.headers['user-agent']).toContain('TVDesktop');
  });

  test('sends no auth header: the cookie is the whole credential', async () => {
    await accounts(driver);
    const headers = calls[0]?.headers ?? {};

    // Verified against the live service: `sessionid` alone returns 200. Anything
    // extra (X-UserId et al.) either 401s or fails the CORS preflight, which only
    // allows X-UseNewAuth.
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-userid']).toBeUndefined();
    expect(Object.keys(headers).filter((h) => h.startsWith('x-'))).toEqual(['x-requested-with']);
  });

  test('uses the free host when the credential says so', async () => {
    const free: DriverOptions = { mode: 'headless', credential: { ...credential, segment: 'free' } };
    await accounts(free);
    expect(calls[0]?.url).toContain('papertrading-free.tradingview.com');
  });
});

describe('headless commands', () => {
  test('pins the credential account, avoiding an accounts lookup', async () => {
    await placeOrder(driver, { symbol: 'NASDAQ:AAPL', side: 'buy', qty: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://papertrading.tradingview.com/trading/place/paper-1');
  });

  test('resolves the default account when the credential has none', async () => {
    responder = (call) =>
      call.url.endsWith('trading/accounts')
        ? { status: 200, payload: [{ accountId: 'from-api', default: true }] }
        : { status: 200, payload: { id: 1 } };

    await placeOrder({ mode: 'headless', credential: { cookie: 'sessionid=secret' } }, {
      symbol: 'NASDAQ:AAPL',
      side: 'buy',
      qty: 1,
    });

    expect(calls.map((c) => c.url)).toEqual([
      'https://papertrading.tradingview.com/trading/accounts',
      'https://papertrading.tradingview.com/trading/place/from-api',
    ]);
  });

  test('never emits the literal "undefined" as an account', async () => {
    await accountSnapshot(driver, undefined);
    for (const call of calls) expect(call.url).not.toContain('undefined');
  });

  test('close omits qty when not supplied', async () => {
    responder = () => ({ status: 200, payload: { id: 1 } });

    await closePosition(driver, { symbol: 'NASDAQ:AAPL' });

    expect(calls[0]?.body).toBe('{"symbol":"NASDAQ:AAPL"}');
  });

  test('close includes qty when supplied', async () => {
    responder = () => ({ status: 200, payload: { id: 1 } });

    await closePosition(driver, { symbol: 'NASDAQ:AAPL', qty: 2 });

    expect(calls[0]?.body).toBe('{"symbol":"NASDAQ:AAPL","qty":2}');
  });

  test('cancel sends a numeric id', async () => {
    responder = (call) => (call.url.includes('cancel') ? { status: 200, payload: { id: 1 } } : {});
    await cancelOrder(driver, { id: 42 });
    expect(calls[0]?.body).toBe('{"id":42}');
  });
});

describe('headless error handling', () => {
  test('surfaces the server error body and status', async () => {
    responder = () => ({ status: 400, payload: { err_code: 'unspecified_bad_request', error: 'malformed request syntax' } });

    const result = await placeOrder(driver, { symbol: 'NASDAQ:AAPL', side: 'buy', qty: 1 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  test('reports a missing session instead of pretending success', async () => {
    responder = () => ({ status: 401, payload: { err_code: 'missed_x_userid_header' } });

    const result = await accounts({ mode: 'headless', credential: { cookie: '' } });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});
