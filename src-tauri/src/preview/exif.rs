//! JPEG EXIF orientation.
//!
//! The `image` crate does not apply orientation, so without this every photo
//! taken in portrait on a phone previews on its side. There is no EXIF crate in
//! the dependency set, so this walks the JPEG marker segments to find the APP1
//! block and reads IFD0 tag 0x0112 -- small, but genuinely fiddly, which is why
//! it is isolated here with its own tests.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// EXIF orientation values 1..=8. 1 means "already upright".
pub const UPRIGHT: u8 = 1;

/// How much of the file to inspect. EXIF lives near the start; a 128 KiB
/// ceiling keeps a corrupt or hostile file from being read in full.
const MAX_SCAN: u64 = 128 * 1024;

/// Read the orientation tag, defaulting to upright when absent or unreadable.
pub fn jpeg_orientation(path: &Path) -> u8 {
    match read_head(path) {
        Some(bytes) => parse(&bytes).unwrap_or(UPRIGHT),
        None => UPRIGHT,
    }
}

fn read_head(path: &Path) -> Option<Vec<u8>> {
    let file = File::open(path).ok()?;
    let mut buf = Vec::new();
    BufReader::new(file).take(MAX_SCAN).read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn u16_at(b: &[u8], i: usize, big_endian: bool) -> Option<u16> {
    let hi = *b.get(i)?;
    let lo = *b.get(i + 1)?;
    Some(if big_endian {
        u16::from_be_bytes([hi, lo])
    } else {
        u16::from_le_bytes([hi, lo])
    })
}

fn u32_at(b: &[u8], i: usize, big_endian: bool) -> Option<u32> {
    let s = b.get(i..i + 4)?;
    let arr = [s[0], s[1], s[2], s[3]];
    Some(if big_endian {
        u32::from_be_bytes(arr)
    } else {
        u32::from_le_bytes(arr)
    })
}

/// Walk JPEG segments to APP1, then the TIFF header to IFD0 tag 0x0112.
pub fn parse(bytes: &[u8]) -> Option<u8> {
    // SOI
    if bytes.get(0..2)? != [0xFF, 0xD8] {
        return None;
    }

    let mut i = 2usize;
    loop {
        // Segments are 0xFF followed by a marker; fill bytes of 0xFF are legal.
        if *bytes.get(i)? != 0xFF {
            return None;
        }
        let mut marker = *bytes.get(i + 1)?;
        let mut j = i + 1;
        while marker == 0xFF {
            j += 1;
            marker = *bytes.get(j)?;
        }
        i = j + 1;

        // Start of scan: pixel data begins, so any EXIF would already have been
        // seen. Standalone markers carry no length.
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            continue;
        }

        let len = u16_at(bytes, i, true)? as usize;
        if len < 2 {
            return None;
        }
        let payload = bytes.get(i + 2..i + len)?;

        if marker == 0xE1 && payload.starts_with(b"Exif\0\0") {
            return orientation_from_tiff(&payload[6..]);
        }

        i += len;
    }
}

fn orientation_from_tiff(tiff: &[u8]) -> Option<u8> {
    let big_endian = match tiff.get(0..2)? {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };
    // Magic 42 confirms the byte order was read correctly.
    if u16_at(tiff, 2, big_endian)? != 42 {
        return None;
    }

    let ifd0 = u32_at(tiff, 4, big_endian)? as usize;
    let count = u16_at(tiff, ifd0, big_endian)? as usize;

    for k in 0..count {
        // Each directory entry is 12 bytes: tag, type, count, value.
        let entry = ifd0 + 2 + k * 12;
        if u16_at(tiff, entry, big_endian)? == 0x0112 {
            let value = u16_at(tiff, entry + 8, big_endian)?;
            return if (1..=8).contains(&value) {
                Some(value as u8)
            } else {
                None
            };
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal JPEG carrying one EXIF orientation tag.
    fn jpeg_with_orientation(value: u16, big_endian: bool) -> Vec<u8> {
        let mut tiff: Vec<u8> = Vec::new();
        tiff.extend_from_slice(if big_endian { b"MM" } else { b"II" });
        let put16 = |v: u16, out: &mut Vec<u8>| {
            out.extend_from_slice(&if big_endian {
                v.to_be_bytes()
            } else {
                v.to_le_bytes()
            })
        };
        let put32 = |v: u32, out: &mut Vec<u8>| {
            out.extend_from_slice(&if big_endian {
                v.to_be_bytes()
            } else {
                v.to_le_bytes()
            })
        };
        put16(42, &mut tiff);
        put32(8, &mut tiff); // IFD0 begins right after the header
        put16(1, &mut tiff); // one entry
        put16(0x0112, &mut tiff); // Orientation
        put16(3, &mut tiff); // SHORT
        put32(1, &mut tiff); // count
        put16(value, &mut tiff);
        put16(0, &mut tiff); // padding to fill the 4-byte value slot

        let mut app1: Vec<u8> = b"Exif\0\0".to_vec();
        app1.extend_from_slice(&tiff);

        let mut out: Vec<u8> = vec![0xFF, 0xD8];
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(&app1);
        out.extend_from_slice(&[0xFF, 0xDA]); // SOS
        out
    }

    #[test]
    fn reads_orientation_in_both_byte_orders() {
        for value in 1..=8u16 {
            assert_eq!(parse(&jpeg_with_orientation(value, true)), Some(value as u8));
            assert_eq!(parse(&jpeg_with_orientation(value, false)), Some(value as u8));
        }
    }

    #[test]
    fn rejects_an_out_of_range_value() {
        assert_eq!(parse(&jpeg_with_orientation(99, true)), None);
    }

    #[test]
    fn returns_none_for_a_jpeg_without_exif() {
        let plain = vec![0xFF, 0xD8, 0xFF, 0xDA];
        assert_eq!(parse(&plain), None);
    }

    #[test]
    fn returns_none_for_non_jpeg_and_truncated_input() {
        assert_eq!(parse(b"not a jpeg"), None);
        assert_eq!(parse(&[0xFF, 0xD8]), None);
        assert_eq!(parse(&[]), None);
    }

    #[test]
    fn skips_an_earlier_segment_to_find_app1() {
        let mut out: Vec<u8> = vec![0xFF, 0xD8];
        // An APP0/JFIF block first, as most cameras emit.
        out.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        out.extend_from_slice(b"JFIF\0");
        out.extend_from_slice(&[0u8; 9]);
        let with_exif = jpeg_with_orientation(6, true);
        out.extend_from_slice(&with_exif[2..]);
        assert_eq!(parse(&out), Some(6));
    }
}
