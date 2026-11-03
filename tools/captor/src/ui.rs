//! The single window: capture, seal, save, and copy.
//!
//! State is deliberately flat — this tool exists to do one thing, and a wizard
//! would hide the pieces people need to verify (which account, which expiry,
//! whose public key).

use tv_paper_captor::capture::{self, SessionCookie, DEFAULT_CDP_PORT};
use tv_paper_captor::envelope::{self, Credential};
use eframe::egui;

/// Copy-to-clipboard actions that must happen after the frame is laid out.
enum Action {
    None,
    Copy(String),
    Save(String),
}

pub struct App {
    port: String,
    session: Option<SessionCookie>,
    public_key: String,
    account: String,
    segment_free: bool,
    note: String,
    sealed: Option<String>,
    status: Status,
    save_path: String,
}

enum Status {
    Idle,
    Good(String),
    Bad(String),
}

impl App {
    pub fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        Self {
            port: DEFAULT_CDP_PORT.to_string(),
            session: None,
            public_key: String::new(),
            account: String::new(),
            segment_free: false,
            note: String::new(),
            sealed: None,
            status: Status::Idle,
            save_path: "cred.enc".to_string(),
        }
    }

    fn parse_port(&self) -> Result<u16, String> {
        self.port
            .trim()
            .parse::<u16>()
            .map_err(|_| "port must be a number between 1 and 65535".to_string())
    }

    fn key_ok(&self) -> bool {
        !self.public_key.trim().is_empty()
            && envelope::check_public_key(&self.public_key).is_ok()
    }

    fn capture(&mut self) {
        self.sealed = None;
        let port = match self.parse_port() {
            Ok(p) => p,
            Err(e) => {
                self.status = Status::Bad(e);
                return;
            }
        };

        match capture::capture(port) {
            Ok(session) => {
                let label = session.expiry_label();
                self.status = Status::Good(format!("Session captured - {label}"));
                self.session = Some(session);
            }
            Err(e) => {
                self.session = None;
                self.status = Status::Bad(e.to_string());
            }
        }
    }

    fn seal(&mut self) {
        let Some(session) = self.session.as_ref() else {
            self.status = Status::Bad("Capture a session first.".into());
            return;
        };

        let credential = Credential {
            cookie: format!("sessionid={}", session.session_id),
            segment: Some(if self.segment_free { "free" } else { "pro" }.to_string()),
            account: trimmed(&self.account),
            note: trimmed(&self.note),
        };

        match envelope::seal(&credential, &self.public_key) {
            Ok(text) => {
                self.status = Status::Good("Sealed. Send the server this file, not your cookie.".into());
                self.sealed = Some(text);
            }
            Err(e) => {
                self.sealed = None;
                self.status = Status::Bad(e);
            }
        }
    }
}

fn trimmed(value: &str) -> Option<String> {
    let t = value.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let mut action = Action::None;

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.add_space(4.0);
            ui.heading("Capture a TradingView paper-trading credential");
            ui.label(
                egui::RichText::new(
                    "Runs entirely on this machine. Nothing is sent anywhere; the output can only \
                     be opened by the server holding the matching private key.",
                )
                .small()
                .weak(),
            );
            ui.add_space(12.0);

            // ---- Step 1: session -------------------------------------------------
            egui::Frame::group(ui.style()).show(ui, |ui| {
                ui.label(egui::RichText::new("1. Session").strong());

                ui.horizontal(|ui| {
                    ui.label("Debug port");
                    ui.add(egui::TextEdit::singleline(&mut self.port).desired_width(80.0));
                    if ui.button("Capture session").clicked() {
                        self.capture();
                    }
                });

                match &self.session {
                    Some(session) => {
                        ui.colored_label(
                            egui::Color32::from_rgb(0x2e, 0x7d, 0x32),
                            format!("Signed in - {}", session.expiry_label()),
                        );
                    }
                    None => {
                        ui.label(
                            egui::RichText::new(
                                "TradingView must be running with a debug port. \
                                 Quit it fully, then run scripts/launch-tv.ps1.",
                            )
                            .small()
                            .weak(),
                        );
                    }
                }
            });

            ui.add_space(8.0);

            // ---- Step 2: recipient ----------------------------------------------
            egui::Frame::group(ui.style()).show(ui, |ui| {
                ui.label(egui::RichText::new("2. Server public key").strong());
                ui.label(
                    egui::RichText::new(
                        "On the server: bun run credctl keygen   (copy its publicKey here)",
                    )
                    .small()
                    .weak(),
                );

                ui.add(
                    egui::TextEdit::multiline(&mut self.public_key)
                        .desired_rows(3)
                        .desired_width(f32::INFINITY)
                        .hint_text("Paste the server's publicKey (base64 SPKI)"),
                );

                if !self.public_key.trim().is_empty() {
                    if self.key_ok() {
                        let fp = envelope::short_fingerprint(&self.public_key);
                        ui.colored_label(
                            egui::Color32::from_rgb(0x2e, 0x7d, 0x32),
                            format!("Valid P-256 key - fingerprint {fp}"),
                        );
                    } else {
                        ui.colored_label(
                            egui::Color32::from_rgb(0xc6, 0x28, 0x28),
                            "Not a valid P-256 public key",
                        );
                    }
                }
            });

            ui.add_space(8.0);

            // ---- Step 3: options -------------------------------------------------
            egui::Frame::group(ui.style()).show(ui, |ui| {
                ui.label(egui::RichText::new("3. Options").strong());
                ui.horizontal(|ui| {
                    ui.label("Account id");
                    ui.add(
                        egui::TextEdit::singleline(&mut self.account)
                            .desired_width(120.0)
                            .hint_text("optional"),
                    );
                    ui.label("Label");
                    ui.add(
                        egui::TextEdit::singleline(&mut self.note)
                            .desired_width(180.0)
                            .hint_text("optional"),
                    );
                });
                ui.checkbox(&mut self.segment_free, "Free plan (papertrading-free host)");
            });

            ui.add_space(12.0);

            // ---- Seal ------------------------------------------------------------
            let ready = self.session.is_some() && self.key_ok();
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(ready, egui::Button::new("Seal credential"))
                    .clicked()
                {
                    self.seal();
                }
                if !ready {
                    ui.label(
                        egui::RichText::new("needs a captured session and a valid key")
                            .small()
                            .weak(),
                    );
                }
            });

            if let Some(sealed) = &self.sealed {
                ui.add_space(8.0);
                egui::Frame::group(ui.style()).show(ui, |ui| {
                    ui.label(egui::RichText::new("Sealed credential").strong());
                    let mut shown = sealed.clone();
                    ui.add(
                        egui::TextEdit::multiline(&mut shown)
                            .desired_rows(4)
                            .desired_width(f32::INFINITY)
                            .code_editor(),
                    );
                    ui.horizontal(|ui| {
                        if ui.button("Copy to clipboard").clicked() {
                            action = Action::Copy(sealed.clone());
                        }
                        if ui.button("Save as file...").clicked() {
                            action = Action::Save(sealed.clone());
                        }
                    });
                });
            }

            ui.add_space(10.0);
            match &self.status {
                Status::Idle => {}
                Status::Good(msg) => {
                    ui.colored_label(egui::Color32::from_rgb(0x2e, 0x7d, 0x32), msg);
                }
                Status::Bad(msg) => {
                    ui.colored_label(egui::Color32::from_rgb(0xc6, 0x28, 0x28), msg);
                }
            }
        });

        match action {
            Action::None => {}
            Action::Copy(text) => {
                ctx.copy_text(text);
                self.status = Status::Good("Copied to clipboard.".into());
            }
            Action::Save(text) => {
                match rfd_save(&self.save_path, &text) {
                    Ok(path) => self.status = Status::Good(format!("Saved to {path}")),
                    Err(e) => self.status = Status::Bad(e),
                }
            }
        }
    }
}

/// Write without a native dialog dependency: ask for a path in the same window.
fn rfd_save(default: &str, text: &str) -> Result<String, String> {
    let path = if default.trim().is_empty() {
        "cred.enc".to_string()
    } else {
        default.trim().to_string()
    };
    std::fs::write(&path, format!("{text}\n")).map_err(|e| format!("could not write {path}: {e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_parsing_rejects_junk() {
        let mut app = App::new_for_test();
        app.port = "abc".into();
        assert!(app.parse_port().is_err());

        app.port = "9333".into();
        assert_eq!(app.parse_port().unwrap(), 9333);
    }

    #[test]
    fn blank_options_become_none() {
        assert_eq!(trimmed("   "), None);
        assert_eq!(trimmed(" 10000001 "), Some("10000001".into()));
    }

    #[test]
    fn sealing_requires_a_session() {
        let mut app = App::new_for_test();
        app.seal();
        matches!(app.status, Status::Bad(_));
        assert!(app.sealed.is_none());
    }

    impl App {
        fn new_for_test() -> Self {
            Self {
                port: DEFAULT_CDP_PORT.to_string(),
                session: None,
                public_key: String::new(),
                account: String::new(),
                segment_free: false,
                note: String::new(),
                sealed: None,
                status: Status::Idle,
                save_path: "cred.enc".into(),
            }
        }
    }
}
