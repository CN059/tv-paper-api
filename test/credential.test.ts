/**
 * Credential envelope tests: sealing, unsealing, and the failure modes that must
 * never silently succeed.
 */
import { describe, expect, test } from 'bun:test';
import {
  decodeEnvelope,
  encodeEnvelope,
  generateKeyPair,
  open,
  seal,
  type KeyPair,
} from '../src/credential.ts';

const credential = { cookie: 'sessionid=abc123', segment: 'pro' as const, account: 'paper-1', note: 'test' };

const keys: KeyPair = await generateKeyPair();

describe('sealed credentials', () => {
  test('round-trips through seal and open', async () => {
    const envelope = await seal(credential, keys.publicKey);
    const restored = await open(envelope, keys);

    expect(restored.cookie).toBe(credential.cookie);
    expect(restored.segment).toBe('pro');
    expect(restored.account).toBe('paper-1');
    expect(restored.note).toBe('test');
  });

  test('ciphertext does not contain the plaintext', async () => {
    const envelope = await seal(credential, keys.publicKey);
    const blob = Buffer.from(envelope.ct, 'base64').toString('latin1');

    expect(blob).not.toContain('sessionid');
    expect(blob).not.toContain('abc123');
  });

  test('each seal uses a fresh ephemeral key, so ciphertexts differ', async () => {
    const first = await seal(credential, keys.publicKey);
    const second = await seal(credential, keys.publicKey);

    expect(first.epk).not.toBe(second.epk);
    expect(first.ct).not.toBe(second.ct);
  });

  test('rejects an envelope sealed for another key pair', async () => {
    const other = await generateKeyPair();
    const envelope = await seal(credential, other.publicKey);

    await expect(open(envelope, keys)).rejects.toThrow('sealed for a different key pair');
  });

  test('rejects a tampered ciphertext', async () => {
    const envelope = await seal(credential, keys.publicKey);
    const bytes = Buffer.from(envelope.ct, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;

    await expect(open({ ...envelope, ct: bytes.toString('base64') }, keys)).rejects.toThrow();
  });

  test('rejects an unsupported version', async () => {
    const envelope = await seal(credential, keys.publicKey);
    await expect(open({ ...envelope, v: 2 as 1 }, keys)).rejects.toThrow('unsupported envelope version');
  });
});

describe('envelope text form', () => {
  test('round-trips through the portable string', async () => {
    const envelope = await seal(credential, keys.publicKey);
    const decoded = decodeEnvelope(encodeEnvelope(envelope));

    expect(decoded).toEqual(envelope);
    await expect(open(decoded, keys)).resolves.toMatchObject({ cookie: credential.cookie });
  });

  test('is prefixed and single-line, so it survives copy/paste', async () => {
    const text = encodeEnvelope(await seal(credential, keys.publicKey));

    expect(text.startsWith('tvcred1.')).toBe(true);
    expect(text).not.toContain('\n');
  });

  test('rejects a string that is not an envelope', () => {
    expect(() => decodeEnvelope('tvcred1.bm90IGpzb24=')).toThrow();
  });
});

describe('key generation', () => {
  test('produces SPKI public keys and PKCS#8 private keys', async () => {
    const pair = await generateKeyPair();

    // P-256 in DER: 91-byte SPKI public key, 138-byte PKCS#8 private key.
    // SPKI/PKCS#8 is what .NET reads natively, which is why this curve was chosen.
    expect(Buffer.from(pair.publicKey, 'base64')).toHaveLength(91);
    expect(Buffer.from(pair.privateKey, 'base64')).toHaveLength(138);
  });

  test('produces distinct pairs', async () => {
    const other = await generateKeyPair();
    expect(other.publicKey).not.toBe(keys.publicKey);
  });
});
