//! Extension -> `Category` mapping. Category drives icon selection only; the
//! human-readable "Kind" label lives in the frontend so it never costs a
//! per-row string in the payload.

use crate::ipc::{attr, Category};

/// Lowercase extension without the dot. Empty for directories, for
/// extensionless files, and for dotfiles (`.gitignore` has no extension --
/// `gitignore` is its whole name as far as users are concerned).
pub fn ext_of(name: &str, is_dir: bool) -> String {
    if is_dir {
        return String::new();
    }
    match name.rfind('.') {
        // A leading dot at position 0 is a dotfile, not an extension.
        Some(0) | None => String::new(),
        Some(i) => name[i + 1..].to_ascii_lowercase(),
    }
}

pub fn of(is_dir: bool, ext: &str, flags: u16) -> Category {
    if is_dir {
        return Category::Folder;
    }
    if flags & attr::SYMLINK != 0 && ext == "lnk" {
        return Category::Shortcut;
    }
    match ext {
        // images
        "png" | "jpg" | "jpeg" | "jpe" | "gif" | "bmp" | "webp" | "tif" | "tiff" | "ico"
        | "svg" | "avif" | "heic" | "heif" | "psd" | "ai" | "raw" | "cr2" | "cr3" | "nef"
        | "arw" | "dng" | "orf" | "rw2" | "qoi" | "jxl" => Category::Image,

        // video
        //
        // Two extensions are genuinely ambiguous and are split on likelihood:
        //   .ts  -> TypeScript (below), not MPEG transport stream
        //   .mts -> AVCHD camcorder video (here), not a TypeScript module
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi" | "wmv" | "flv" | "mpg" | "mpeg"
        | "m2ts" | "mts" | "3gp" | "ogv" => Category::Video,

        // audio
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "oga" | "opus" | "wma" | "aiff"
        | "aif" | "alac" | "mid" | "midi" => Category::Audio,

        "pdf" => Category::Pdf,

        // plain text / markup / data
        "txt" | "md" | "markdown" | "rst" | "log" | "csv" | "tsv" | "rtf" | "tex" | "nfo" => {
            Category::Text
        }

        // code and configuration
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "cts" | "json" | "jsonc"
        | "json5" | "html" | "htm" | "xhtml" | "css" | "scss" | "sass" | "less" | "rs"
        | "go" | "py" | "pyi" | "rb" | "php" | "java" | "kt" | "kts" | "swift" | "c" | "h"
        | "cpp" | "cc" | "cxx" | "hpp" | "hh" | "cs" | "fs" | "vb" | "lua" | "pl" | "sh"
        | "bash" | "zsh" | "fish" | "ps1" | "psm1" | "bat" | "cmd" | "yml" | "yaml" | "toml"
        | "ini" | "cfg" | "conf" | "env" | "xml" | "sql" | "graphql" | "gql" | "proto"
        | "vue" | "svelte" | "astro" | "dart" | "ex" | "exs" | "erl" | "hs" | "ml" | "nim"
        | "zig" | "clj" | "scala" | "r" | "jl" | "asm" | "s" | "make" | "mk" | "cmake"
        | "gradle" | "dockerfile" | "diff" | "patch" | "lock" => Category::Code,

        // archives
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "tbz" | "xz" | "txz" | "zst"
        | "lz4" | "lzma" | "cab" | "arj" | "z" => Category::Archive,

        // documents
        "doc" | "docx" | "docm" | "odt" | "pages" | "epub" | "mobi" | "azw3" | "djvu"
        | "chm" | "xps" | "one" => Category::Document,

        "xls" | "xlsx" | "xlsm" | "xlsb" | "ods" | "numbers" => Category::Spreadsheet,
        "ppt" | "pptx" | "pptm" | "odp" | "key" => Category::Presentation,

        "ttf" | "otf" | "woff" | "woff2" | "eot" | "fon" | "pfb" | "pfm" => Category::Font,

        "exe" | "com" | "scr" | "dll" | "sys" | "ocx" | "cpl" | "ax" | "efi" => {
            Category::Executable
        }

        "lnk" | "url" | "appref-ms" | "desktop" => Category::Shortcut,

        "iso" | "img" | "vhd" | "vhdx" | "vmdk" | "dmg" | "bin" | "cue" | "mdf" | "nrg" => {
            Category::Disk
        }

        "msi" | "msix" | "appx" | "appxbundle" | "msixbundle" | "deb" | "rpm" | "apk"
        | "pkg" | "crx" | "vsix" | "nupkg" | "whl" | "jar" => Category::Package,

        _ => Category::Unknown,
    }
}
