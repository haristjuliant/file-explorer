# Finder

A Windows file manager that looks and behaves like macOS Finder, with three view
modes: **List**, **Column** (Finder's column browser), and **Tree** (Nemo-style
expandable rows).

Built with Tauri 2, React 19 and TypeScript. No UI framework — plain CSS custom
properties, because the Finder look needs precise control.

---

## Download

| | |
|---|---|
| **Installer** | [`release/Finder_0.1.0_x64-setup.exe`](release/Finder_0.1.0_x64-setup.exe) — 2.6 MB, installs per-user, no administrator rights needed |
| **Portable** | [`release/file-manager.exe`](release/file-manager.exe) — 11 MB, self-contained, run it from anywhere |

Windows 10 or 11, 64-bit. WebView2 is already present on Windows 11; on older
builds the installer fetches it automatically.

> **Windows will warn you the first time.** The executable is not code-signed,
> so SmartScreen shows *"Windows protected your PC"*. Click **More info** →
> **Run anyway**. Removing that warning requires an Authenticode certificate,
> which this project does not have.

---

## Building it yourself


```powershell
npm install
npm run tauri dev      # development, with hot reload
npm run tauri build    # release build and NSIS installer
```

The installer lands in `src-tauri/target/release/bundle/nsis/`.

Prerequisites: Node 20.19+ or 22.12+, the Rust `x86_64-pc-windows-msvc`
toolchain, and VS Build Tools with the C++ workload. WebView2 ships with
Windows 11.

## Checks

```powershell
npm test               # frontend unit and integration tests
npm run typecheck      # tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
```

### Benchmarks

Synthetic-tree benchmarks live in `src-tauri/src/bench.rs`. They are `#[ignore]`d
because they build a 100,000-entry directory, so run them deliberately:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --release -- --ignored --nocapture
```

Measured on the development machine (NVMe, Windows 11), for comparison rather
than as a target:

| Entries | Wall time | Per entry |
|--------:|----------:|----------:|
| 10 | 415 us | 41.5 us |
| 1,000 | 3.0 ms | 2.97 us |
| 100,000 | 154 ms | 1.54 us |

Per-entry cost *falling* as the directory grows is the point: it confirms the
fixed cost is the directory open, and that no per-entry syscall has crept into
the hot loop. Metadata, attributes, size and timestamps all come free from the
enumeration itself. The assertion in `read_dir_scales_linearly_...` fails if
that ever stops being true.

---

## What it does

| | |
|---|---|
| **Navigate** | Sidebar (known folders + drives), breadcrumb, back/forward, `Ctrl+L` to type a path |
| **List view** | Sortable, resizable columns; virtualized; marquee selection |
| **Column view** | A column per level, trailing file preview, per-column resize |
| **Tree view** | One flat virtualized list with disclosure triangles |
| **Quick Look** | `Space` to preview, arrow keys to step between files |
| **File operations** | Copy, cut, paste, rename, duplicate, new folder, delete to Recycle Bin, **undo** |
| **Search** | Instant filter, plus streaming recursive search (`Ctrl+Shift+F`) |
| **Preview pane** | Images, PDF, video, audio, text, folder contents |

`Ctrl+/` shows the full keyboard reference, generated from the binding table.

---

## How it is put together

```
src/
  ipc/        typed invoke wrappers; the ONLY place paths cross to Rust
  order/      the OrderSource registry -- see below
  store/      appStore (UI), fsStore (directory cache), opsStore, searchStore
  keys/       one declarative keymap, one global handler
  lib/        pure functions: path, sort, format, treeFlatten, kind
  views/      ListView, ColumnView, TreeView, SearchView
src-tauri/src/
  fs/         directory reading, name rules, conflicts, the transfer engine
  preview/    decode, EXIF orientation, text sniffing, thumbnail cache
  jobs/       job registry, cancellation, throttled progress
  undo/       the undo stack (in Rust, not the frontend)
  watch/      refcounted watchers and the event coalescer
  win/        Win32: drives, known folders, shell execute, caption hit-test
```

### The one idea worth knowing: `OrderSource`

Quick Look must step between files with the arrow keys identically in every
view, but the list of navigable siblings differs: in list view it is the sorted
directory, in column view the column holding the cursor, in tree view the
depth-first flattening of visible rows, and in search it is the results.

So the active view registers an imperative `OrderSource` in module state and the
store holds only a version counter. Everything else — the keyboard handler,
selection maths, Quick Look — reads that one ordered list and knows nothing
about which view is underneath. A view implements three small callbacks
(`onArrowLeft`, `onArrowRight`, `activateDir`) and inherits roughly forty
shortcuts.

`tests/quickLookContract.tsx` holds a single routine that all four views run
verbatim. Quick Look has not changed a line since it was written for list view.

---

## Decisions worth knowing before changing things

**Sorting and filtering happen in the frontend.** The backend returns entries
unsorted, capped at 50,000 with a `truncated` flag. Paging from Rust would mean
`visibleOrder` no longer knows the complete order, which breaks Ctrl+A,
shift-ranges spanning an unloaded gap, and Quick Look stepping past the loaded
window.

**The backend never filters hidden or system entries.** It returns everything
with flags set, so `Ctrl+H` costs no IPC and the cache key stays a bare path.

**The undo stack lives in Rust.** It holds Recycle Bin references only
`trash::os_limited` can act on, it must survive a webview reload, and
preconditions are revalidated against the filesystem at undo time.

**Replace sends the victim to the Recycle Bin first.** That costs one trash call
and makes the most destructive operation in a file manager recoverable.
`ReplaceInPlace` exists as an explicit opt-out and pushes a *tombstone* onto the
undo stack, so `Ctrl+Z` explains itself rather than silently undoing the
operation before it.

**Conflicts are resolved before the job starts**, in one dialog for the whole
transfer. Mid-job round trips would park a worker on a channel whose other end
can vanish, and merging a folder with three hundred same-named files would mean
three hundred modals.

**A watcher event triggers a full re-read**, never a delta. `notify` on Windows
drops and reorders events under load, and a delta-only frontend would desync.

**Rows subscribe to their own booleans, never to the selection `Set`.** Ten
thousand rows watching an `Object.is`-stable boolean is far cheaper than ten
thousand rows woken by a new `Set` reference. This is the single most important
performance decision in the frontend.

**Every `#[tauri::command]` is `async` and hands off to `spawn_blocking`.** A
sync command runs on the event-loop thread, so a 200 ms directory read there is
a 200 ms UI freeze.

---

## Known limits

- **Icons** are bundled SVGs chosen by extension category, so every `.exe` in
  Program Files shares one glyph. Real shell icons would need `SHGetFileInfoW`
  and would make the app look like Explorer rather than Finder.
- **No tabs.**
- **The context menu is our own**, not the Windows shell menu. Integrating
  `IContextMenu` means loading third-party shell extensions in-process, the
  leading cause of hangs in Windows file managers.
- **Drag and drop works inside the app only.** Accepting drops from Explorer
  requires `dragDropEnabled: true`, which suppresses HTML5 drag events in the
  webview; dragging out needs `IDataObject`.
- **No thumbnails for RAW, HEIC, PSD or video frames**, and no AVIF decoding in
  Rust. `preview_plan` reports these as unsupported rather than pretending.
- **HEVC video cannot play**, because WebView2 is Chromium. The container is
  sniffed so the UI says so instead of showing a black box with a spinner.
- **No redo.** Half-working redo is worse than none.

---

## Licence

MIT. See [LICENSE](LICENSE).
