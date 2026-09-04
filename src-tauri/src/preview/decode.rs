//! Image decoding for previews and thumbnails.
//!
//! Two guards are mandatory and neither is optional politeness:
//!
//!   1. **Probe dimensions from the header before decoding.** A 60000x60000 PNG
//!      is a few kilobytes on disk and 14 GB in memory.
//!   2. **`catch_unwind` around the decoder.** Third-party image decoders panic
//!      on fuzzed or truncated input, and one bad file in a Pictures folder must
//!      not take the process with it. This is why the release profile keeps
//!      `panic = "unwind"`.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use image::imageops::FilterType;
use image::{DynamicImage, ImageReader, Limits};

use crate::error::{ErrCode, FsError};

/// Refuse anything whose pixel count would dominate memory regardless of the
/// requested output size.
const MAX_PIXELS: u64 = 250_000_000;
const MAX_SIDE: u32 = 40_000;
const MAX_ALLOC: u64 = 512 * 1024 * 1024;

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_image_width = Some(MAX_SIDE);
    l.max_image_height = Some(MAX_SIDE);
    l.max_alloc = Some(MAX_ALLOC);
    l
}

/// Header-only dimension probe. Cheap: reads a few hundred bytes.
pub fn dimensions(path: &Path) -> Result<(u32, u32), FsError> {
    let mut reader = ImageReader::open(path)
        .map_err(|e| FsError::from_io(&e, path))?
        .with_guessed_format()
        .map_err(|e| FsError::from_io(&e, path))?;
    reader.limits(limits());
    reader
        .into_dimensions()
        .map_err(|_| FsError::new(ErrCode::DecodeFailed, "This image could not be read.").with_path(path))
}

/// Decode, apply EXIF orientation, and scale to fit `max_px` on the long edge.
///
/// Never upscales: a 64x64 icon asked for at 1600px comes back 64x64, because
/// blowing it up would only look worse and cost memory.
pub fn decode_scaled(path: &Path, max_px: u32) -> Result<DynamicImage, FsError> {
    let (w, h) = dimensions(path)?;
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err(
            FsError::new(ErrCode::Unsupported, "This image is too large to preview.").with_path(path),
        );
    }

    // The decoder runs inside catch_unwind: a panic becomes a typed error.
    let owned = path.to_path_buf();
    let decoded = catch_unwind(AssertUnwindSafe(move || -> Option<DynamicImage> {
        let mut reader = ImageReader::open(&owned).ok()?.with_guessed_format().ok()?;
        reader.limits(limits());
        reader.decode().ok()
    }))
    .map_err(|_| {
        FsError::new(ErrCode::DecodeFailed, "The image decoder failed on this file.")
            .with_path(path)
    })?
    .ok_or_else(|| {
        FsError::new(ErrCode::DecodeFailed, "This image could not be decoded.").with_path(path)
    })?;

    let oriented = apply_orientation(decoded, orientation_for(path));

    let (ow, oh) = (oriented.width(), oriented.height());
    if ow <= max_px && oh <= max_px {
        return Ok(oriented);
    }

    // `thumbnail` is a fast box filter, right for small grid sizes; a proper
    // filter is worth the cost only at Quick Look dimensions.
    Ok(if max_px <= 512 {
        oriented.thumbnail(max_px, max_px)
    } else {
        oriented.resize(max_px, max_px, FilterType::CatmullRom)
    })
}

fn orientation_for(path: &Path) -> u8 {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "jpg" || ext == "jpeg" || ext == "jpe" {
        super::exif::jpeg_orientation(path)
    } else {
        super::exif::UPRIGHT
    }
}

/// The eight EXIF orientations, in terms of rotate and flip.
fn apply_orientation(img: DynamicImage, orientation: u8) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// Whether the image carries meaningful transparency, which decides PNG versus
/// JPEG for the cached thumbnail. A 256px JPEG thumb is roughly 12 KB where the
/// PNG is 90 KB -- at 100k files that is the difference between a 1 GB and a
/// 9 GB cache.
pub fn has_alpha(img: &DynamicImage) -> bool {
    use image::DynamicImage as D;
    match img {
        D::ImageLumaA8(_) | D::ImageLumaA16(_) | D::ImageRgba8(_) | D::ImageRgba16(_)
        | D::ImageRgba32F(_) => img.to_rgba8().pixels().any(|p| p.0[3] != 255),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgb, RgbImage};

    fn temp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("finder-fm-decode-{}-{name}", std::process::id()));
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        p
    }

    fn write_png(name: &str, w: u32, h: u32) -> std::path::PathBuf {
        let path = temp(name);
        let mut img = RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        img.save(&path).expect("write test png");
        path
    }

    #[test]
    fn probes_dimensions_without_decoding() {
        let p = write_png("dims.png", 120, 80);
        assert_eq!(dimensions(&p).expect("dimensions"), (120, 80));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn scales_down_preserving_aspect_ratio() {
        let p = write_png("scale.png", 400, 200);
        let img = decode_scaled(&p, 100).expect("decode");
        assert_eq!((img.width(), img.height()), (100, 50));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn never_upscales_a_small_image() {
        let p = write_png("small.png", 32, 32);
        let img = decode_scaled(&p, 1600).expect("decode");
        assert_eq!((img.width(), img.height()), (32, 32));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn reports_a_typed_error_for_a_non_image() {
        let p = temp("notanimage.png");
        std::fs::write(&p, b"absolutely not a png").expect("write");
        let err = decode_scaled(&p, 128).expect_err("should fail");
        assert_eq!(err.code, ErrCode::DecodeFailed);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn reports_a_typed_error_for_a_missing_file() {
        let err = dimensions(std::path::Path::new(r"C:\__finder_fm_missing__.png"))
            .expect_err("should fail");
        assert_eq!(err.code, ErrCode::NotFound);
    }

    #[test]
    fn orientation_transforms_swap_axes_when_they_should() {
        let img = DynamicImage::ImageRgb8(RgbImage::new(40, 20));
        // 6 and 8 are the quarter turns, so width and height swap.
        assert_eq!(apply_orientation(img.clone(), 6).dimensions(), (20, 40));
        assert_eq!(apply_orientation(img.clone(), 8).dimensions(), (20, 40));
        // 1 and 3 keep the shape.
        assert_eq!(apply_orientation(img.clone(), 1).dimensions(), (40, 20));
        assert_eq!(apply_orientation(img, 3).dimensions(), (40, 20));
    }
}
