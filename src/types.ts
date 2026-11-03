/**
 * Wire types for the paper-trading endpoints exposed by the TradingView desktop client.
 *
 * Field names are the server's, not ours. Anything echoed back from the API is
 * kept as `unknown` on purpose: we do not validate the response shape, we relay
 * it, so pretending we know it would be a lie in the type system.
 */

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type Segment = 'pro' | 'free';

/** One paper account, normalised from `trading/accounts`. */
export interface PaperAccount {
  accountId: string | number;
  default: boolean;
  currency: string;
  initialBalance: number;
  hidden: boolean;
  competitionId: string | null;
  externalKey: string | null;
}

export interface PlacementQty {
  symbol: string;
  side: Side;
  qty: number;
}

/** Input accepted by the HTTP bridge / CLI, before per-command validation. */
export interface OrderInput extends PlacementQty {
  type?: OrderType;
  price?: number;
  sl?: number;
  tp?: number;
  expiration?: number;
  outsideRth?: boolean;
  account?: string | number;
}

/** Everything the injected page shim needs for one call. */
export interface PageRequest {
  cmd: 'accounts' | 'account' | 'positions' | 'place' | 'close' | 'reverse' | 'cancel';
  account?: string;
  symbol?: string;
  side?: Side;
  qty?: number;
  type?: OrderType;
  price?: number;
  sl?: number;
  tp?: number;
  expiration?: number;
  outsideRth?: boolean;
  id?: number;
  segment?: Segment;
}

/** Result envelope; `detail` carries the server's own error body. */
export interface PageResponse {
  ok: boolean;
  error?: string;
  status?: number;
  detail?: unknown;
  [key: string]: unknown;
}
