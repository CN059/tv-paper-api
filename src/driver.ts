/**
 * Command orchestration: validation, then dispatch to whichever transport the
 * deployment uses.
 *
 * Two transports, same commands:
 *   - **attached** - evaluate the shim inside a running desktop app over CDP,
 *     so the app's own session is used and no credential is ever handled;
 *   - **headless**  - call the service directly with a captured cookie, which
 *     needs no browser, no desktop app and no GUI (servers, containers, CI).
 */
import { evaluate } from './cdp.ts';
import { paperShim } from './page-shim.ts';
import type { Credential } from './credential.ts';
import { DESKTOP_USER_AGENT, PAPER_HOSTS } from './page-shim.ts';
import type { OrderInput, PageRequest, PageResponse, Segment } from './types.ts';

export interface AttachedOptions {
  mode: 'attached';
  /** CDP port the desktop client was started with. */
  port: number;
  timeoutMs?: number;
}

export interface HeadlessOptions {
  mode: 'headless';
  credential: Credential;
}

export type DriverOptions = AttachedOptions | HeadlessOptions;

const SHIM_SOURCE = paperShim.toString();

/** Symbol as the desktop client sends it: `EXCHANGE:TICKER`. */
function validateSymbol(symbol: unknown): string {
  if (typeof symbol !== 'string' || symbol.trim() === '') throw new Error('symbol is required');
  if (symbol.includes(' ')) throw new Error(`symbol must not contain spaces: ${symbol}`);
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

/** Run one command. Rejections come back as `ok: false`, not as thrown errors. */
export async function runCommand(
  options: DriverOptions,
  request: PageRequest,
  segment?: Segment,
): Promise<PageResponse> {
  if (options.mode === 'headless') {
    const chosen = segment ?? options.credential.segment ?? 'pro';
    return paperShim({ ...request, segment: chosen }, {
      base: PAPER_HOSTS[chosen],
      cookie: options.credential.cookie,
      userAgent: DESKTOP_USER_AGENT,
    });
  }

  // Attached: the renderer resolves its own host and credentials, so no shunt is passed.
  const expression = `(${SHIM_SOURCE})(${JSON.stringify({ ...request, segment })})`;
  return evaluate<PageResponse>({ port: options.port, timeoutMs: options.timeoutMs }, expression);
}

export async function accounts(options: DriverOptions, segment?: Segment) {
  return runCommand(options, { cmd: 'accounts' }, segment);
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
  const account = accountId(input.account ?? defaultAccount(options));
  if (account !== undefined) request.account = account;

  return runCommand(options, request);
}

export async function closePosition(
  options: DriverOptions,
  input: { symbol: string; qty?: number; account?: string | number },
) {
  const request: PageRequest = { cmd: 'close', symbol: validateSymbol(input.symbol) };
  if (input.qty !== undefined) request.qty = validateQty(input.qty);
  const account = accountId(input.account ?? defaultAccount(options));
  if (account !== undefined) request.account = account;
  return runCommand(options, request);
}

export async function reversePosition(
  options: DriverOptions,
  input: { symbol: string; account?: string | number },
) {
  const request: PageRequest = { cmd: 'reverse', symbol: validateSymbol(input.symbol) };
  const account = accountId(input.account ?? defaultAccount(options));
  if (account !== undefined) request.account = account;
  return runCommand(options, request);
}

export async function cancelOrder(
  options: DriverOptions,
  input: { id: number; account?: string | number },
) {
  const id = Number(input.id);
  if (!Number.isFinite(id)) throw new Error('id must be a number');
  const request: PageRequest = { cmd: 'cancel', id };
  const account = accountId(input.account ?? defaultAccount(options));
  if (account !== undefined) request.account = account;
  return runCommand(options, request);
}

/** A captured credential can pin the account, avoiding a lookup on every order. */
function defaultAccount(options: DriverOptions): string | undefined {
  return options.mode === 'headless' ? options.credential.account : undefined;
}

/**
 * Coerce an account id to its wire form.
 *
 * `String(undefined)` would produce the literal "undefined" and turn into
 * `trading/place/undefined` on the wire, so absence is preserved explicitly and
 * the shim falls back to resolving the default account itself.
 */
function accountId(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}
