/**
 * Typed client for the tv-paper-api server.
 *
 * The console is served by that server, so requests go to a relative /api path.
 * A token, when the deployment requires one, is kept in localStorage and sent as
 * a bearer header.
 */
const TOKEN_KEY = 'tv-paper-api.token';

export interface ApiError {
  ok: false;
  error: string;
  status?: number;
  detail?: unknown;
}

export interface Account {
  accountId: string | number;
  default?: boolean;
  currency?: string;
  balance?: number;
  initialBalance?: number;
  hidden?: boolean;
  [key: string]: unknown;
}

export interface Position {
  symbol: string;
  /** Signed: positive is long, negative is short. */
  qty: number;
  price?: number | null;
  pl?: number | null;
  [key: string]: unknown;
}

export interface Order {
  id: number;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop';
  qty: number;
  price?: number;
  status: string;
  [key: string]: unknown;
}

export interface Snapshot {
  ok: true;
  accountId: string | number;
  balance: number | null;
  positions: Position[];
  orders: Order[];
}

export interface Health {
  ok: boolean;
  mode: 'headless' | 'attached';
  segment?: string;
  account?: string | null;
  tvTarget?: string | null;
  cdpPort?: number;
}

export const tokenStore = {
  get: (): string => localStorage.getItem(TOKEN_KEY) ?? '',
  set: (token: string): void => {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  },
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = tokenStore.get();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');

  const res = await fetch(`/api${path}`, { ...init, headers });
  const payload: unknown = await res.json().catch(() => ({ ok: false, error: 'invalid JSON from server' }));

  if (payload === null || typeof payload !== 'object' || !('ok' in payload)) {
    throw new Error('unexpected response shape');
  }
  const result = payload as { ok: boolean; error?: string; status?: number };
  if (!result.ok) {
    const error: ApiError = { ok: false, error: result.error ?? 'request failed', status: result.status };
    throw Object.assign(new Error(error.error), error);
  }
  return payload as T;
}

export const api = {
  health: () => call<Health>('/health'),

  accounts: () => call<{ ok: true; accounts: Account[] }>('/accounts'),

  snapshot: (account?: string) =>
    call<Snapshot>(`/positions${account ? `?account=${encodeURIComponent(account)}` : ''}`),

  order: (body: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: number;
    type?: 'market' | 'limit' | 'stop';
    price?: number;
    sl?: number;
    tp?: number;
    outsideRth?: boolean;
    account?: string;
  }) => call<{ ok: true; accountId: string; response: Order }>('/order', { method: 'POST', body: JSON.stringify(body) }),

  close: (body: { symbol: string; qty?: number; account?: string }) =>
    call<{ ok: true; response: Order }>('/close', { method: 'POST', body: JSON.stringify(body) }),

  reverse: (body: { symbol: string; account?: string }) =>
    call<{ ok: true; response: Order }>('/reverse', { method: 'POST', body: JSON.stringify(body) }),

  cancel: (body: { id: number; account?: string }) =>
    call<{ ok: true; response: Order }>('/cancel', { method: 'POST', body: JSON.stringify(body) }),
};
