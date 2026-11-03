#!/usr/bin/env bun
/**
 * Command line for the paper-trading endpoints.
 *
 *   bun run src/tvctl.ts accounts
 *   bun run src/tvctl.ts account    [--account=<id>]
 *   bun run src/tvctl.ts positions  [--account=<id>]
 *   bun run src/tvctl.ts place      --symbol=NASDAQ:AAPL --side=buy --qty=1 [--type=market|limit|stop] [--price=] [--sl=] [--tp=] [--outsideRth=true]
 *   bun run src/tvctl.ts close      --symbol=NASDAQ:AAPL [--qty=1]
 *   bun run src/tvctl.ts reverse    --symbol=NASDAQ:AAPL
 *   bun run src/tvctl.ts cancel     --id=<orderId>
 *
 * --port=<n> or TVCDP_PORT overrides the debug port. Exit code 1 when the
 * endpoint rejects the request, 2 when the invocation is wrong.
 */
import {
  accountSnapshot,
  accounts,
  cancelOrder,
  closePosition,
  placeOrder,
  reversePosition,
  runCommand,
} from './driver.ts';
import type { OrderType, Side } from './types.ts';

const argv = process.argv.slice(2);
const command = argv[0] ?? '';

const flags = new Map<string, string>();
for (const arg of argv.slice(1)) {
  const [, key, value] = /^--([^=]+)=(.*)$/.exec(arg) ?? [];
  if (key !== undefined && value !== undefined) flags.set(key, value);
}

const numberFlag = (key: string): number | undefined => {
  const raw = flags.get(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number`);
  return n;
};

const driver = { port: Number(flags.get('port') ?? process.env.TVCDP_PORT ?? 9333) };
const account = flags.get('account');

/** Print the result and mirror a rejected request into the exit code. */
const report = (result: { ok: boolean }) => {
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
};

switch (command) {
  case 'accounts':
    report(await accounts(driver));
    break;

  case 'account':
    report(await runCommand(driver, { cmd: 'account', account }));
    break;

  case 'positions':
    report(await accountSnapshot(driver, account));
    break;

  case 'place':
    report(
      await placeOrder(driver, {
        symbol: flags.get('symbol') ?? '',
        side: (flags.get('side') ?? '') as Side,
        qty: Number(flags.get('qty')),
        type: (flags.get('type') ?? 'market') as OrderType,
        price: numberFlag('price'),
        sl: numberFlag('sl'),
        tp: numberFlag('tp'),
        expiration: numberFlag('expiration'),
        outsideRth: flags.get('outsideRth') === 'true',
        account,
      }),
    );
    break;

  case 'close':
    report(await closePosition(driver, { symbol: flags.get('symbol') ?? '', qty: numberFlag('qty'), account }));
    break;

  case 'reverse':
    report(await reversePosition(driver, { symbol: flags.get('symbol') ?? '', account }));
    break;

  case 'cancel':
    report(await cancelOrder(driver, { id: Number(flags.get('id')), account }));
    break;

  default:
    console.error('usage: tvctl <accounts|account|positions|place|close|reverse|cancel> [--flag=value]');
    process.exit(2);
}
