//! Library surface of the capture tool.
//!
//! Split from the binary so the envelope format can be exercised by integration
//! tests and by the server's cross-language compatibility checks, without
//! launching a window.

pub mod capture;
pub mod envelope;
