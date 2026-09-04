import { describe, expect, it } from "vitest";

import type { DirEntry } from "../ipc/types";
import { Attr } from "../ipc/types";
import type { DirState } from "../store/fsStore";
import { flattenTree, MAX_DEPTH, rowIndexOf } from "./treeFlatten";
import type { VisibleOptions } from "./sort";

const D = "\\";
const ROOT = `C:${D}R`;

function entry(name: string, over: Partial<DirEntry> = {}): DirEntry {
  return {
    name,
    isDir: false,
    flags: 0,
    size: 1,
    modifiedMs: 0,
    ext: "txt",
    category: "text",
    ...over,
  };
}

const folder = (name: string) =>
  entry(name, { isDir: true, category: "folder", ext: "", size: 0 });

function ready(path: string, entries: DirEntry[]): DirState {
  return {
    path,
    status: "ready",
    entries,
    error: null,
    total: entries.length,
    truncated: false,
    loadedAt: Date.now(),
    generation: 1,
  };
}

function loading(path: string): DirState {
  return { ...ready(path, []), status: "loading", generation: 0 };
}

const OPTS: VisibleOptions = {
  showHidden: false,
  showSystem: false,
  filter: "",
  sortKey: "name",
  sortDir: 1,
};

/**
 *  C:\R
 *   ├─ Docs
 *   │   ├─ Deep
 *   │   │   └─ deep.txt
 *   │   └─ a.txt
 *   ├─ Pics
 *   │   └─ p.png
 *   └─ root.txt
 */
function tree(): Map<string, DirState> {
  return new Map([
    [ROOT, ready(ROOT, [folder("Docs"), folder("Pics"), entry("root.txt")])],
    [`${ROOT}${D}Docs`, ready(`${ROOT}${D}Docs`, [folder("Deep"), entry("a.txt")])],
    [`${ROOT}${D}Docs${D}Deep`, ready(`${ROOT}${D}Docs${D}Deep`, [entry("deep.txt")])],
    [`${ROOT}${D}Pics`, ready(`${ROOT}${D}Pics`, [entry("p.png", { ext: "png", category: "image" })])],
  ]);
}

const names = (rows: ReturnType<typeof flattenTree>) => rows.map((r) => r.name);
const depths = (rows: ReturnType<typeof flattenTree>) => rows.map((r) => r.depth);

describe("flattenTree", () => {
  it("shows the root's contents at depth 0, folders first", () => {
    const rows = flattenTree([ROOT], new Set(), tree(), OPTS);
    expect(names(rows)).toEqual(["Docs", "Pics", "root.txt"]);
    expect(depths(rows)).toEqual([0, 0, 0]);
  });

  it("splices an expanded folder's children in beneath it", () => {
    const rows = flattenTree([ROOT], new Set([`${ROOT}${D}Docs`]), tree(), OPTS);
    expect(names(rows)).toEqual(["Docs", "Deep", "a.txt", "Pics", "root.txt"]);
    expect(depths(rows)).toEqual([0, 1, 1, 0, 0]);
  });

  it("nests several levels deep", () => {
    const expanded = new Set([`${ROOT}${D}Docs`, `${ROOT}${D}Docs${D}Deep`]);
    const rows = flattenTree([ROOT], expanded, tree(), OPTS);
    expect(names(rows)).toEqual(["Docs", "Deep", "deep.txt", "a.txt", "Pics", "root.txt"]);
    expect(depths(rows)).toEqual([0, 1, 2, 1, 0, 0]);
  });

  it("handles two expanded siblings independently", () => {
    const expanded = new Set([`${ROOT}${D}Docs`, `${ROOT}${D}Pics`]);
    const rows = flattenTree([ROOT], expanded, tree(), OPTS);
    expect(names(rows)).toEqual(["Docs", "Deep", "a.txt", "Pics", "p.png", "root.txt"]);
  });

  it("ignores an expanded flag on a file", () => {
    const rows = flattenTree([ROOT], new Set([`${ROOT}${D}root.txt`]), tree(), OPTS);
    expect(names(rows)).toEqual(["Docs", "Pics", "root.txt"]);
    expect(rows[2].expanded).toBe(false);
  });

  it("gives every row the directory it lives in", () => {
    const rows = flattenTree([ROOT], new Set([`${ROOT}${D}Docs`]), tree(), OPTS);
    expect(rows[0].parent).toBe(ROOT);
    expect(rows[1].parent).toBe(`${ROOT}${D}Docs`);
  });
});

describe("disclosure triangles", () => {
  it("reports unknown for a directory that has never been read", () => {
    const dirs = new Map([[ROOT, ready(ROOT, [folder("Docs"), entry("a.txt")])]]);
    const rows = flattenTree([ROOT], new Set(), dirs, OPTS);
    // Optimistic: draw the triangle rather than pay one open plus one enumerate
    // per subdirectory just to decide.
    expect(rows[0].hasChildren).toBe("unknown");
    expect(rows[1].hasChildren).toBe(false);
  });

  it("reports false once a directory turns out to be empty", () => {
    const dirs = tree();
    dirs.set(`${ROOT}${D}Pics`, ready(`${ROOT}${D}Pics`, []));
    const rows = flattenTree([ROOT], new Set(), dirs, OPTS);
    expect(rows.find((r) => r.name === "Pics")?.hasChildren).toBe(false);
  });

  it("reports false when every child is filtered out of view", () => {
    const dirs = tree();
    dirs.set(
      `${ROOT}${D}Pics`,
      ready(`${ROOT}${D}Pics`, [entry(".secret", { flags: Attr.Hidden, ext: "" })]),
    );
    const rows = flattenTree([ROOT], new Set(), dirs, OPTS);
    expect(rows.find((r) => r.name === "Pics")?.hasChildren).toBe(false);
  });
});

describe("placeholders", () => {
  it("emits a loading row for an expanded directory still being read", () => {
    const dirs = tree();
    dirs.set(`${ROOT}${D}Docs`, loading(`${ROOT}${D}Docs`));
    const rows = flattenTree([ROOT], new Set([`${ROOT}${D}Docs`]), dirs, OPTS);

    expect(names(rows)).toEqual(["Docs", "Loading", "Pics", "root.txt"]);
    // It renders, so the disclosure animation has something to reveal, but it
    // must never be a keyboard target.
    expect(rows[1].placeholder).toBe(true);
  });

  it("does not emit a placeholder for a root that is still loading", () => {
    const dirs = new Map([[ROOT, loading(ROOT)]]);
    expect(flattenTree([ROOT], new Set(), dirs, OPTS)).toEqual([]);
  });

  it("emits nothing at all for a directory that was never requested", () => {
    expect(flattenTree([ROOT], new Set(), new Map(), OPTS)).toEqual([]);
  });
});

describe("view options", () => {
  it("applies the hidden filter at every level", () => {
    const dirs = tree();
    dirs.set(
      `${ROOT}${D}Docs`,
      ready(`${ROOT}${D}Docs`, [entry(".env", { flags: Attr.Hidden, ext: "" }), entry("a.txt")]),
    );
    const expanded = new Set([`${ROOT}${D}Docs`]);

    expect(names(flattenTree([ROOT], expanded, dirs, OPTS))).toEqual([
      "Docs",
      "a.txt",
      "Pics",
      "root.txt",
    ]);
    expect(names(flattenTree([ROOT], expanded, dirs, { ...OPTS, showHidden: true }))).toEqual([
      "Docs",
      ".env",
      "a.txt",
      "Pics",
      "root.txt",
    ]);
  });

  it("sorts each level independently", () => {
    const rows = flattenTree([ROOT], new Set([`${ROOT}${D}Docs`]), tree(), {
      ...OPTS,
      sortDir: -1,
    });
    // Folders stay first even reversed -- direction must not bury them -- and
    // within each group the order flips.
    expect(names(rows)).toEqual(["Pics", "Docs", "Deep", "a.txt", "root.txt"]);
  });

  it("keeps an unmatched ancestor when something inside it matches", () => {
    // Otherwise typing a filter in tree mode collapses everything the moment an
    // ancestor stops matching, which is useless exactly where it would help.
    const rows = flattenTree([ROOT], new Set([`${ROOT}${D}Docs`]), tree(), {
      ...OPTS,
      filter: "a.txt",
    });
    expect(names(rows)).toEqual(["Docs", "a.txt"]);
  });

  it("does not resurrect an unmatched ancestor that is collapsed", () => {
    // Only expanded subtrees are walked, so a collapsed folder cannot be kept
    // alive by a match nobody can see.
    const rows = flattenTree([ROOT], new Set(), tree(), { ...OPTS, filter: "a.txt" });
    expect(names(rows)).toEqual([]);
  });

  it("still hides a folder whose subtree matches nothing", () => {
    const expanded = new Set([`${ROOT}${D}Docs`, `${ROOT}${D}Pics`]);
    const rows = flattenTree([ROOT], expanded, tree(), { ...OPTS, filter: "p.png" });
    expect(names(rows)).toEqual(["Pics", "p.png"]);
  });

  it("keeps hidden entries out even while the name filter is lifted for ancestors", () => {
    const dirs = tree();
    dirs.set(
      `${ROOT}${D}Docs`,
      ready(`${ROOT}${D}Docs`, [entry(".hidden-a.txt", { flags: Attr.Hidden })]),
    );
    const rows = flattenTree([ROOT], new Set([`${ROOT}${D}Docs`]), dirs, {
      ...OPTS,
      filter: "a.txt",
    });
    expect(names(rows)).toEqual([]);
  });
});

describe("safety", () => {
  it("stops at the depth guard instead of looping through a reparse point", () => {
    // A directory that contains itself, which a junction can produce.
    const loop = `C:${D}Loop`;
    const dirs = new Map<string, DirState>([[loop, ready(loop, [folder("Loop")])]]);
    // Every nested path is the same directory as far as the cache is concerned.
    const expanded = new Set<string>();
    let p = loop;
    for (let i = 0; i < MAX_DEPTH + 10; i++) {
      p = `${p}${D}Loop`;
      dirs.set(p, ready(p, [folder("Loop")]));
      expanded.add(p);
    }
    expanded.add(`${loop}${D}Loop`);

    const rows = flattenTree([loop], expanded, dirs, OPTS);
    expect(rows.length).toBeLessThanOrEqual(MAX_DEPTH + 2);
  });

  it("handles multiple roots", () => {
    const other = `C:${D}Other`;
    const dirs = tree();
    dirs.set(other, ready(other, [entry("x.txt")]));
    const rows = flattenTree([ROOT, other], new Set(), dirs, OPTS);
    expect(names(rows)).toEqual(["Docs", "Pics", "root.txt", "x.txt"]);
  });
});

describe("rowIndexOf", () => {
  it("finds a real row and skips placeholders", () => {
    const dirs = tree();
    dirs.set(`${ROOT}${D}Docs`, loading(`${ROOT}${D}Docs`));
    const rows = flattenTree([ROOT], new Set([`${ROOT}${D}Docs`]), dirs, OPTS);

    expect(rowIndexOf(rows, `${ROOT}${D}Pics`)).toBe(2);
    expect(rowIndexOf(rows, `${ROOT}${D}Docs loading`)).toBe(-1);
    expect(rowIndexOf(rows, `${ROOT}${D}nope`)).toBe(-1);
  });
});
