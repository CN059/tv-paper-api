/**
 * Ties the page shim to the CDP transport and validates every command before it
 * reaches the renderer, so a bad request fails here with a clear message instead
 * of as an opaque 400 from TradingView.
 */
import { evaluate } from './cdp.ts';
import { pageShim } from './page-shim.ts';
import type { OrderInput, PageRequest, PageResponse } from './types.ts';

export interface DriverOptions {
  /** CDP port the desktop client was started with. */
  port: number;
  timeoutMs?: number;
}

const PAGE_CALL = pageShim.toString();

/** Symbol as the desktop client sends it: `EXCHANGE:TICKER`. */
function validateSymbol(symbol: unknown): string {
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    throw new Error('symbol is required');
  }
  if (symbol.includes(' ')) {
    throw new Error(`symbol must not contain spaces: ${symbol}`);
  }
  return symbol.trim();
}

function validateQty(qty: unknown): number {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) throw new Error('qty must be a positive number');
  return n;
}

function validatePrice(price: unknown, field: string): number {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} must be a positive number`);
  return n;
}

function validateSide(side: unknown): 'buy' | 'sell' {
  if (side !== 'buy' && side !== 'sell') throw new Error("side must be 'buy' or 'sell'");
  return side;
}

/** Runs one command inside the renderer. Never throws for a rejected order. */
export async function runCommand(
  options: DriverOptions,
  request: PageRequest,
): Promise<PageResponse> {
  const expression = `(${PAGE_CALL})(${JSON.stringify(request)})`;
  return evaluate<PageResponse>(options, expression);
}

export async function accounts(options: DriverOptions, segment?: 'pro' | 'free') {
  return runCommand(options, { cmd: 'accounts', segment });
}

export async function accountSnapshot(options: DriverOptions, account?: string) {
  return runCommand(options, { cmd: 'positions', account });
}

export async function placeOrder(options: DriverOptions, input: OrderInput) {
  const type = input.type ?? 'market';
  if (type !== 'market' && input.price === undefined) {
    throw new Error(`price is required for ${type} orders`);
  }
  const request: PageRequest = {
    cmd: 'place',
    symbol: validateSymbol(input.symbol),
    side: validateSide(input.side),
    qty: validateQty(input.qty),
    type,
  };
  if (input.price !== undefined) request.price = validatePrice(input.price, 'price');
  if (input.sl !== undefined) request.sl = validatePrice(input.sl, 'sl');
  if (input.tp !== undefined) request.tp = validatePrice(input.tp, 'tp');
  if (input.expiration !== undefined) request.expiration = Number(input.expiration);
  if (input.outsideRth === true) request.outsideRth = true;
  if (input.account !== undefined) request.account = String(input.account);
  return runCommand(options, request);
}

export async function closePosition(
  options: DriverOptions,
  input: { symbol: string; qty?: number; account?: string | number },
) {
  const request: PageRequest = { cmd: 'close', symbol: validateSymbol(input.symbol) };
  if (input.qty !== undefined) request.qty = validateQty(input.qty);
  if (input.account !== undefined) request.account = String(input.account);
  return runCommand(options, request);
}

export async function reversePosition(
  options: DriverOptions,
  input: { symbol: string; account?: string | number },
) {
  const request: PageRequest = { cmd: 'reverse', symbol: validateSymbol(input.symbol) };
  if (input.account !== undefined) request.account = String(input.account);
  return runCommand(options, request);
}

export async function cancelOrder(
  options: DriverOptions,
  input: { id: number; account?: string | number },
) {
  const id = Number(input.id);
  if (!Number.isFinite(id)) throw new Error('id must be a number');
  const request: PageRequest = { cmd: 'cancel', id };
  if (input.account !== undefined) request.account = String(input.account);
  return runCommand(options, request);
}
