/**
 * Windows path identity -- the single invariant everything else rests on.
 *
 * Every cache key, `Set` membership test, expanded-tree entry, column-chain
 * element, selection member and watcher key is a path string. Windows names one
 * object many ways: forward or back slashes, either drive-letter case, with or
 * without a trailing separator, and optionally behind a verbatim prefix.
 *
 * The moment two spellings of one path coexist you get a phantom duplicate
 * column, an expanded tree node that will not collapse, or a watcher that is
 * never released. So `normalize()` is applied at the IPC boundary and NOTHING
 * else in the app constructs a path except through this module.
 *
 * Case-insensitive comparison is for user-typed input only (Ctrl+L, rename) --
 * never for internal keys. Mixing the two policies is how this goes wrong.
 */

/** A single backslash. */
export const SEP = "\\";

const DRIVE_ROOT_RE = /^[A-Za-z]:\\$/;
const DRIVE_ONLY_RE = /^[A-Za-z]:$/;
const DRIVE_PREFIX_RE = /^[A-Za-z]:\\/;
const LOWER_DRIVE_RE = /^[a-z]:/;
const UNC_ROOT_RE = /^\\\\[^\\]+\\[^\\]+$/;
const FORWARD_SLASH_RE = /\//g;
const REPEATED_SEP_RE = /\\{2,}/g;

/** Two leading backslashes, i.e. a UNC path. */
const UNC_PREFIX = "\\\\";
/** The verbatim prefix, four characters. */
const VERBATIM_PREFIX = "\\\\?\\";
/** The verbatim UNC prefix, eight characters. */
const VERBATIM_UNC_PREFIX = "\\\\?\\UNC\\";

/** True for a drive root such as `C:` followed by a separator. */
export function isDriveRoot(p: string): boolean {
  return DRIVE_ROOT_RE.test(p);
}

/** True for a bare UNC share root (server plus share, no further components). */
export function isUncRoot(p: string): boolean {
  return UNC_ROOT_RE.test(p);
}

/** True when the path has no parent. */
export function isRoot(p: string): boolean {
  return isDriveRoot(p) || isUncRoot(p);
}

/** True when the path lives on a UNC share. */
export function isUnc(p: string): boolean {
  return p.startsWith(UNC_PREFIX);
}

/**
 * The canonical form used as a key everywhere.
 *
 *   - forward slashes become backslashes
 *   - repeated separators collapse, but a leading UNC prefix is preserved
 *   - the drive letter is upper-cased
 *   - a trailing separator is stripped, except on a drive root where the
 *     separator is part of the canonical spelling
 */
export function normalize(input: string): string {
  let p = input.trim().replace(FORWARD_SLASH_RE, SEP);
  if (p === "") return p;

  // Strip a verbatim prefix if one ever leaks in; the rest of the app must
  // never see it.
  if (p.startsWith(VERBATIM_UNC_PREFIX)) {
    p = UNC_PREFIX + p.slice(VERBATIM_UNC_PREFIX.length);
  } else if (p.startsWith(VERBATIM_PREFIX)) {
    p = p.slice(VERBATIM_PREFIX.length);
  }

  const unc = p.startsWith(UNC_PREFIX);
  const body = unc ? p.slice(UNC_PREFIX.length) : p;
  p = (unc ? UNC_PREFIX : "") + body.replace(REPEATED_SEP_RE, SEP);

  // Upper-case the drive letter so two casings cannot fork a cache key.
  if (LOWER_DRIVE_RE.test(p)) p = p[0].toUpperCase() + p.slice(1);

  // A bare `C:` means "current directory on C:", which we never want.
  if (DRIVE_ONLY_RE.test(p)) return p + SEP;

  if (p.length > 3 && p.endsWith(SEP) && !isDriveRoot(p)) p = p.slice(0, -1);
  return p;
}

/** Dev-only tripwire, called on every path value crossing back from Rust. */
export function assertCanonical(p: string): string {
  if (import.meta.env.DEV) {
    const n = normalize(p);
    if (n !== p) {
      // eslint-disable-next-line no-console
      console.error(
        `[path] non-canonical path from backend: ${JSON.stringify(p)} !== ${JSON.stringify(n)}`,
      );
    }
  }
  return p;
}

/** Parent directory, or `null` at a drive or share root. */
export function parentOf(p: string): string | null {
  const n = normalize(p);
  if (n === "" || isRoot(n)) return null;

  const i = n.lastIndexOf(SEP);
  if (i < 0) return null;

  // A parent that is a drive root keeps its trailing separator.
  if (i === 2 && DRIVE_PREFIX_RE.test(n)) return n.slice(0, 3);

  const parent = n.slice(0, i);
  if (parent === "") return null;
  // Never walk above a share root into a bare server name.
  if (isUnc(parent) && !isUncRoot(parent)) {
    const parts = parent.slice(UNC_PREFIX.length).split(SEP).filter(Boolean);
    if (parts.length < 2) return null;
  }
  return parent;
}

/** Join a directory and a single child name. */
export function join(dir: string, name: string): string {
  const d = normalize(dir);
  if (d === "") return normalize(name);
  return normalize(d.endsWith(SEP) ? d + name : d + SEP + name);
}

/** The absolute path of a `DirEntry`, which carries only its name. */
export function entryPath(dir: string, entry: { name: string }): string {
  return join(dir, entry.name);
}

/** Last component, or the root itself at a drive root. */
export function basename(p: string): string {
  const n = normalize(p);
  if (isDriveRoot(n)) return n;
  const i = n.lastIndexOf(SEP);
  return i < 0 ? n : n.slice(i + 1);
}

export interface Segment {
  label: string;
  path: string;
}

/**
 * Breadcrumb segments, each carrying the path to navigate to. A UNC share
 * counts as one leading segment, because navigating to a bare server name is
 * not a thing the file list can show.
 */
export function segments(p: string): Segment[] {
  const n = normalize(p);
  if (n === "") return [];

  const out: Segment[] = [];

  if (isUnc(n)) {
    const parts = n.slice(UNC_PREFIX.length).split(SEP).filter(Boolean);
    if (parts.length < 2) return out;
    let acc = UNC_PREFIX + parts[0] + SEP + parts[1];
    out.push({ label: acc, path: acc });
    for (const part of parts.slice(2)) {
      acc = acc + SEP + part;
      out.push({ label: part, path: acc });
    }
    return out;
  }

  const parts = n.split(SEP).filter(Boolean);
  if (parts.length === 0) return out;
  out.push({ label: parts[0], path: parts[0] + SEP });
  let acc = parts[0] + SEP;
  for (const part of parts.slice(1)) {
    acc = acc.endsWith(SEP) ? acc + part : acc + SEP + part;
    out.push({ label: part, path: acc });
  }
  return out;
}

/**
 * True when `child` is inside `ancestor`, or is `ancestor` itself.
 *
 * The separator in the prefix check is what stops a sibling with a shared
 * name prefix from counting as a descendant.
 */
export function isInside(ancestor: string, child: string): boolean {
  const a = normalize(ancestor).toLowerCase();
  const c = normalize(child).toLowerCase();
  if (a === c) return true;
  const prefix = a.endsWith(SEP) ? a : a + SEP;
  return c.startsWith(prefix);
}

/** How deep a path sits below its root. A root itself is depth 0. */
export function depthOf(p: string): number {
  return Math.max(0, segments(p).length - 1);
}

/** For comparing user-typed paths only -- never for keys. */
export function equalsIgnoreCase(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase();
}
