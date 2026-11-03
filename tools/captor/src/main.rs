//! Cross-platform capture tool for tv-paper-api.
//!
//! One window, three steps: read the session from a running TradingView desktop
//! app, paste the server's public key, save a sealed credential. The output is
//! safe to email or copy: it can only be opened by the holder of the matching
//! private key.
//!
//! Everything runs locally. The tool never talks to TradingView's servers, only to
//! the desktop app's debug port on loopback.

mod ui;

use tv_paper_captor::capture::{capture, DEFAULT_CDP_PORT};
use tv_paper_captor::envelope::{seal, Credential};

/// Headless mode, for scripting and CI.
///
/// The window is the intended path for people; this exists so the same capture
/// logic can be exercised without a display, and so power users can automate it.
fn run_cli(args: &[String]) -> Result<(), String> {
    let mut port = DEFAULT_CDP_PORT;
    let mut to: Option<String> = None;
    let mut out: Option<String> = None;
    let mut account: Option<String> = None;

    for arg in args {
        if let Some(v) = arg.strip_prefix("--port=") {
            port = v.parse().map_err(|_| format!("invalid port: {v}"))?;
        } else if let Some(v) = arg.strip_prefix("--to=") {
            to = Some(v.to_string());
        } else if let Some(v) = arg.strip_prefix("--out=") {
            out = Some(v.to_string());
        } else if let Some(v) = arg.strip_prefix("--account=") {
            account = Some(v.to_string());
        } else {
            return Err(format!("unknown argument: {arg}"));
        }
    }

    let to = to.ok_or("--to=<publicKey> is required")?;
    let session = capture(port).map_err(|e| e.to_string())?;

    let credential = Credential {
        cookie: format!("sessionid={}", session.session_id),
        segment: Some("pro".to_string()),
        account,
        note: None,
    };
    let sealed = seal(&credential, &to)?;

    match out {
        Some(path) => {
            std::fs::write(&path, format!("{sealed}\n")).map_err(|e| format!("write {path}: {e}"))?;
            eprintln!("sealed credential written to {path}");
        }
        None => println!("{sealed}"),
    }
    eprintln!("session: {}", session.expiry_label());
    Ok(())
}

fn main() -> eframe::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        // No window: run, report, and exit with a usable status code.
        if let Err(e) = run_cli(&args) {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
        return Ok(());
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([720.0, 640.0])
            .with_min_inner_size([600.0, 520.0])
            .with_title("tv-paper-api - capture credential"),
        ..Default::default()
    };

    eframe::run_native(
        "tv-paper-api-captor",
        options,
        Box::new(|cc| Ok(Box::new(ui::App::new(cc)))),
    )
}
