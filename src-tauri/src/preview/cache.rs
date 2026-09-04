//! Thumbnail cache.
//!
//! Thumbnails are written to disk and handed to the WebView as files, not as
//! base64 over IPC. Base64 costs +33% in size, crosses the boundary as escaped
//! JSON, pins the whole image in the JS heap, and -- decisively -- offers no
//! HTTP range requests, which is what makes video seeking work.
//!
//! Keying on path + mtime + size + target size + a version constant means an
//! edited file re-renders on its own, and bumping `VERSION` invalidates every
//! cached thumbnail at once after a decoding change.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use image::{DynamicImage, ImageFormat};

use crate::error::{ErrCode, FsError};

/// Bump to invalidate every cached thumbnail.
const VERSION: u32 = 1;
/// Delete cached thumbnails untouched for this long.
const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Sweep the oldest entries once the cache passes this size.
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const JPEG_QUALITY: u8 = 82;

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbDims {
    pub width: u32,
    pub height: u32,
}

pub struct ThumbCache {
    root: PathBuf,
    /// digest -> dimensions, so a cache hit avoids re-reading the PNG header.
    index: Mutex<HashMap<String, ThumbDims>>,
}

impl ThumbCache {
    pub fn new(root: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&root);
        Self { root, index: Mutex::new(HashMap::new()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Return the cached thumbnail for a file, rendering it if necessary.
    pub fn get_or_create(
        &self,
        source: &Path,
        target_px: u32,
    ) -> Result<(PathBuf, ThumbDims), FsError> {
        let md = std::fs::metadata(source).map_err(|e| FsError::from_io(&e, source))?;
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);

        let digest = digest_of(source, mtime, md.len(), target_px);

        // A hit in the index still has to confirm the file is there: the sweep,
        // or the user clearing their cache folder, can remove it underneath us.
        if let Some(dims) = self.lookup(&digest) {
            for ext in ["jpg", "png"] {
                let path = self.path_for(&digest, ext);
                if path.is_file() {
                    return Ok((path, dims));
                }
            }
        }

        for ext in ["jpg", "png"] {
            let path = self.path_for(&digest, ext);
            if path.is_file() {
                let dims = super::decode::dimensions(&path)
                    .map(|(w, h)| ThumbDims { width: w, height: h })
                    .unwrap_or(ThumbDims { width: 0, height: 0 });
                if dims.width > 0 {
                    self.remember(&digest, dims);
                    return Ok((path, dims));
                }
                // A zero-size or corrupt cache file: drop it and re-render.
                let _ = std::fs::remove_file(&path);
            }
        }

        let image = super::decode::decode_scaled(source, target_px)?;
        let dims = ThumbDims { width: image.width(), height: image.height() };
        let path = self.write(&digest, &image)?;
        self.remember(&digest, dims);
        Ok((path, dims))
    }

    fn lookup(&self, digest: &str) -> Option<ThumbDims> {
        // A poisoned lock must degrade, not cascade.
        self.index
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(digest)
            .copied()
    }

    fn remember(&self, digest: &str, dims: ThumbDims) {
        self.index
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(digest.to_owned(), dims);
    }

    /// Two hex characters of the digest shard the files, capping any one
    /// directory at a few hundred entries.
    fn path_for(&self, digest: &str, ext: &str) -> PathBuf {
        self.root.join(&digest[..2]).join(format!("{digest}.{ext}"))
    }

    fn write(&self, digest: &str, image: &DynamicImage) -> Result<PathBuf, FsError> {
        let alpha = super::decode::has_alpha(image);
        let ext = if alpha { "png" } else { "jpg" };
        let target = self.path_for(digest, ext);

        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| FsError::from_io(&e, parent))?;
        }

        // Write to a temp name in the same directory then rename: on NTFS that
        // is atomic, so two concurrent requests for one thumbnail can never
        // produce a torn file.
        let temp = target.with_extension(format!("{ext}.{}.part", std::process::id()));
        {
            let mut out = std::fs::File::create(&temp).map_err(|e| FsError::from_io(&e, &temp))?;
            let result = if alpha {
                image.write_to(&mut std::io::BufWriter::new(&mut out), ImageFormat::Png)
            } else {
                // JPEG cannot carry alpha, and an RGBA source would fail here.
                let rgb = DynamicImage::ImageRgb8(image.to_rgb8());
                let mut buf = std::io::BufWriter::new(&mut out);
                let encoder =
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY);
                rgb.write_with_encoder(encoder)
            };
            result.map_err(|_| {
                FsError::new(ErrCode::DecodeFailed, "The thumbnail could not be encoded.")
            })?;
        }

        std::fs::rename(&temp, &target).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            FsError::from_io(&e, &target)
        })?;
        Ok(target)
    }

    /// Remove stale and excess thumbnails. Runs on a background thread at
    /// startup: it walks the cache directory, which can hold thousands of files.
    pub fn sweep(&self) {
        let mut files: Vec<(PathBuf, SystemTime, u64)> = Vec::new();
        let mut total: u64 = 0;
        let now = SystemTime::now();

        let Ok(shards) = std::fs::read_dir(&self.root) else { return };
        for shard in shards.flatten() {
            let Ok(entries) = std::fs::read_dir(shard.path()) else { continue };
            for entry in entries.flatten() {
                let Ok(md) = entry.metadata() else { continue };
                if !md.is_file() {
                    continue;
                }
                let modified = md.modified().unwrap_or(now);
                let age = now.duration_since(modified).unwrap_or_default();
                if age > MAX_AGE {
                    let _ = std::fs::remove_file(entry.path());
                    continue;
                }
                total += md.len();
                files.push((entry.path(), modified, md.len()));
            }
        }

        if total <= MAX_TOTAL_BYTES {
            return;
        }
        // Oldest first, until back under budget.
        files.sort_by_key(|(_, modified, _)| *modified);
        for (path, _, len) in files {
            if total <= MAX_TOTAL_BYTES {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(len);
            }
        }
    }
}

fn digest_of(source: &Path, mtime_nanos: u128, size: u64, target_px: u32) -> String {
    let mut hasher = DefaultHasher::new();
    // NTFS is case-insensitive, so two casings of one path must hash alike.
    source.to_string_lossy().to_lowercase().hash(&mut hasher);
    mtime_nanos.hash(&mut hasher);
    size.hash(&mut hasher);
    target_px.hash(&mut hasher);
    VERSION.hash(&mut hasher);
    // 64 bits: at 100k cached thumbnails the collision probability is about
    // 3e-10, and a collision only means one wrong thumbnail that heals on the
    // next mtime change.
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    fn cache_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join(format!("finder-fm-thumbcache-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        p
    }

    fn write_png(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join(name);
        let mut img = RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Rgb([(x % 256) as u8, (y % 256) as u8, 64]);
        }
        img.save(&path).expect("write source png");
        path
    }

    #[test]
    fn renders_then_reuses_a_cached_thumbnail() {
        let root = cache_dir("reuse");
        let cache = ThumbCache::new(root.clone());
        let src = write_png(&root.join("src"), "a.png", 400, 200);

        let (first, dims) = cache.get_or_create(&src, 100).expect("first render");
        assert!(first.is_file());
        assert_eq!((dims.width, dims.height), (100, 50));

        let modified_before = std::fs::metadata(&first).unwrap().modified().unwrap();
        let (second, dims2) = cache.get_or_create(&src, 100).expect("cache hit");
        assert_eq!(first, second, "the same key must resolve to the same file");
        assert_eq!(
            std::fs::metadata(&second).unwrap().modified().unwrap(),
            modified_before,
            "a hit must not rewrite the file"
        );
        assert_eq!((dims2.width, dims2.height), (100, 50));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_different_target_size_is_a_different_entry() {
        let root = cache_dir("size");
        let cache = ThumbCache::new(root.clone());
        let src = write_png(&root.join("src"), "a.png", 400, 200);

        let (small, _) = cache.get_or_create(&src, 64).expect("small");
        let (large, _) = cache.get_or_create(&src, 256).expect("large");
        assert_ne!(small, large);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn editing_the_source_invalidates_the_thumbnail() {
        let root = cache_dir("mtime");
        let cache = ThumbCache::new(root.clone());
        let dir = root.join("src");
        let src = write_png(&dir, "a.png", 200, 200);
        let (before, _) = cache.get_or_create(&src, 64).expect("before");

        // A different size guarantees a different key even if the filesystem
        // timestamp resolution is coarse.
        std::thread::sleep(Duration::from_millis(20));
        let src2 = write_png(&dir, "a.png", 240, 120);
        let (after, dims) = cache.get_or_create(&src2, 64).expect("after");

        assert_ne!(before, after, "an edited file must re-render");
        assert_eq!((dims.width, dims.height), (64, 32));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn re_renders_when_the_cache_file_was_deleted_underneath_us() {
        let root = cache_dir("deleted");
        let cache = ThumbCache::new(root.clone());
        let src = write_png(&root.join("src"), "a.png", 120, 120);

        let (path, _) = cache.get_or_create(&src, 64).expect("first");
        std::fs::remove_file(&path).expect("simulate a cache sweep");

        let (again, _) = cache.get_or_create(&src, 64).expect("second");
        assert!(again.is_file(), "an index hit must verify the file still exists");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn uses_png_for_transparency_and_jpeg_otherwise() {
        let root = cache_dir("format");
        let cache = ThumbCache::new(root.clone());
        let dir = root.join("src");
        let _ = std::fs::create_dir_all(&dir);

        let opaque = write_png(&dir, "opaque.png", 80, 80);
        let (jpg, _) = cache.get_or_create(&opaque, 64).expect("opaque");
        assert_eq!(jpg.extension().unwrap(), "jpg", "an opaque thumb is far smaller as JPEG");

        let transparent = dir.join("alpha.png");
        let mut img = RgbaImage::new(80, 80);
        for px in img.pixels_mut() {
            *px = Rgba([10, 20, 30, 0]);
        }
        img.save(&transparent).expect("write alpha png");
        let (png, _) = cache.get_or_create(&transparent, 64).expect("alpha");
        assert_eq!(png.extension().unwrap(), "png", "transparency must survive");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn leaves_no_partial_files_behind() {
        let root = cache_dir("partial");
        let cache = ThumbCache::new(root.clone());
        let src = write_png(&root.join("src"), "a.png", 100, 100);
        cache.get_or_create(&src, 64).expect("render");

        let mut parts = 0;
        for shard in std::fs::read_dir(&root).unwrap().flatten() {
            if let Ok(entries) = std::fs::read_dir(shard.path()) {
                for e in entries.flatten() {
                    if e.path().to_string_lossy().ends_with(".part") {
                        parts += 1;
                    }
                }
            }
        }
        assert_eq!(parts, 0);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn surfaces_a_typed_error_for_a_missing_source() {
        let root = cache_dir("missing");
        let cache = ThumbCache::new(root.clone());
        let err = cache
            .get_or_create(Path::new(r"C:\__finder_fm_missing__.png"), 64)
            .expect_err("should fail");
        assert_eq!(err.code, ErrCode::NotFound);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sweep_is_safe_on_an_empty_cache() {
        let root = cache_dir("sweep");
        let cache = ThumbCache::new(root.clone());
        cache.sweep();
        let _ = std::fs::remove_dir_all(root);
    }
}
