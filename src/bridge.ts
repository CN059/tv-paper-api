#!/usr/bin/env bun
/**
 * Local HTTP gateway: quant app -> TradingView Desktop paper trading.
 *
 *   bun run src/bridge.ts                 # :8787
 *   BRIDGE_TOKEN=secret bun run src/bridge.ts
 *   BRIDGE_PORT=9000 TVCDP_PORT=9334 bun run src/bridge.ts
 *
 * Binds 127.0.0.1 only. Every request runs inside the TradingView renderer, so the
 * session cookie and User-Agent are the desktop client's own.
 */
import { findChartTarget } from './cdp.ts';
import { accounts, accountSnapshot, cancelOrder, closePosition, placeOrder, reversePosition } from './driver.ts';
import type { OrderInput, Segment } from './types.ts';

const PORT = Number(process.env.BRIDGE_PORT ?? 8787);
const CDP_PORT = Number(process.env.TVCDP_PORT ?? 9333);
const TOKEN = process.env.BRIDGE_TOKEN ?? '';
const driver = { port: CDP_PORT, timeoutMs: Number(process.env.BRIDGE_TIMEOUT_MS ?? 15_000) };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 1), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

/** `ok: false` from a command means the order was rejected upstream, not that we crashed. */
const relay = (result: { ok: boolean }) => json(result.ok ? 200 : 502, result);

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// HTTP bodies are untyped input: coerce numbers/strings loosely, let the driver
// reject implausible values with a precise message.
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const numeric = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};
const segmentOf = (value: string | null): Segment | undefined =>
  value === 'pro' || value === 'free' ? value : undefined;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);

    if (TOKEN && request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
      return json(401, { ok: false, error: 'unauthorized' });
    }

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        const target = await findChartTarget(CDP_PORT);
        return json(200, { ok: target !== null, tvTarget: target?.url ?? null, cdpPort: CDP_PORT });
      }

      if (request.method === 'GET' && url.pathname === '/accounts') {
        return relay(await accounts(driver, segmentOf(url.searchParams.get('segment'))));
      }

      if (request.method === 'GET' && url.pathname === '/positions') {
        return relay(await accountSnapshot(driver, url.searchParams.get('account') ?? undefined));
      }

      if (request.method !== 'POST') return json(404, { ok: false, error: 'not found' });

      const body = await readJson(request);
      const account = text(body.account) ?? numeric(body.account);

      switch (url.pathname) {
        case '/order': {
          const order: OrderInput = {
            symbol: text(body.symbol) ?? '',
            side: text(body.side) as OrderInput['side'],
            qty: numeric(body.qty) ?? Number.NaN,
            type: text(body.type) as OrderInput['type'],
            price: numeric(body.price),
            sl: numeric(body.sl),
            tp: numeric(body.tp),
            expiration: numeric(body.expiration),
            outsideRth: body.outsideRth === true,
            account,
          };
          return relay(await placeOrder(driver, order));
        }
        case '/close':
          return relay(await closePosition(driver, { symbol: text(body.symbol) ?? '', qty: numeric(body.qty), account }));
        case '/reverse':
          return relay(await reversePosition(driver, { symbol: text(body.symbol) ?? '', account }));
        case '/cancel':
          return relay(await cancelOrder(driver, { id: numeric(body.id) ?? Number.NaN, account }));
        default:
          return json(404, { ok: false, error: 'not found' });
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      // Anything the driver phrased as a contract violation is the caller's fault.
      const status = /required|must be|positive number|JSON object|unknown segment/.test(message) ? 400 : 500;
      return json(status, { ok: false, error: message });
    }
  },
});

console.log(
  `tv-paper-api bridge on http://127.0.0.1:${server.port}  (CDP 127.0.0.1:${CDP_PORT}, token ${TOKEN ? 'required' : 'off'})`,
);
