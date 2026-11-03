#!/usr/bin/env bun
/**
 * Capture the session cookie from a running TradingView desktop app and seal it
 * for a deployment elsewhere.
 *
 *   # 1. On the deployment host: mint a key pair, keep the private key there.
 *   bun run src/credctl.ts keygen
 *
 *   # 2. On the machine where TradingView is logged in:
 *   bun run src/credctl.ts capture --to=<publicKey> --account=<id>
 *   # -> prints a tvcred1.… string; nothing readable ever leaves this machine
 *
 *   # 3. On the deployment host: verify it unseals and works.
 *   bun run src/credctl.ts verify --credfile=./cred.enc
 *
 * The capturing side holds only a public key, so it can encrypt but not decrypt.
 * The credential is written 0600 and never printed in plaintext.
 */
import { chmod, writeFile } from 'node:fs/promises';
import { decodeEnvelope, encodeEnvelope, generateKeyPair, open, seal, type Credential } from './credential.ts';
import { accounts, type DriverOptions } from './driver.ts';

const argv = process.argv.slice(2);
const command = argv[0] ?? '';
const flags = new Map<string, string>();
for (const arg of argv.slice(1)) {
  const [, key, value] = /^--([^=]+)=(.*)$/.exec(arg) ?? [];
  if (key !== undefined && value !== undefined) flags.set(key, value);
}

const CDP_PORT = Number(flags.get('port') ?? process.env.TVCDP_PORT ?? 9333);
const OUT = flags.get('out') ?? './cred.enc';

/** Read the paper-relevant cookies out of the desktop app's browser context. */
async function captureCookies(port: number): Promise<Map<string, { value: string; expires: number }>> {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {
    throw new Error(`cannot reach the TradingView debug port on 127.0.0.1:${port} - is the app running with --remote-debugging-port?`);
  })).json();

  if (!Array.isArray(targets)) throw new Error('unexpected /json/list response');
  const page = targets.find(
    (t: unknown) =>
      t !== null && typeof t === 'object' && 'type' in t && t.type === 'page' &&
      'url' in t && typeof t.url === 'string' && t.url.includes('tradingview.com/chart'),
  );
  if (!page || !('webSocketDebuggerUrl' in page) || typeof page.webSocketDebuggerUrl !== 'string') {
    throw new Error('no TradingView chart page; open a chart in the desktop app first');
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => reject(new Error('timed out reading cookies')), 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
    socket.onmessage = (event: MessageEvent) => {
      const message: unknown = JSON.parse(String(event.data));
      if (message === null || typeof message !== 'object' || !('id' in message) || message.id !== 1) return;
      clearTimeout(timer);
      resolve(message);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP socket error while reading cookies'));
    };

    const reply = await promise;
    if (!reply || typeof reply !== 'object' || !('result' in reply)) throw new Error('empty cookie reply');
    const result = reply.result;
    if (!result || typeof result !== 'object' || !('cookies' in result) || !Array.isArray(result.cookies)) {
      throw new Error('unexpected cookie reply shape');
    }

    const jar = new Map<string, { value: string; expires: number }>();
    for (const raw of result.cookies) {
      if (raw === null || typeof raw !== 'object') continue;
      const { name, value, domain, expires } = raw as Record<string, unknown>;
      if (typeof name !== 'string' || typeof value !== 'string') continue;
      if (typeof domain !== 'string' || !domain.includes('tradingview')) continue;
      jar.set(name, { value, expires: typeof expires === 'number' ? expires : 0 });
    }
    return jar;
  } finally {
    socket.close();
  }
}

/** Build the minimal Cookie header: `sessionid` alone is sufficient. */
function cookieHeader(jar: Map<string, { value: string; expires: number }>): string {
  const sid = jar.get('sessionid');
  if (!sid || sid.value === '') {
    throw new Error('no sessionid cookie - log in to TradingView in the desktop app first');
  }
  return `sessionid=${sid.value}`;
}

switch (command) {
  case 'keygen': {
    const keys = await generateKeyPair();
    console.log(JSON.stringify(keys, null, 2));
    console.error(
      '\nKeep privateKey on the deployment host (TV_CRED_PRIVKEY).\n' +
        'Copy publicKey to the machine that captures credentials (--to=<publicKey>).',
    );
    break;
  }

  case 'capture': {
    const recipient = flags.get('to') ?? process.env.TV_CRED_PUBKEY;
    if (!recipient) throw new Error('--to=<publicKey> is required (run `credctl keygen` on the deployment host first)');

    const jar = await captureCookies(CDP_PORT);
    const sid = jar.get('sessionid');
    const note = flags.get('note');

    const credential: Credential = {
      cookie: cookieHeader(jar),
      segment: flags.get('segment') === 'free' ? 'free' : 'pro',
      account: flags.get('account'),
      note,
    };

    const envelope = await seal(credential, recipient);
    const text = encodeEnvelope(envelope);
    await writeFile(OUT, `${text}\n`, { mode: 0o600 });
    await chmod(OUT, 0o600);

    const expiry = sid && sid.expires > 0 ? new Date(sid.expires * 1000).toISOString() : 'unknown';
    console.error(`sealed credential written to ${OUT} (mode 600)`);
    console.error(`session expires: ${expiry}`);
    console.error(`envelope: ${text}`);
    break;
  }

  case 'verify': {
    const publicKey = process.env.TV_CRED_PUBKEY ?? '';
    const privateKey = process.env.TV_CRED_PRIVKEY ?? '';
    if (!publicKey || !privateKey) {
      throw new Error('TV_CRED_PUBKEY and TV_CRED_PRIVKEY must be set to unseal');
    }
    const source = flags.get('credfile') ?? process.env.TV_CREDFILE ?? OUT;
    const credential = await open(decodeEnvelope(await Bun.file(source).text()), { publicKey, privateKey });

    // Prove the session actually works rather than merely decrypting.
    const driver: DriverOptions = { mode: 'headless', credential };
    const result = await accounts(driver);
    if (!result.ok) {
      console.error(JSON.stringify(result, null, 2));
      throw new Error('credential unsealed but the session was rejected');
    }
    const list = Array.isArray(result.accounts) ? result.accounts : [];
    console.log(JSON.stringify({
      ok: true,
      segment: credential.segment ?? 'pro',
      accounts: list.length,
      hint: list[0] !== undefined ? 'account id available in the account list' : 'no accounts',
    }, null, 2));
    break;
  }

  default:
    console.error(
      'usage: credctl <keygen|capture|verify> [--to=<publicKey>] [--out=./cred.enc] [--account=<id>] [--port=<cdpPort>]',
    );
    process.exit(2);
}
