import { describe, expect, it } from "vitest";

import { Attr } from "../ipc/types";
import type { DirEntry } from "../ipc/types";
import { compareEntries, initialDirFor, visibleSorted } from "./sort";

function entry(over: Partial<DirEntry> & { name: string }): DirEntry {
  return {
    isDir: false,
    flags: 0,
    size: 0,
    modifiedMs: 0,
    ext: "",
    category: "unknown",
    ...over,
  };
}

const names = (es: DirEntry[]) => es.map((e) => e.name);

describe("compareEntries", () => {
  it("puts folders first regardless of key or direction", () => {
    const dir = entry({ name: "zzz", isDir: true });
    const file = entry({ name: "aaa", size: 999 });
    expect(compareEntries(dir, file, "name", 1)).toBeLessThan(0);
    expect(compareEntries(dir, file, "name", -1)).toBeLessThan(0);
    expect(compareEntries(dir, file, "size", -1)).toBeLessThan(0);
  });

  it("orders names naturally, not lexically", () => {
    const es = [entry({ name: "file10" }), entry({ name: "file2" }), entry({ name: "file1" })];
    es.sort((a, b) => compareEntries(a, b, "name", 1));
    expect(names(es)).toEqual(["file1", "file2", "file10"]);
  });

  it("ignores case when ordering names", () => {
    const es = [entry({ name: "beta" }), entry({ name: "Alpha" }), entry({ name: "gamma" })];
    es.sort((a, b) => compareEntries(a, b, "name", 1));
    expect(names(es)).toEqual(["Alpha", "beta", "gamma"]);
  });

  it("breaks collation ties deterministically", () => {
    // "a" and "A" collate equal at base sensitivity; the tiebreak must still
    // give a stable, repeatable order.
    const a = entry({ name: "a" });
    const A = entry({ name: "A" });
    const r1 = compareEntries(a, A, "name", 1);
    const r2 = compareEntries(a, A, "name", 1);
    expect(r1).not.toBe(0);
    expect(r1).toBe(r2);
  });

  it("sorts directories by name even when the size column is active", () => {
    const es = [
      entry({ name: "beta", isDir: true }),
      entry({ name: "alpha", isDir: true }),
    ];
    es.sort((a, b) => compareEntries(a, b, "size", 1));
    expect(names(es)).toEqual(["alpha", "beta"]);
  });

  it("flips direction for size and date", () => {
    const small = entry({ name: "s", size: 10 });
    const big = entry({ name: "b", size: 1000 });
    expect(compareEntries(small, big, "size", 1)).toBeLessThan(0);
    expect(compareEntries(small, big, "size", -1)).toBeGreaterThan(0);

    const older = entry({ name: "o", modifiedMs: 1000 });
    const newer = entry({ name: "n", modifiedMs: 2000 });
    expect(compareEntries(older, newer, "modified", 1)).toBeLessThan(0);
    expect(compareEntries(older, newer, "modified", -1)).toBeGreaterThan(0);
  });
});

describe("visibleSorted", () => {
  const all = [
    entry({ name: "Documents", isDir: true }),
    entry({ name: ".gitignore", flags: Attr.Hidden }),
    entry({ name: "pagefile.sys", flags: Attr.System | Attr.Hidden }),
    entry({ name: "notes.txt" }),
    entry({ name: "Photo.PNG" }),
  ];
  const base = {
    showHidden: false,
    showSystem: false,
    filter: "",
    sortKey: "name" as const,
    sortDir: 1 as const,
  };

  it("hides hidden and system entries by default", () => {
    expect(names(visibleSorted(all, base))).toEqual(["Documents", "notes.txt", "Photo.PNG"]);
  });

  it("reveals hidden entries but still hides system ones", () => {
    // System is a separate, stricter class -- this is what keeps C:\ from
    // showing pagefile.sys when the user only asked for dotfiles.
    expect(names(visibleSorted(all, { ...base, showHidden: true }))).toEqual([
      "Documents",
      ".gitignore",
      "notes.txt",
      "Photo.PNG",
    ]);
  });

  it("filters case-insensitively on a substring", () => {
    expect(names(visibleSorted(all, { ...base, filter: "NOTE" }))).toEqual(["notes.txt"]);
  });

  it("returns an empty array rather than throwing when nothing matches", () => {
    expect(visibleSorted(all, { ...base, filter: "zzzz" })).toEqual([]);
  });

  it("does not mutate its input", () => {
    const before = names(all);
    visibleSorted(all, { ...base, sortDir: -1 });
    expect(names(all)).toEqual(before);
  });
});

describe("initialDirFor", () => {
  it("starts text columns ascending and numeric ones descending", () => {
    expect(initialDirFor("name")).toBe(1);
    expect(initialDirFor("kind")).toBe(1);
    expect(initialDirFor("size")).toBe(-1);
    expect(initialDirFor("modified")).toBe(-1);
  });
});
