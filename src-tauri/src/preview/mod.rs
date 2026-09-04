//! Preview planning.
//!
//! The backend decides HOW a file should be previewed and hands the frontend a
//! plan; it does not ship pixels. That keeps codec knowledge, cloud-placeholder
//! policy and the asset-protocol scope grant in one place.
//!
//! On scope: `plan` grants the file's directory to the asset protocol before
//! returning. That is deliberately the backend's job, because a request blocked
//! by scope produces a silently empty box with no error in any log -- the single
//! most common way this feature fails. The frontend converts the returned path
//! to an `asset:` URL with Tauri's own `convertFileSrc`, so we never
//! reimplement URL encoding.

pub mod cache;
pub mod decode;
pub mod exif;
pub mod text;

use std::path::Path;

use crate::error::{ErrCode, FsError};
use crate::ipc::attr;

use self::text::TextHead;

/// Above this, hand over a rendered thumbnail rather than the original: a 40 MB
/// panorama would otherwise be decoded in full by the WebView on every arrow
/// key press in Quick Look.
const IMAGE_FULL_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NoPreviewReason {
    /// A cloud placeholder. Opening it would trigger a synchronous download.
    NotDownloaded,
    /// The container is playable but the codec inside is not.
    CodecUnsupported,
    UnsupportedFormat,
    TooLarge,
    DecodeFailed,
    NoAccess,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum PreviewPlan {
    /// Show the original file directly; the WebView decodes it.
    Image { path: String, width: u32, height: u32, bytes: u64 },
    /// Show a pre-rendered cached thumbnail instead of the original.
    ImageThumb { path: String, width: u32, height: u32, source_width: u32, source_height: u32 },
    Video { path: String, mime: String, poster: Option<String> },
    Audio { path: String, mime: String },
    Pdf { path: String },
    Text { head: TextHead },
    Folder { child_count: Option<u64> },
    None { reason: NoPreviewReason },
}

/// Which broad treatment an extension gets. Mirrored in the frontend only for
/// layout choices; the authority is here.
fn mime_for(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        _ => return None,
    })
}

/// Formats the `image` crate handles, given the features we enabled.
fn is_decodable_image(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "jpe" | "gif" | "webp" | "bmp" | "ico" | "tif" | "tiff"
    )
}

/// Formats Chromium renders itself, so the original goes straight to an `<img>`.
fn is_native_image(ext: &str) -> bool {
    // SVG goes through `<img>` rather than inline markup: in an `<img>` it
    // cannot execute script.
    matches!(ext, "svg" | "avif")
}

fn is_text_like(ext: &str) -> bool {
    matches!(
        ext,
        "txt" | "md" | "markdown" | "rst" | "log" | "csv" | "tsv" | "json" | "jsonc" | "json5"
            | "yml" | "yaml" | "toml" | "ini" | "cfg" | "conf" | "env" | "xml" | "html" | "htm"
            | "css" | "scss" | "sass" | "less" | "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx"
            | "cts" | "rs" | "go" | "py" | "rb" | "php" | "java" | "kt" | "kts" | "swift" | "c"
            | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hh" | "cs" | "fs" | "vb" | "lua" | "pl"
            | "sh" | "bash" | "zsh" | "fish" | "ps1" | "psm1" | "bat" | "cmd" | "sql" | "graphql"
            | "gql" | "proto" | "vue" | "svelte" | "astro" | "dart" | "ex" | "exs" | "erl"
            | "hs" | "ml" | "nim" | "zig" | "clj" | "scala" | "r" | "jl" | "diff" | "patch"
            | "gitignore" | "gitattributes" | "editorconfig" | "lock"
    )
}

/// Names that are text despite having no extension.
fn is_text_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "makefile" | "dockerfile" | "license" | "readme" | "changelog" | "authors" | "notice"
    ) || lower.starts_with('.')
}

/// Sniff an MP4 or MOV container for an HEVC track.
///
/// WebView2 is Chromium, so it plays H.264 and VP8/VP9 but not HEVC. Getting
/// this wrong shows the user a black box with a spinner forever, which reads as
/// a bug in our app rather than a missing codec -- hence the sniff instead of
/// trusting the extension.
fn has_unsupported_video_codec(path: &Path, ext: &str) -> bool {
    if !matches!(ext, "mp4" | "m4v" | "mov") {
        return false;
    }
    let Ok(bytes) = read_prefix(path, 96 * 1024) else { return false };
    // Sample-entry codes appear literally in the `stsd` box.
    for needle in [b"hvc1".as_slice(), b"hev1".as_slice(), b"dvh1".as_slice(), b"dvhe".as_slice()] {
        if bytes.windows(4).any(|w| w == needle) {
            return true;
        }
    }
    false
}

fn read_prefix(path: &Path, len: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let mut buf = Vec::new();
    std::io::BufReader::new(file).take(len).read_to_end(&mut buf)?;
    Ok(buf)
}

pub struct PlanRequest<'a> {
    pub path: &'a Path,
    pub max_px: u32,
    pub flags: u16,
    pub is_dir: bool,
    /// Set when the user explicitly asked to download a cloud placeholder.
    pub allow_hydrate: bool,
}

pub fn plan(req: PlanRequest<'_>, cache: &cache::ThumbCache) -> Result<PreviewPlan, FsError> {
    let path = req.path;

    if req.is_dir {
        let child_count = std::fs::read_dir(path).ok().map(|rd| rd.count() as u64);
        return Ok(PreviewPlan::Folder { child_count });
    }

    // A OneDrive placeholder must never be opened for preview: reading it
    // triggers a synchronous download of a possibly-gigabyte file.
    if !req.allow_hydrate && req.flags & (attr::CLOUD_STUB | attr::OFFLINE) != 0 {
        return Ok(PreviewPlan::None { reason: NoPreviewReason::NotDownloaded });
    }

    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    let display = crate::paths::to_display(path);
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    if ext == "pdf" {
        // WebView2 ships Edge's PDF viewer, so there is nothing to implement.
        return Ok(PreviewPlan::Pdf { path: display });
    }

    if let Some(mime) = mime_for(&ext) {
        if mime.starts_with("audio/") {
            return Ok(PreviewPlan::Audio { path: display, mime: mime.to_string() });
        }
        if has_unsupported_video_codec(path, &ext) {
            return Ok(PreviewPlan::None { reason: NoPreviewReason::CodecUnsupported });
        }
        return Ok(PreviewPlan::Video { path: display, mime: mime.to_string(), poster: None });
    }

    // Containers Chromium cannot play at all.
    if matches!(
        ext.as_str(),
        "mkv" | "avi" | "wmv" | "flv" | "mpg" | "mpeg" | "m2ts" | "mts" | "ts" | "3gp"
    ) {
        return Ok(PreviewPlan::None { reason: NoPreviewReason::CodecUnsupported });
    }

    if is_native_image(&ext) {
        return Ok(PreviewPlan::Image { path: display, width: 0, height: 0, bytes: size });
    }

    if is_decodable_image(&ext) {
        let (w, h) = decode::dimensions(path).unwrap_or((0, 0));
        // Small enough to hand over whole: fewer moving parts, full fidelity.
        if size <= IMAGE_FULL_MAX_BYTES && w > 0 {
            return Ok(PreviewPlan::Image { path: display, width: w, height: h, bytes: size });
        }
        return match cache.get_or_create(path, req.max_px) {
            Ok((thumb, dims)) => Ok(PreviewPlan::ImageThumb {
                path: crate::paths::to_display(&thumb),
                width: dims.width,
                height: dims.height,
                source_width: w,
                source_height: h,
            }),
            Err(e) if e.code == ErrCode::AccessDenied => {
                Ok(PreviewPlan::None { reason: NoPreviewReason::NoAccess })
            }
            Err(e) if e.code == ErrCode::Unsupported => {
                Ok(PreviewPlan::None { reason: NoPreviewReason::TooLarge })
            }
            Err(_) => Ok(PreviewPlan::None { reason: NoPreviewReason::DecodeFailed }),
        };
    }

    if is_text_like(&ext) || (ext.is_empty() && is_text_name(&name)) {
        let head = text::read_head(path, None)?;
        if head.is_binary {
            return Ok(PreviewPlan::None { reason: NoPreviewReason::UnsupportedFormat });
        }
        return Ok(PreviewPlan::Text { head });
    }

    Ok(PreviewPlan::None { reason: NoPreviewReason::UnsupportedFormat })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("finder-fm-plan-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("fixture dir");
        p
    }

    fn cache_for(root: &Path) -> cache::ThumbCache {
        cache::ThumbCache::new(root.join("thumbs"))
    }

    fn req<'a>(path: &'a Path) -> PlanRequest<'a> {
        PlanRequest { path, max_px: 512, flags: 0, is_dir: false, allow_hydrate: false }
    }

    #[test]
    fn plans_a_text_file() {
        let root = dir("text");
        let f = root.join("notes.md");
        std::fs::write(&f, "# Title\n\nbody\n").expect("write");
        match plan(req(&f), &cache_for(&root)).expect("plan") {
            PreviewPlan::Text { head } => {
                assert!(head.text.contains("# Title"));
                assert_eq!(head.encoding, "utf-8");
            }
            other => panic!("expected Text, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn plans_an_extensionless_dotfile_as_text() {
        let root = dir("dotfile");
        let f = root.join(".gitignore");
        std::fs::write(&f, "node_modules\n").expect("write");
        assert!(matches!(
            plan(req(&f), &cache_for(&root)).expect("plan"),
            PreviewPlan::Text { .. }
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn plans_a_small_image_as_the_original() {
        let root = dir("smallimg");
        let f = root.join("a.png");
        image::RgbImage::new(60, 40).save(&f).expect("write png");
        match plan(req(&f), &cache_for(&root)).expect("plan") {
            PreviewPlan::Image { width, height, .. } => assert_eq!((width, height), (60, 40)),
            other => panic!("expected Image, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn plans_a_pdf_for_the_built_in_viewer() {
        let root = dir("pdf");
        let f = root.join("doc.pdf");
        std::fs::write(&f, b"%PDF-1.7\n").expect("write");
        assert!(matches!(plan(req(&f), &cache_for(&root)).expect("plan"), PreviewPlan::Pdf { .. }));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn plans_audio_and_video_by_mime() {
        let root = dir("media");
        let a = root.join("song.mp3");
        std::fs::write(&a, b"\xFF\xFB\x00\x00").expect("write");
        match plan(req(&a), &cache_for(&root)).expect("plan") {
            PreviewPlan::Audio { mime, .. } => assert_eq!(mime, "audio/mpeg"),
            other => panic!("expected Audio, got {other:?}"),
        }

        let v = root.join("clip.mp4");
        std::fs::write(&v, b"\x00\x00\x00\x18ftypmp42").expect("write");
        match plan(req(&v), &cache_for(&root)).expect("plan") {
            PreviewPlan::Video { mime, .. } => assert_eq!(mime, "video/mp4"),
            other => panic!("expected Video, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_hevc_rather_than_showing_a_black_box_forever() {
        let root = dir("hevc");
        let v = root.join("clip.mp4");
        let mut bytes = b"\x00\x00\x00\x18ftypmp42".to_vec();
        bytes.extend_from_slice(&[0u8; 64]);
        bytes.extend_from_slice(b"stsdhvc1");
        std::fs::write(&v, &bytes).expect("write");

        match plan(req(&v), &cache_for(&root)).expect("plan") {
            PreviewPlan::None { reason } => {
                assert!(matches!(reason, NoPreviewReason::CodecUnsupported))
            }
            other => panic!("expected None(CodecUnsupported), got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_containers_chromium_cannot_play() {
        let root = dir("mkv");
        let v = root.join("clip.mkv");
        std::fs::write(&v, b"\x1A\x45\xDF\xA3").expect("write");
        match plan(req(&v), &cache_for(&root)).expect("plan") {
            PreviewPlan::None { reason } => {
                assert!(matches!(reason, NoPreviewReason::CodecUnsupported))
            }
            other => panic!("expected None(CodecUnsupported), got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn never_opens_a_cloud_placeholder() {
        let root = dir("cloud");
        let f = root.join("huge.png");
        std::fs::write(&f, b"not really a png").expect("write");

        let plan_result = plan(
            PlanRequest { path: &f, max_px: 512, flags: attr::CLOUD_STUB, is_dir: false, allow_hydrate: false },
            &cache_for(&root),
        )
        .expect("plan");
        match plan_result {
            PreviewPlan::None { reason } => {
                assert!(matches!(reason, NoPreviewReason::NotDownloaded))
            }
            other => panic!("expected None(NotDownloaded), got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn plans_a_folder_with_its_child_count() {
        let root = dir("folder");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).expect("mkdir");
        std::fs::write(sub.join("a.txt"), b"x").expect("write");
        std::fs::write(sub.join("b.txt"), b"x").expect("write");

        match plan(
            PlanRequest { path: &sub, max_px: 512, flags: 0, is_dir: true, allow_hydrate: false },
            &cache_for(&root),
        )
        .expect("plan")
        {
            PreviewPlan::Folder { child_count } => assert_eq!(child_count, Some(2)),
            other => panic!("expected Folder, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reports_an_unknown_extension_honestly() {
        let root = dir("unknown");
        let f = root.join("thing.xyzzy");
        std::fs::write(&f, b"data").expect("write");
        match plan(req(&f), &cache_for(&root)).expect("plan") {
            PreviewPlan::None { reason } => {
                assert!(matches!(reason, NoPreviewReason::UnsupportedFormat))
            }
            other => panic!("expected None(UnsupportedFormat), got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn treats_a_text_extension_holding_binary_as_unpreviewable() {
        let root = dir("binarytxt");
        let f = root.join("weird.txt");
        std::fs::write(&f, [0x00, 0x01, 0x02, 0x03]).expect("write");
        match plan(req(&f), &cache_for(&root)).expect("plan") {
            PreviewPlan::None { reason } => {
                assert!(matches!(reason, NoPreviewReason::UnsupportedFormat))
            }
            other => panic!("expected None, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
