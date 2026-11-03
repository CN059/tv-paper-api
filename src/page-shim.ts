/**
 * The paper-trading wire protocol, as one self-contained function.
 *
 * Two ways in, one implementation:
 *
 * 1. **Attached to a live desktop app** - stringified with
 *    `Function.prototype.toString()` and evaluated inside the TradingView
 *    renderer, where the `sessionid` cookie is already present.
 * 2. **Headless** - imported and called directly from Bun with a captured
 *    cookie, so no browser needs to be running at all.
 *
 * That is why the body must stay self-contained: no runtime imports, no
 * module-scope references. Bun erases the types before stringification, so the
 * annotations below cost nothing in the injected form.
 *
 * Endpoint map, order body and error codes were reverse-engineered from the
 * desktop bundle (module 202391, `paperFetch`).
 */
import type { PageRequest, PageResponse } from './types.ts';

/** Public paper-trading hosts, from `window.initData.settings.TRADING_URLS`. */
export const PAPER_HOSTS = {
  pro: 'https://papertrading.tradingview.com',
  free: 'https://papertrading-free.tradingview.com',
} as const;

/**
 * The desktop client's User-Agent. A captured session was issued to this client,
 * so headless calls present the same identity.
 */
export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'TradingView/3.5.0 Chrome/146.0.0.0 Safari/537.36 TVDesktop/3.5.0';

/** Where to send the call; omitted means "use the page's own origin and cookies". */
export interface Shunt {
  base: string;
  cookie: string;
  userAgent: string;
}

export async function paperShim(
  args: PageRequest,
  shunt?: Shunt,
): Promise<PageResponse> {
  const host = typeof window === 'undefined' ? undefined : (window as unknown as {
    initData?: { settings?: { TRADING_URLS?: Record<string, string> } };
  });

  const base = shunt?.base ?? host?.initData?.settings?.TRADING_URLS?.[args.segment ?? 'pro'];
  if (!base) return { ok: false, error: 'TRADING_URLS missing (page not ready?)' };

  const call = async (path: string, body?: unknown, method?: string): Promise<unknown> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
    if (shunt) {
      // Headless: the browser is not there to add these, and the edge 403s without them.
      headers.Origin = 'https://www.tradingview.com';
      headers.Referer = 'https://www.tradingview.com/chart/';
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers['User-Agent'] = shunt.userAgent;
      if (shunt.cookie) headers.Cookie = shunt.cookie;
    }

    const res = await fetch(`${base}/${path}`, {
      method: method ?? 'POST',
      headers,
      ...(shunt ? {} : { credentials: 'include' as RequestCredentials }),
      body: JSON.stringify(body ?? {}),
    });

    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error pages stay raw and are surfaced verbatim.
    }

    if (!res.ok) {
      throw Object.assign(new Error(`paper request failed: ${path} (HTTP ${res.status})`), {
        status: res.status,
        payload,
      });
    }
    return payload;
  };

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
    const preferred = usable.find(
      (a) => a !== null && typeof a === 'object' && 'default' in a && a.default === true,
    );
    const chosen = preferred ?? usable[0];
    if (chosen === undefined || chosen === null || typeof chosen !== 'object' || !('accountId' in chosen)) {
      throw new Error('no paper account on this login');
    }
    return String(chosen.accountId);
  };

  try {
    switch (args.cmd) {
      case 'accounts':
        return { ok: true, segment: args.segment ?? 'pro', accounts: accountsOf(await call('trading/accounts')) };

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
