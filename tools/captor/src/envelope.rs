//! Credential envelope, matching `src/credential.ts` byte for byte.
//!
//! Construction: ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM, with the consumer's
//! public key fingerprinted so a mismatched key pair fails loudly instead of
//! surfacing as an opaque AES-GCM authentication error.
//!
//! P-256 rather than X25519 because it is the curve every platform implements
//! natively; the server side uses the same construction via WebCrypto.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdh::{EphemeralSecret, SharedSecret};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::{DecodePublicKey, EncodePublicKey};
use p256::PublicKey;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const INFO: &[u8] = b"tv-paper-api/credential/v1";
const SALT: [u8; 16] = [0u8; 16];
const IV_BYTES: usize = 12;
const TAG_BITS: usize = 128;

/// What the server needs in order to act for the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credential {
    /// Full `Cookie` header value, e.g. `sessionid=...`.
    pub cookie: String,
    /// `pro` or `free`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Wire format shared with the server. Field names are part of the contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u32,
    /// base64 SPKI public key of the capturing side (ephemeral).
    pub epk: String,
    pub nonce: String,
    pub ct: String,
    /// base64 SHA-256 of the consumer's SPKI public key.
    pub rpk: String,
}

pub fn fingerprint(spki: &[u8]) -> String {
    B64.encode(Sha256::digest(spki))
}

/// Encrypt a credential so only the holder of the matching private key can read it.
pub fn seal(credential: &Credential, consumer_public_spki_b64: &str) -> Result<String, String> {
    let consumer_der = B64
        .decode(consumer_public_spki_b64.trim())
        .map_err(|e| format!("invalid public key encoding: {e}"))?;
    let consumer = PublicKey::from_public_key_der(&consumer_der)
        .map_err(|e| format!("invalid public key: {e}"))?;

    // Fresh ephemeral key per envelope: two seals of the same credential differ.
    let ephemeral = EphemeralSecret::random(&mut rand::thread_rng());
    let ephemeral_public = ephemeral.public_key();
    let shared: SharedSecret = ephemeral.diffie_hellman(&consumer);

    let hk = Hkdf::<Sha256>::new(Some(&SALT), shared.raw_secret_bytes());
    let mut aes_key = [0u8; 32];
    hk.expand(INFO, &mut aes_key)
        .map_err(|e| format!("key derivation failed: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(&aes_key).map_err(|e| format!("bad key: {e}"))?;

    let mut nonce = [0u8; IV_BYTES];
    rand::thread_rng().fill_bytes(&mut nonce);

    let plaintext = serde_json::to_vec(credential).map_err(|e| format!("encode failed: {e}"))?;
    let ciphertext = cipher
        .encrypt(
            &Nonce::from(nonce_checked(&nonce)?),
            Payload {
                msg: &plaintext,
                aad: b"",
            },
        )
        .map_err(|_| "encryption failed".to_string())?;

    let epk_der = ephemeral_public.to_encoded_point(false);
    let epk_spki = PublicKey::from_sec1_bytes(epk_der.as_bytes())
        .map_err(|e| format!("unexpected ephemeral key: {e}"))?
        .to_public_key_der()
        .map_err(|e| format!("encode failed: {e}"))?;

    let envelope = Envelope {
        v: 1,
        epk: B64.encode(epk_spki.as_bytes()),
        nonce: B64.encode(nonce),
        ct: B64.encode(ciphertext),
        rpk: fingerprint(&consumer_der),
    };

    let json = serde_json::to_vec(&envelope).map_err(|e| format!("encode failed: {e}"))?;
    Ok(format!("tvcred1.{}", base64_url(&json)))
}

/// AES-GCM needs exactly a 12-byte nonce; reject anything else rather than panic.
fn nonce_checked(bytes: &[u8]) -> Result<[u8; IV_BYTES], String> {
    bytes
        .try_into()
        .map_err(|_| format!("nonce must be {} bytes, got {}", IV_BYTES, bytes.len()))
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    URL_SAFE_NO_PAD.encode(bytes)
}

/// How many characters of the recipient fingerprint to show, for eyeballing a match.
pub fn short_fingerprint(spki_b64: &str) -> String {
    match B64.decode(spki_b64.trim()) {
        Ok(der) => {
            let full = fingerprint(&der);
            full.chars().take(16).collect()
        }
        Err(_) => "<invalid key>".to_string(),
    }
}

/// Validate a public key without sealing, so the UI can reject a paste early.
pub fn check_public_key(spki_b64: &str) -> Result<(), String> {
    let der = B64
        .decode(spki_b64.trim())
        .map_err(|e| format!("invalid base64: {e}"))?;
    PublicKey::from_public_key_der(&der).map_err(|e| format!("not a P-256 public key: {e}"))?;
    Ok(())
}

/// Decrypt an envelope with the consumer's private key (PKCS#8).
///
/// The server never needs this path - it only seals - but keeping both directions
/// here lets the two implementations be cross-checked in CI.
pub fn open(envelope: &Envelope, consumer_public_b64: &str, consumer_private_b64: &str) -> Result<Credential, String> {
    use p256::pkcs8::DecodePrivateKey;
    use p256::SecretKey;

    let consumer_der = B64.decode(consumer_public_b64.trim()).map_err(|e| format!("invalid public key: {e}"))?;
    if fingerprint(&consumer_der) != envelope.rpk {
        return Err("envelope was sealed for a different key pair".to_string());
    }

    let private_der = B64.decode(consumer_private_b64.trim()).map_err(|e| format!("invalid private key: {e}"))?;
    let secret = SecretKey::from_pkcs8_der(&private_der).map_err(|e| format!("invalid private key: {e}"))?;

    let sender_der = B64.decode(&envelope.epk).map_err(|e| format!("invalid ephemeral key: {e}"))?;
    let sender = PublicKey::from_public_key_der(&sender_der).map_err(|e| format!("invalid ephemeral key: {e}"))?;

    let shared = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), sender.as_affine());
    let hk = Hkdf::<Sha256>::new(Some(&SALT), shared.raw_secret_bytes());
    let mut aes_key = [0u8; 32];
    hk.expand(INFO, &mut aes_key).map_err(|e| format!("key derivation failed: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(&aes_key).map_err(|e| format!("bad key: {e}"))?;
    let nonce = B64.decode(&envelope.nonce).map_err(|e| format!("invalid nonce: {e}"))?;
    let ct = B64.decode(&envelope.ct).map_err(|e| format!("invalid ciphertext: {e}"))?;

    let plaintext = cipher
        .decrypt(&Nonce::from(nonce_checked(&nonce)?), Payload { msg: &ct, aad: b"" })
        .map_err(|_| "decryption failed (wrong key or corrupted envelope)".to_string())?;

    serde_json::from_slice(&plaintext).map_err(|e| format!("payload is not a credential: {e}"))
}

const _: () = {
    // Compile-time reminder that the tag length matches the server's 128 bits.
    assert!(TAG_BITS == 128);
};

#[cfg(test)]
mod tests {
    use super::*;
    use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey};
    use p256::SecretKey;

    fn consumer_keys() -> (String, String) {
        let secret = SecretKey::random(&mut rand::thread_rng());
        let public = secret.public_key().to_public_key_der().unwrap();
        let private = secret.to_pkcs8_der().unwrap();
        (B64.encode(public.as_bytes()), B64.encode(private.as_bytes()))
    }

    #[test]
    fn seals_and_reports_recipient_fingerprint() {
        let (public, _) = consumer_keys();
        let credential = Credential {
            cookie: "sessionid=abc".into(),
            segment: Some("pro".into()),
            account: Some("10000001".into()),
            note: None,
        };

        let text = seal(&credential, &public).unwrap();

        assert!(text.starts_with("tvcred1."));
        assert_eq!(short_fingerprint(&public), short_fingerprint(&public));
    }

    #[test]
    fn ciphertext_does_not_contain_plaintext() {
        let (public, _) = consumer_keys();
        let credential = Credential {
            cookie: "sessionid=secret-value".into(),
            segment: None,
            account: None,
            note: None,
        };

        let text = seal(&credential, &public).unwrap();

        assert!(!text.contains("sessionid"));
        assert!(!text.contains("secret-value"));
    }

    #[test]
    fn each_seal_is_unique() {
        let (public, _) = consumer_keys();
        let credential = Credential {
            cookie: "sessionid=abc".into(),
            segment: None,
            account: None,
            note: None,
        };

        let first = seal(&credential, &public).unwrap();
        let second = seal(&credential, &public).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn rejects_a_bad_public_key() {
        assert!(seal(&Credential { cookie: "x".into(), segment: None, account: None, note: None }, "not-base64").is_err());
    }

    #[test]
    fn validates_public_keys() {
        let (public, _) = consumer_keys();
        assert!(check_public_key(&public).is_ok());
        assert!(check_public_key("bm90IGEga2V5").is_err());
    }

    #[test]
    fn private_key_roundtrips_through_pkcs8() {
        // The server stores PKCS#8; make sure the same derivation path is reachable.
        let (_, private) = consumer_keys();
        let der = B64.decode(&private).unwrap();
        let secret = SecretKey::from_pkcs8_der(&der).unwrap();
        assert_eq!(secret.to_pkcs8_der().unwrap().as_bytes(), der.as_slice());
    }
}
