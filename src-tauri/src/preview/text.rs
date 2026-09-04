//! Text preview: read the head of a file and work out how to interpret it.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use crate::error::FsError;

pub const DEFAULT_MAX_BYTES: u64 = 256 * 1024;
/// Hard ceiling, so a caller cannot ask for a gigabyte of text over IPC.
const ABSOLUTE_MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextHead {
    pub text: String,
    pub bytes_read: u64,
    pub truncated: bool,
    pub encoding: &'static str,
    /// True when the bytes look like a binary file. The caller shows an icon
    /// rather than mojibake.
    pub is_binary: bool,
    pub line_count: u32,
}

pub fn read_head(path: &Path, max_bytes: Option<u64>) -> Result<TextHead, FsError> {
    let cap = max_bytes.unwrap_or(DEFAULT_MAX_BYTES).min(ABSOLUTE_MAX_BYTES);

    let file = File::open(path).map_err(|e| FsError::from_io(&e, path))?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);

    let mut buf = Vec::with_capacity(cap.min(64 * 1024) as usize);
    BufReader::new(file)
        .take(cap)
        .read_to_end(&mut buf)
        .map_err(|e| FsError::from_io(&e, path))?;

    let bytes_read = buf.len() as u64;
    Ok(decode(&buf, bytes_read, total > bytes_read))
}

/// Decide the encoding from a byte-order mark, falling back to UTF-8.
pub fn decode(buf: &[u8], bytes_read: u64, truncated: bool) -> TextHead {
    if buf.starts_with(&[0xFF, 0xFE]) {
        return finish(utf16(&buf[2..], false), "utf-16le", bytes_read, truncated, false);
    }
    if buf.starts_with(&[0xFE, 0xFF]) {
        return finish(utf16(&buf[2..], true), "utf-16be", bytes_read, truncated, false);
    }

    let body = if buf.starts_with(&[0xEF, 0xBB, 0xBF]) { &buf[3..] } else { buf };

    // A NUL byte in the first few kilobytes is the practical binary test: real
    // UTF-8 text does not contain one, and a truncated read cannot produce one.
    let probe = &body[..body.len().min(8192)];
    if probe.contains(&0) {
        return TextHead {
            text: String::new(),
            bytes_read,
            truncated,
            encoding: "binary",
            is_binary: true,
            line_count: 0,
        };
    }

    match std::str::from_utf8(body) {
        Ok(s) => finish(s.to_owned(), "utf-8", bytes_read, truncated, false),
        Err(e) => {
            // A truncated multi-byte sequence at the very end is expected when
            // the read stopped mid-character; anything earlier means the file
            // is not UTF-8 and gets a lossy read.
            let valid_up_to = e.valid_up_to();
            let clean_tail_break = e.error_len().is_none() && body.len() - valid_up_to < 4;
            if clean_tail_break {
                let s = String::from_utf8_lossy(&body[..valid_up_to]).into_owned();
                finish(s, "utf-8", bytes_read, truncated, false)
            } else {
                let s = String::from_utf8_lossy(body).into_owned();
                finish(s, "latin1-guess", bytes_read, truncated, false)
            }
        }
    }
}

fn utf16(bytes: &[u8], big_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| {
            if big_endian {
                u16::from_be_bytes([c[0], c[1]])
            } else {
                u16::from_le_bytes([c[0], c[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

fn finish(
    text: String,
    encoding: &'static str,
    bytes_read: u64,
    truncated: bool,
    is_binary: bool,
) -> TextHead {
    let line_count = u32::try_from(text.lines().count()).unwrap_or(u32::MAX);
    TextHead { text, bytes_read, truncated, encoding, is_binary, line_count }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_plain_utf8() {
        let h = decode(b"hello\nworld\n", 12, false);
        assert_eq!(h.encoding, "utf-8");
        assert_eq!(h.text, "hello\nworld\n");
        assert_eq!(h.line_count, 2);
        assert!(!h.is_binary);
    }

    #[test]
    fn strips_a_utf8_bom() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(b"hi");
        let h = decode(&b, b.len() as u64, false);
        assert_eq!(h.text, "hi");
        assert_eq!(h.encoding, "utf-8");
    }

    #[test]
    fn decodes_utf16_in_both_byte_orders() {
        let le = [0xFF, 0xFE, b'h', 0, b'i', 0];
        assert_eq!(decode(&le, 6, false).text, "hi");
        assert_eq!(decode(&le, 6, false).encoding, "utf-16le");

        let be = [0xFE, 0xFF, 0, b'h', 0, b'i'];
        assert_eq!(decode(&be, 6, false).text, "hi");
        assert_eq!(decode(&be, 6, false).encoding, "utf-16be");
    }

    #[test]
    fn flags_binary_content_instead_of_showing_mojibake() {
        let h = decode(&[0x7F, b'E', b'L', b'F', 0x02, 0x00, 0x01], 7, false);
        assert!(h.is_binary);
        assert_eq!(h.encoding, "binary");
        assert!(h.text.is_empty());
    }

    #[test]
    fn tolerates_a_multibyte_character_cut_by_the_read_limit() {
        // "é" is two bytes; cutting after the first must not be reported as a
        // different encoding, because a truncated read is normal here.
        let h = decode(&[b'a', 0xC3], 2, true);
        assert_eq!(h.encoding, "utf-8");
        assert_eq!(h.text, "a");
        assert!(h.truncated);
    }

    #[test]
    fn falls_back_to_lossy_for_genuinely_invalid_bytes() {
        let h = decode(&[b'a', 0xFF, 0xFE_u8.wrapping_add(1), b'b', b'c', b'd', b'e'], 7, false);
        assert_eq!(h.encoding, "latin1-guess");
        assert!(h.text.contains('a'));
    }

    #[test]
    fn reads_a_real_file_and_reports_truncation() {
        let p = std::env::temp_dir().join(format!("finder-fm-text-{}.txt", std::process::id()));
        std::fs::write(&p, "abcdefghij").expect("write");

        let full = read_head(&p, None).expect("read");
        assert_eq!(full.text, "abcdefghij");
        assert!(!full.truncated);

        let clipped = read_head(&p, Some(4)).expect("read");
        assert_eq!(clipped.text, "abcd");
        assert!(clipped.truncated, "the caller needs to know it is seeing a prefix");

        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn surfaces_a_typed_error_for_a_missing_file() {
        let err = read_head(Path::new(r"C:\__finder_fm_missing__.txt"), None).expect_err("fail");
        assert_eq!(err.code, crate::error::ErrCode::NotFound);
    }
}
