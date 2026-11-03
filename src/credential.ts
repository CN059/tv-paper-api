/**
 * Credential envelopes.
 *
 * A capture tool runs on the user's machine, where the session cookie lives.
 * The deployment that consumes it runs elsewhere. Credentials therefore travel
 * as a **sealed box**: the capturing side needs only the consumer's public key,
 * so it can encrypt but never decrypt, and nothing in transit or at rest is
 * readable without the private key.
 *
 * Construction (WebCrypto only, no dependencies):
 *   X25519 ECDH -> HKDF-SHA256 (fixed salt, domain-separated info) -> AES-256-GCM
 *
 * The envelope carries the consumer's public-key fingerprint so a wrong key fails
 * with a clear message instead of an opaque GCM authentication error.
 */
const AES_ALG = 'AES-GCM';
const IV_BYTES = 12;
const TAG_BITS = 128;
/** Fixed salt is safe here: each envelope uses a fresh ephemeral key pair. */
const SALT = new Uint8Array(16);
const INFO = new TextEncoder().encode('tv-paper-api/credential/v1');
const KEY_BITS = 256;

/** What a consumer needs in order to act for the user. */
export interface Credential {
  /** Full `Cookie` header value, e.g. `sessionid=...`. */
  cookie: string;
  /** Selects the paper-trading host. Defaults to `pro`. */
  segment?: 'pro' | 'free';
  /** Account used when the caller does not name one. */
  account?: string;
  /** Free-form label (username, plan, ...). Never a password. */
  note?: string;
}

export interface KeyPair {
  /** base64, 32 bytes. Safe to publish: the capture tool needs it. */
  publicKey: string;
  /** base64 PKCS#8. Stays on the consuming host. */
  privateKey: string;
}

export interface Envelope {
  v: 1;
  /** base64 X25519 public key of the capturing side (ephemeral). */
  epk: string;
  /** base64 AES-GCM nonce. */
  nonce: string;
  /** base64 ciphertext with the GCM tag appended. */
  ct: string;
  /** base64 SHA-256 of the consumer's public key. */
  rpk: string;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => {
  const buf = Buffer.from(text, 'base64');
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};

const importPublicKey = (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', fromBase64(base64), { name: 'X25519' } as EcKeyImportParams, true, []);

const importPrivateKey = (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'pkcs8',
    fromBase64(base64),
    { name: 'X25519' } as EcKeyImportParams,
    true,
    ['deriveBits'],
  );

/** NIST-style fingerprint of a public key: SHA-256 over its raw bytes. */
async function fingerprint(publicKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  return toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
}

async function deriveAesKey(privateKey: CryptoKey, peer: CryptoKey): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: 'X25519', public: peer } as EcdhKeyDeriveParams,
    privateKey,
    KEY_BITS,
  );
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO },
    ikm,
    { name: AES_ALG, length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Generate the pair the consuming host keeps. Publish only `publicKey`. */
export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' } as EcKeyGenParams, true, [
    'deriveBits',
  ])) as CryptoKeyPair;

  return {
    publicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: toBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
  };
}

/** Encrypt a credential so only the holder of `consumerPublicKey` can read it. */
export async function seal(credential: Credential, consumerPublicKey: string): Promise<Envelope> {
  const recipient = await importPublicKey(consumerPublicKey);
  const sender = (await crypto.subtle.generateKey({ name: 'X25519' } as EcKeyGenParams, true, [
    'deriveBits',
  ])) as CryptoKeyPair;

  const aes = await deriveAesKey(sender.privateKey, recipient);
  const nonce = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_ALG, iv: nonce, tagLength: TAG_BITS },
    aes,
    new TextEncoder().encode(JSON.stringify(credential)),
  );

  return {
    v: 1,
    epk: toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey))),
    nonce: toBase64(nonce),
    ct: toBase64(new Uint8Array(ciphertext)),
    rpk: await fingerprint(recipient),
  };
}

/** Decrypt an envelope with the consumer's own key pair. */
export async function open(envelope: Envelope, keys: KeyPair): Promise<Credential> {
  if (envelope.v !== 1) throw new Error(`unsupported envelope version: ${String(envelope.v)}`);

  const ownPublic = await importPublicKey(keys.publicKey);
  if ((await fingerprint(ownPublic)) !== envelope.rpk) {
    throw new Error('envelope was sealed for a different key pair');
  }

  const ownPrivate = await importPrivateKey(keys.privateKey);
  const sender = await importPublicKey(envelope.epk);
  const aes = await deriveAesKey(ownPrivate, sender);

  const plaintext = await crypto.subtle.decrypt(
    { name: AES_ALG, iv: fromBase64(envelope.nonce), tagLength: TAG_BITS },
    aes,
    fromBase64(envelope.ct),
  );

  const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (parsed === null || typeof parsed !== 'object' || !('cookie' in parsed)) {
    throw new Error('envelope payload is not a credential');
  }
  const cookie = parsed.cookie;
  if (typeof cookie !== 'string' || cookie.length === 0) {
    throw new Error('credential has no cookie');
  }
  const segment = 'segment' in parsed && (parsed.segment === 'pro' || parsed.segment === 'free')
    ? parsed.segment
    : undefined;
  const account = 'account' in parsed && typeof parsed.account === 'string' ? parsed.account : undefined;
  const note = 'note' in parsed && typeof parsed.note === 'string' ? parsed.note : undefined;

  return { cookie, segment, account, note };
}

/** Text form used for copy/paste between machines. */
export const encodeEnvelope = (envelope: Envelope): string =>
  `tvcred1.${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`;

export function decodeEnvelope(text: string): Envelope {
  const trimmed = text.trim();
  const payload = trimmed.startsWith('tvcred1.') ? trimmed.slice('tvcred1.'.length) : trimmed;
  const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || !('ct' in parsed) || !('v' in parsed)) {
    throw new Error('not a credential envelope');
  }
  return parsed as Envelope;
}
