/**
 * Human-readable "Kind" labels.
 *
 * Owned by the frontend, not sent per row: at 50,000 entries a per-entry label
 * string is megabytes of duplicated JSON. The wording follows Finder ("PNG
 * image") rather than Explorer ("PNG File"), which is the whole point of not
 * asking the shell for it.
 */

import type { Category, DirEntry } from "../ipc/types";

const BY_EXT: Record<string, string> = {
  // images
  png: "PNG image",
  jpg: "JPEG image",
  jpeg: "JPEG image",
  gif: "GIF image",
  webp: "WebP image",
  bmp: "Bitmap image",
  tif: "TIFF image",
  tiff: "TIFF image",
  svg: "SVG image",
  ico: "Icon",
  heic: "HEIC image",
  avif: "AVIF image",
  psd: "Photoshop document",
  dng: "Digital negative",
  cr2: "Canon raw image",
  cr3: "Canon raw image",
  nef: "Nikon raw image",
  arw: "Sony raw image",

  // video and audio
  mp4: "MPEG-4 movie",
  m4v: "MPEG-4 movie",
  mov: "QuickTime movie",
  mkv: "Matroska movie",
  webm: "WebM movie",
  avi: "AVI movie",
  wmv: "Windows Media video",
  mts: "AVCHD video",
  m2ts: "AVCHD video",
  mp3: "MP3 audio",
  m4a: "MPEG-4 audio",
  aac: "AAC audio",
  wav: "Waveform audio",
  flac: "FLAC audio",
  ogg: "Ogg audio",
  opus: "Opus audio",
  wma: "Windows Media audio",

  // documents
  pdf: "PDF document",
  txt: "Plain text document",
  md: "Markdown document",
  markdown: "Markdown document",
  rtf: "Rich text document",
  csv: "Comma-separated values",
  tsv: "Tab-separated values",
  log: "Log file",
  doc: "Word document",
  docx: "Word document",
  odt: "OpenDocument text",
  xls: "Excel workbook",
  xlsx: "Excel workbook",
  ods: "OpenDocument spreadsheet",
  ppt: "PowerPoint presentation",
  pptx: "PowerPoint presentation",
  odp: "OpenDocument presentation",
  epub: "EPUB book",

  // archives and packages
  zip: "ZIP archive",
  rar: "RAR archive",
  "7z": "7-Zip archive",
  tar: "TAR archive",
  gz: "Gzip archive",
  tgz: "Gzip archive",
  bz2: "Bzip2 archive",
  xz: "XZ archive",
  zst: "Zstandard archive",
  cab: "Cabinet archive",
  msi: "Windows installer package",
  msix: "MSIX package",
  appx: "APPX package",
  apk: "Android package",
  jar: "Java archive",
  whl: "Python wheel",
  nupkg: "NuGet package",
  vsix: "VS Code extension",

  // code and config
  js: "JavaScript source",
  mjs: "JavaScript module",
  cjs: "CommonJS module",
  jsx: "JavaScript JSX source",
  ts: "TypeScript source",
  tsx: "TypeScript JSX source",
  json: "JSON document",
  html: "HTML document",
  htm: "HTML document",
  css: "CSS style sheet",
  scss: "Sass style sheet",
  rs: "Rust source",
  go: "Go source",
  py: "Python source",
  rb: "Ruby source",
  php: "PHP source",
  java: "Java source",
  kt: "Kotlin source",
  swift: "Swift source",
  c: "C source",
  h: "C header",
  cpp: "C++ source",
  hpp: "C++ header",
  cs: "C# source",
  lua: "Lua source",
  sh: "Shell script",
  bash: "Shell script",
  ps1: "PowerShell script",
  bat: "Batch file",
  cmd: "Batch file",
  yml: "YAML document",
  yaml: "YAML document",
  toml: "TOML document",
  ini: "Configuration file",
  cfg: "Configuration file",
  conf: "Configuration file",
  xml: "XML document",
  sql: "SQL script",

  // system
  exe: "Application",
  dll: "Dynamic link library",
  sys: "System file",
  lnk: "Shortcut",
  url: "Internet shortcut",
  ttf: "TrueType font",
  otf: "OpenType font",
  woff: "Web font",
  woff2: "Web font",
  iso: "Disc image",
  vhd: "Virtual hard disk",
  vhdx: "Virtual hard disk",
  dmg: "Disk image",
};

/** Fallback wording per category, for extensions the table does not know. */
const BY_CATEGORY: Record<Category, string> = {
  folder: "Folder",
  volume: "Volume",
  image: "Image",
  video: "Movie",
  audio: "Audio",
  pdf: "PDF document",
  text: "Text document",
  code: "Source file",
  archive: "Archive",
  document: "Document",
  spreadsheet: "Spreadsheet",
  presentation: "Presentation",
  font: "Font",
  executable: "Application",
  shortcut: "Shortcut",
  disk: "Disc image",
  package: "Package",
  unknown: "Document",
};

/** Some names are recognised whole, having no extension at all. */
const BY_NAME: Record<string, string> = {
  makefile: "Makefile",
  dockerfile: "Dockerfile",
  ".gitignore": "Git ignore file",
  ".gitattributes": "Git attributes file",
  ".editorconfig": "EditorConfig file",
  ".npmrc": "npm configuration",
  ".env": "Environment file",
  license: "License",
  readme: "Readme",
};

export function kindLabel(entry: Pick<DirEntry, "name" | "ext" | "isDir" | "category">): string {
  if (entry.isDir) return "Folder";

  const whole = BY_NAME[entry.name.toLowerCase()];
  if (whole) return whole;

  const byExt = BY_EXT[entry.ext];
  if (byExt) return byExt;

  // An unknown extension still reads better spelled out than as a bare
  // category: "XYZ document" beats "Document".
  if (entry.ext !== "" && entry.ext.length <= 6) {
    return `${entry.ext.toUpperCase()} ${BY_CATEGORY[entry.category].toLowerCase()}`;
  }
  return BY_CATEGORY[entry.category];
}
