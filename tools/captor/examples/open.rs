//! Reverse check: open an envelope produced by the TypeScript implementation.
//!
//!   cargo run --example open -- <publicKey> <privateKey> <tvcred1...>

use tv_paper_captor::envelope;

fn main() {
    let mut args = std::env::args().skip(1);
    let public = args.next().expect("public key");
    let private = args.next().expect("private key");
    let text = args.next().expect("envelope");

    let json = text.trim().trim_start_matches("tvcred1.");
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    let raw = URL_SAFE_NO_PAD.decode(json).expect("base64url payload");
    let envelope: envelope::Envelope = serde_json::from_slice(&raw).expect("envelope json");

    match envelope::open(&envelope, &public, &private) {
        Ok(credential) => println!("{}", serde_json::to_string(&credential).unwrap()),
        Err(e) => {
            eprintln!("open failed: {e}");
            std::process::exit(1);
        }
    }
}
