#!/usr/bin/env bun
/**
 * Command line for the paper-trading endpoints.
 *
 *   bun run cli accounts
 *   bun run cli positions [--account=<id>]
 *   bun run cli place --symbol=NASDAQ:AAPL --side=buy --qty=1 [--type=limit --price=100]
 *   bun run cli close   --symbol=NASDAQ:AAPL [--qty=1]
 *   bun run cli reverse --symbol=NASDAQ:AAPL
 *   bun run cli cancel  --id=<orderId>
 *
 * Transport is picked from the environment:
 *   attached (default)  drives a running desktop app over CDP; --port / TVCDP_PORT
 *   headless            uses a captured session; TV_SESSIONID or --credfile=...
 *
 * Exit code 1 when the endpoint rejects the request, 2 when the invocation is wrong.
 */
import { decodeEnvelope, open } from './credential.ts';
import {
  accountSnapshot,
  accounts,
  cancelOrder,
  closePosition,
  placeOrder,
  reversePosition,
  runCommand,
  type DriverOptions,
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

async function resolveDriver(): Promise<DriverOptions> {
  const inline = flags.get('sessionid') ?? process.env.TV_SESSIONID;
  if (inline) {
    return {
      mode: 'headless',
      credential: {
        cookie: inline.includes('=') ? inline : `sessionid=${inline}`,
        segment: process.env.TV_SEGMENT === 'free' ? 'free' : 'pro',
        account: flags.get('account') ?? process.env.TV_ACCOUNT,
      },
    };
  }

  const credfile = flags.get('credfile') ?? process.env.TV_CREDFILE;
  if (credfile) {
    const publicKey = process.env.TV_CRED_PUBKEY ?? '';
    const privateKey = process.env.TV_CRED_PRIVKEY ?? '';
    if (!publicKey || !privateKey) {
      throw new Error('TV_CRED_PUBKEY and TV_CRED_PRIVKEY are required to unseal a credential file');
    }
    const credential = await open(decodeEnvelope(await Bun.file(credfile).text()), { publicKey, privateKey });
    return { mode: 'headless', credential };
  }

  return { mode: 'attached', port: Number(flags.get('port') ?? process.env.TVCDP_PORT ?? 9333) };
}

/** Print the result and mirror a rejected request into the exit code. */
const report = (result: { ok: boolean }) => {
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
};

const driver = await resolveDriver();
const account = flags.get('account');

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
