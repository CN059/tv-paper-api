//! Reads the paper-trading session cookie out of a running TradingView desktop app.
//!
//! The desktop client is Electron; started with `--remote-debugging-port` it speaks
//! the Chrome DevTools Protocol. We list targets over HTTP, open the chart page's
//! WebSocket, and ask for `Network.getAllCookies` — the only way to see an httpOnly
//! cookie, which is exactly what `sessionid` is.
//!
//! This is read-only: nothing is written to the app, and no order is placed.

use serde::Deserialize;
use std::net::TcpStream;
use std::time::Duration;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};

/// Default port `scripts/launch-tv.ps1` starts the desktop app with.
pub const DEFAULT_CDP_PORT: u16 = 9333;

#[derive(Debug, Deserialize)]
struct Target {
    #[serde(rename = "type")]
    kind: String,
    url: String,
    #[serde(rename = "webSocketDebuggerUrl")]
    ws_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SessionCookie {
    /// Value of `sessionid`.
    pub session_id: String,
    /// Unix seconds, or 0 when the cookie is a session cookie.
    pub expires: i64,
}

impl SessionCookie {
    /// Human-readable expiry, or a note when the cookie has no fixed lifetime.
    pub fn expiry_label(&self) -> String {
        if self.expires <= 0 {
            return "session cookie (ends when the app closes)".to_string();
        }
        let secs = self.expires;
        // Avoid pulling in a date crate for one label: the UI only needs a rough cue.
        let days = (secs - now_unix()).max(0) / 86_400;
        if days > 0 {
            format!("{days} days left")
        } else {
            "expires today".to_string()
        }
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Why a capture attempt failed, phrased for a dialog rather than a log file.
#[derive(Debug)]
pub enum CaptureError {
    NotRunning(u16),
    NoChartPage,
    NoSession,
    Protocol(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRunning(port) => write!(
                f,
                "No TradingView debug port on 127.0.0.1:{port}.\n\nQuit TradingView completely, then start it with:\n  scripts/launch-tv.ps1 -Port {port}"
            ),
            Self::NoChartPage => write!(
                f,
                "TradingView is running, but no chart tab is open.\n\nOpen any chart, then try again."
            ),
            Self::NoSession => write!(
                f,
                "Not signed in.\n\nSign in to TradingView in the desktop app, then try again."
            ),
            Self::Protocol(msg) => write!(f, "Could not read cookies from TradingView: {msg}"),
        }
    }
}

fn list_targets(port: u16) -> Result<Vec<Target>, CaptureError> {
    let addr = format!("127.0.0.1:{port}");
    if TcpStream::connect_timeout(&addr.parse().expect("valid addr"), Duration::from_millis(400)).is_err()
    {
        return Err(CaptureError::NotRunning(port));
    }

    let body = ureq::get(&format!("http://{addr}/json/list"))
        .timeout(Duration::from_secs(3))
        .call()
        .map_err(|e| CaptureError::Protocol(e.to_string()))?
        .into_string()
        .map_err(|e| CaptureError::Protocol(e.to_string()))?;

    serde_json::from_str(&body).map_err(|e| CaptureError::Protocol(e.to_string()))
}

/// Read `sessionid` from the running desktop app.
pub fn capture(port: u16) -> Result<SessionCookie, CaptureError> {
    let targets = list_targets(port)?;
    let chart = targets
        .iter()
        .find(|t| t.kind == "page" && t.url.contains("tradingview.com/chart"))
        .ok_or(CaptureError::NoChartPage)?;

    let ws_url = chart.ws_url.as_deref().ok_or(CaptureError::NoChartPage)?;
    let (mut socket, _) = connect(ws_url).map_err(|e| CaptureError::Protocol(e.to_string()))?;

    socket
        .send(Message::Text(
            r#"{"id":1,"method":"Network.getAllCookies"}"#.to_string().into(),
        ))
        .map_err(|e| CaptureError::Protocol(e.to_string()))?;

    let cookies = read_cookies(&mut socket)?;
    cookies.ok_or(CaptureError::NoSession)
}

fn read_cookies(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
) -> Result<Option<SessionCookie>, CaptureError> {
    // The reply can be preceded by unrelated events; only id=1 matters.
    for _ in 0..20 {
        let message = socket
            .read()
            .map_err(|e| CaptureError::Protocol(e.to_string()))?;
        let text = match message {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };

        let parsed: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| CaptureError::Protocol(e.to_string()))?;
        if parsed.get("id").and_then(|v| v.as_i64()) != Some(1) {
            continue;
        }

        let Some(list) = parsed
            .get("result")
            .and_then(|r| r.get("cookies"))
            .and_then(|c| c.as_array())
        else {
            return Ok(None);
        };

        // `sessionid` alone is sufficient; sessionid_sign and device_t are not needed.
        for cookie in list {
            let name = cookie.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            if name != "sessionid" {
                continue;
            }
            let value = cookie.get("value").and_then(|v| v.as_str()).unwrap_or_default();
            if value.is_empty() {
                return Ok(None);
            }
            let expires = cookie
                .get("expires")
                .and_then(|v| v.as_f64())
                .map(|e| e as i64)
                .unwrap_or(0);
            return Ok(Some(SessionCookie {
                session_id: value.to_string(),
                expires,
            }));
        }
        return Ok(None);
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_label_reports_a_session_cookie_without_a_date() {
        let cookie = SessionCookie {
            session_id: "x".into(),
            expires: 0,
        };
        assert!(cookie.expiry_label().contains("session cookie"));
    }

    #[test]
    fn expiry_label_counts_whole_days() {
        let cookie = SessionCookie {
            session_id: "x".into(),
            expires: now_unix() + 86_400 * 90,
        };
        // Truncation can make this 89 or 90 depending on timing within the second.
        assert!(cookie.expiry_label().starts_with("89") || cookie.expiry_label().starts_with("90"));
    }

    #[test]
    fn unreachable_port_is_reported_as_not_running() {
        // Port 1 is never a devtools endpoint.
        match capture(1) {
            Err(CaptureError::NotRunning(port)) => assert_eq!(port, 1),
            other => panic!("expected NotRunning, got {other:?}"),
        }
    }
}
