#!/usr/bin/env bun
/**
 * tv-paper-api server: one port serving both the JSON API and the web console.
 *
 *   bun run start                              # attached: drives the desktop app over CDP
 *   TV_SESSIONID=... bun run start             # headless: no browser needed
 *   TV_CREDFILE=./cred.enc bun run start       # headless: unseal a captured credential
 *
 * Routes:
 *   /api/*   JSON API (see README)
 *   /*       the built web console from web/dist, with SPA fallback to index.html
 *
 * Binds 127.0.0.1 by default. Behind a token is mandatory before exposing it:
 * this port can place trades.
 */
import { join, resolve, sep } from 'node:path';
import { findChartTarget } from './cdp.ts';
import { decodeEnvelope, open, type Credential } from './credential.ts';
import {
  accountSnapshot,
  accounts,
  cancelOrder,
  closePosition,
  placeOrder,
  reversePosition,
  type DriverOptions,
} from './driver.ts';
import type { OrderInput, Segment } from './types.ts';

const PORT = Number(process.env.PORT ?? process.env.BRIDGE_PORT ?? 8787);
const HOST = process.env.HOST ?? process.env.BRIDGE_HOST ?? '127.0.0.1';
const CDP_PORT = Number(process.env.TVCDP_PORT ?? 9333);
const TOKEN = process.env.BRIDGE_TOKEN ?? '';
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS ?? 15_000);
// Resolved once, absolutely: a relative WEB_ROOT would fail the containment
// check below and silently 404 every asset.
const WEB_ROOT = resolve(process.env.WEB_ROOT ?? join(import.meta.dir, '..', 'web', 'dist'));

/** How the credential reached us: inline env var or a sealed file. */
async function resolveCredential(): Promise<Credential | null> {
  const inline = process.env.TV_SESSIONID;
  if (inline) {
    return {
      cookie: inline.includes('=') ? inline : `sessionid=${inline}`,
      segment: process.env.TV_SEGMENT === 'free' ? 'free' : 'pro',
      account: process.env.TV_ACCOUNT,
    };
  }

  const file = process.env.TV_CREDFILE ?? flagValue('credfile');
  if (!file) return null;

  const keys = {
    publicKey: process.env.TV_CRED_PUBKEY ?? '',
    privateKey: process.env.TV_CRED_PRIVKEY ?? '',
  };
  if (!keys.publicKey || !keys.privateKey) {
    throw new Error('TV_CRED_PUBKEY and TV_CRED_PRIVKEY are required to unseal a credential file');
  }
  return open(decodeEnvelope(await Bun.file(file).text()), keys);
}

function flagValue(name: string): string | undefined {
  const [, value] = new RegExp(`^--${name}=(.+)$`).exec(process.argv.slice(2).join(' ')) ?? [];
  return value;
}

const credential = await resolveCredential();
const driver: DriverOptions = credential
  ? { mode: 'headless', credential }
  : { mode: 'attached', port: CDP_PORT, timeoutMs: TIMEOUT_MS };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 1), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** `ok: false` from a command means upstream rejected it, not that we crashed. */
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

// HTTP bodies are untyped input: coerce loosely, then let the driver reject
// implausible values with a precise message.
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const numeric = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};
const segmentOf = (value: string | null): Segment | undefined =>
  value === 'pro' || value === 'free' ? value : undefined;

/** Serve a file from the built console, falling back to index.html for SPA routes. */
async function serveStatic(pathname: string): Promise<Response> {
  const relative = pathname.replace(/^\/+/, '');
  const candidate = resolve(WEB_ROOT, relative);

  // Never serve outside WEB_ROOT, whatever the request claims. Compare with a
  // trailing separator so a sibling directory such as `dist-secret` cannot match.
  if (candidate !== WEB_ROOT && !candidate.startsWith(WEB_ROOT + sep)) {
    return new Response('Not found', { status: 404 });
  }

  const file = Bun.file(candidate);
  if (relative !== '' && (await file.exists())) {
    return new Response(file);
  }

  const index = Bun.file(join(WEB_ROOT, 'index.html'));
  if (await index.exists()) {
    return new Response(index, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  return new Response(
    'Web console not built. Run: bun run build:web\n',
    { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return serveStatic(url.pathname);
    }

    if (TOKEN && request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
      return json(401, { ok: false, error: 'unauthorized' });
    }

    const route = url.pathname.slice('/api'.length);

    try {
      if (request.method === 'GET' && route === '/health') {
        if (driver.mode === 'headless') {
          return json(200, {
            ok: true,
            mode: 'headless',
            segment: driver.credential.segment ?? 'pro',
            account: driver.credential.account ?? null,
          });
        }
        const target = await findChartTarget(driver.port);
        return json(200, {
          ok: target !== null,
          mode: 'attached',
          tvTarget: target?.url ?? null,
          cdpPort: driver.port,
        });
      }

      if (request.method === 'GET' && route === '/accounts') {
        return relay(await accounts(driver, segmentOf(url.searchParams.get('segment'))));
      }

      if (request.method === 'GET' && route === '/positions') {
        return relay(await accountSnapshot(driver, url.searchParams.get('account') ?? undefined));
      }

      if (request.method !== 'POST') return json(404, { ok: false, error: 'not found' });

      const body = await readJson(request);
      const account = text(body.account) ?? numeric(body.account);

      switch (route) {
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
      // Contract violations are the caller's fault; an unreachable driver is upstream's.
      const status = /required|must be|positive number|JSON object|unknown segment/.test(message)
        ? 400
        : /no TradingView chart page|timed out|socket error/.test(message)
          ? 502
          : 500;
      return json(status, { ok: false, error: message });
    }
  },
});

console.log(
  `tv-paper-api on http://${HOST}:${server.port}  ` +
    `(mode ${driver.mode}${driver.mode === 'attached' ? `, CDP ${driver.port}` : ''}, ` +
    `token ${TOKEN ? 'required' : 'off'})`,
);
