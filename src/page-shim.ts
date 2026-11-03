/**
 * The page-side request layer.
 *
 * This function is serialised with `Function.prototype.toString()` and evaluated
 * inside the TradingView renderer, so it MUST be self-contained: no imports at
 * runtime, no references to module scope. Type annotations are erased by Bun
 * before stringification, so they cost nothing when injected.
 *
 * It reproduces the request the desktop client makes itself (bundle module 202391,
 * `paperFetch`):
 *
 *   URL  = new URL(`${TRADING_URLS[segment]}/${path}`, location.origin)
 *   init = { method, credentials: 'include',
 *            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
 *            body: JSON.stringify(body) }
 *
 * The `sessionid` cookie is the only credential. Do not add an auth header: the
 * endpoint's CORS preflight only allows `X-UseNewAuth`, so any extra custom header
 * fails before the request is sent.
 *
 * Responses are relayed, not re-modelled: the account list and snapshots go back
 * exactly as the server sent them, because that is the endpoint's real contract.
 */
import type { PageRequest, PageResponse } from './types.ts';

export async function pageShim(args: PageRequest): Promise<PageResponse> {
  const host = window as unknown as {
    initData?: { settings?: { TRADING_URLS?: Record<string, string> } };
  };

  const urls = host.initData?.settings?.TRADING_URLS;
  if (!urls) return { ok: false, error: 'TRADING_URLS missing (page not ready?)' };

  const segment = args.segment ?? 'pro';
  const base = urls[segment] ?? urls.pro;
  if (!base) return { ok: false, error: `unknown segment: ${segment}` };

  const call = async (path: string, body?: unknown, method?: string): Promise<unknown> => {
    const res = await fetch(new URL(`${base}/${path}`, location.origin), {
      method: method ?? 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error pages stay as raw text; the caller surfaces them verbatim.
    }
    if (!res.ok) {
      throw Object.assign(new Error(`paper request failed: ${path} (HTTP ${res.status})`), {
        status: res.status,
        payload,
      });
    }
    return payload;
  };

  /** Server sends an array; some builds wrap it in `{ accounts: [...] }`. */
  const accountsOf = (res: unknown): unknown[] => {
    if (Array.isArray(res)) return res;
    if (res !== null && typeof res === 'object' && 'accounts' in res && Array.isArray(res.accounts)) {
      return res.accounts;
    }
    return [];
  };

  const pickAccount = async (): Promise<string> => {
    if (args.account) return args.account;
    const list = accountsOf(await call('trading/accounts'));
    const usable = list.filter(
      (a) => a !== null && typeof a === 'object' && !('hidden' in a && a.hidden === true),
    );
    const preferred = usable.find((a) => a !== null && typeof a === 'object' && 'default' in a && a.default === true);
    const chosen = preferred ?? usable[0];
    if (chosen === undefined || chosen === null || typeof chosen !== 'object' || !('accountId' in chosen)) {
      throw new Error('no paper account on this login');
    }
    return String(chosen.accountId);
  };

  try {
    switch (args.cmd) {
      case 'accounts':
        return { ok: true, segment, accounts: accountsOf(await call('trading/accounts')) };

      case 'account': {
        const id = await pickAccount();
        return { ok: true, accountId: id, data: await call(`trading/account/${id}`) };
      }

      case 'positions': {
        const id = await pickAccount();
        const data = await call(`trading/account/${id}`);
        if (data === null || typeof data !== 'object') return { ok: false, error: 'malformed account snapshot' };
        return {
          ok: true,
          accountId: id,
          balance: 'balance' in data ? data.balance : null,
          positions: 'positions' in data && Array.isArray(data.positions) ? data.positions : [],
          orders: 'orders' in data && Array.isArray(data.orders) ? data.orders : [],
        };
      }

      case 'place': {
        const id = await pickAccount();
        const type = args.type ?? 'market';
        const body: Record<string, unknown> = {
          symbol: args.symbol,
          type,
          qty: Number(args.qty),
          side: args.side,
        };
        if (type !== 'market' && args.price !== undefined) body.price = Number(args.price);
        if (args.sl !== undefined) body.sl = Number(args.sl);
        if (args.tp !== undefined) body.tp = Number(args.tp);
        if (args.expiration !== undefined) body.expiration = Number(args.expiration);
        if (args.outsideRth === true) body.outside_rth = true;
        return { ok: true, accountId: id, request: body, response: await call(`trading/place/${id}`, body) };
      }

      case 'close': {
        const id = await pickAccount();
        const body: Record<string, unknown> = { symbol: args.symbol };
        if (args.qty !== undefined) body.qty = Number(args.qty);
        return {
          ok: true,
          accountId: id,
          request: body,
          response: await call(`trading/close_position/${id}`, body),
        };
      }

      case 'reverse': {
        const id = await pickAccount();
        const body = { symbol: args.symbol };
        return { ok: true, accountId: id, request: body, response: await call(`trading/reverse/${id}`, body) };
      }

      case 'cancel': {
        const id = await pickAccount();
        const body = { id: Number(args.id) };
        return { ok: true, accountId: id, request: body, response: await call(`trading/cancel/${id}`, body) };
      }

      default:
        return { ok: false, error: `unknown cmd: ${String(args.cmd)}` };
    }
  } catch (e: unknown) {
    const err = e as { message?: string; status?: number; payload?: unknown };
    return { ok: false, error: err?.message ?? String(e), status: err?.status, detail: err?.payload };
  }
}

/** URL fragment every driver uses to recognise a drivable chart page. */
export const CHART_URL_MATCH = 'tradingview.com/chart';
