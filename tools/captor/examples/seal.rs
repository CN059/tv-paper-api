//! Cross-language check: seal a credential with the Rust implementation so the
//! TypeScript one can open it.
//!
//!   cargo run --example seal -- <publicKeyBase64>

use tv_paper_captor::envelope::{seal, Credential};

fn main() {
    let public = std::env::args().nth(1).expect("usage: seal <publicKeyBase64>");
    let credential = Credential {
        cookie: "sessionid=from-rust".into(),
        segment: Some("pro".into()),
        account: Some("10000001".into()),
        note: Some("cross-language check".into()),
    };
    match seal(&credential, &public) {
        Ok(text) => println!("{text}"),
        Err(e) => {
            eprintln!("seal failed: {e}");
            std::process::exit(1);
        }
    }
}
