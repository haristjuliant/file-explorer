import { describe, expect, it } from "vitest";

import {
  basename,
  depthOf,
  entryPath,
  equalsIgnoreCase,
  isDriveRoot,
  isInside,
  isRoot,
  isUncRoot,
  join,
  normalize,
  parentOf,
  segments,
} from "./path";

// Readability helpers: these keep the tests free of backslash thickets.
const D = "\\"; // one separator
const UNC = "\\\\"; // UNC prefix

describe("normalize", () => {
  it("converts forward slashes to backslashes", () => {
    expect(normalize("C:/Users/User")).toBe(`C:${D}Users${D}User`);
  });

  it("upper-cases the drive letter so casing cannot fork a cache key", () => {
    expect(normalize("c:/Users")).toBe(`C:${D}Users`);
    expect(normalize(`c:${D}users${D}user`)).toBe(`C:${D}users${D}user`);
  });

  it("strips a trailing separator except on a drive root", () => {
    expect(normalize(`C:${D}Users${D}User${D}`)).toBe(`C:${D}Users${D}User`);
    expect(normalize(`C:${D}`)).toBe(`C:${D}`);
  });

  it("treats a bare drive letter as its root", () => {
    // `C:` means "current directory on C:", which we never want as a key.
    expect(normalize("C:")).toBe(`C:${D}`);
  });

  it("collapses repeated separators but keeps the UNC prefix", () => {
    expect(normalize(`C:${D}${D}Users${D}${D}${D}User`)).toBe(`C:${D}Users${D}User`);
    expect(normalize(`${UNC}server${D}share${D}dir`)).toBe(`${UNC}server${D}share${D}dir`);
    expect(normalize("//server/share")).toBe(`${UNC}server${D}share`);
  });

  it("strips a verbatim prefix if one ever leaks in", () => {
    expect(normalize(`${UNC}?${D}C:${D}Users`)).toBe(`C:${D}Users`);
    expect(normalize(`${UNC}?${D}UNC${D}server${D}share`)).toBe(`${UNC}server${D}share`);
  });

  it("is idempotent", () => {
    const inputs = [
      "C:/Users/User/",
      "c:",
      "//server/share/x",
      `${UNC}?${D}C:${D}a`,
      `C:${D}Users${D}${D}User`,
    ];
    for (const p of inputs) {
      const once = normalize(p);
      expect(normalize(once)).toBe(once);
    }
  });

  it("leaves an empty or blank string alone", () => {
    expect(normalize("")).toBe("");
    expect(normalize("   ")).toBe("");
  });
});

describe("root detection", () => {
  it("recognises drive roots", () => {
    expect(isDriveRoot(`C:${D}`)).toBe(true);
    expect(isDriveRoot(`C:${D}Users`)).toBe(false);
    expect(isRoot(`C:${D}`)).toBe(true);
  });

  it("recognises share roots but not a bare server or a deeper path", () => {
    expect(isUncRoot(`${UNC}server${D}share`)).toBe(true);
    expect(isUncRoot(`${UNC}server`)).toBe(false);
    expect(isUncRoot(`${UNC}server${D}share${D}dir`)).toBe(false);
    expect(isRoot(`${UNC}server${D}share`)).toBe(true);
  });
});

describe("parentOf", () => {
  it("returns null at a drive root", () => {
    expect(parentOf(`C:${D}`)).toBeNull();
    expect(parentOf("C:")).toBeNull();
  });

  it("keeps the trailing separator when the parent is a drive root", () => {
    expect(parentOf(`C:${D}Users`)).toBe(`C:${D}`);
  });

  it("walks up one level", () => {
    expect(parentOf(`C:${D}Users${D}User${D}Documents`)).toBe(`C:${D}Users${D}User`);
    expect(parentOf(`C:${D}Users${D}User${D}`)).toBe(`C:${D}Users`);
  });

  it("stops at a share root instead of exposing a bare server", () => {
    expect(parentOf(`${UNC}server${D}share${D}dir`)).toBe(`${UNC}server${D}share`);
    expect(parentOf(`${UNC}server${D}share`)).toBeNull();
  });
});

describe("join and entryPath", () => {
  it("joins without doubling separators", () => {
    expect(join(`C:${D}Users`, "User")).toBe(`C:${D}Users${D}User`);
    expect(join(`C:${D}`, "Users")).toBe(`C:${D}Users`);
    expect(join(`C:${D}Users${D}`, "User")).toBe(`C:${D}Users${D}User`);
  });

  it("builds an absolute path from a DirEntry name", () => {
    expect(entryPath(`C:${D}Users`, { name: "notes.txt" })).toBe(`C:${D}Users${D}notes.txt`);
  });
});

describe("basename", () => {
  it("returns the last component", () => {
    expect(basename(`C:${D}Users${D}User${D}a.txt`)).toBe("a.txt");
  });

  it("returns the root itself for a drive root", () => {
    expect(basename(`C:${D}`)).toBe(`C:${D}`);
  });
});

describe("segments", () => {
  it("produces breadcrumb entries with cumulative paths", () => {
    expect(segments(`C:${D}Users${D}User`)).toEqual([
      { label: "C:", path: `C:${D}` },
      { label: "Users", path: `C:${D}Users` },
      { label: "User", path: `C:${D}Users${D}User` },
    ]);
  });

  it("treats a share as one leading segment", () => {
    expect(segments(`${UNC}server${D}share${D}dir`)).toEqual([
      { label: `${UNC}server${D}share`, path: `${UNC}server${D}share` },
      { label: "dir", path: `${UNC}server${D}share${D}dir` },
    ]);
  });

  it("returns nothing for an empty path or a bare server", () => {
    expect(segments("")).toEqual([]);
    expect(segments(`${UNC}server`)).toEqual([]);
  });
});

describe("isInside", () => {
  it("treats a path as inside itself", () => {
    expect(isInside(`C:${D}A`, `C:${D}A`)).toBe(true);
  });

  it("matches descendants case-insensitively", () => {
    expect(isInside(`C:${D}A`, `c:${D}a${D}b${D}c`)).toBe(true);
  });

  it("does not match a sibling that merely shares a name prefix", () => {
    // The bug this guards: `C:\App` must not count as inside `C:\A`.
    expect(isInside(`C:${D}A`, `C:${D}App`)).toBe(false);
  });

  it("treats everything on a drive as inside its root", () => {
    expect(isInside(`C:${D}`, `C:${D}Users${D}User`)).toBe(true);
  });
});

describe("depthOf", () => {
  it("counts depth from the root", () => {
    expect(depthOf(`C:${D}`)).toBe(0);
    expect(depthOf(`C:${D}Users`)).toBe(1);
    expect(depthOf(`C:${D}Users${D}User`)).toBe(2);
  });

  it("counts a share root as depth 0", () => {
    expect(depthOf(`${UNC}server${D}share`)).toBe(0);
    expect(depthOf(`${UNC}server${D}share${D}dir`)).toBe(1);
  });
});

describe("equalsIgnoreCase", () => {
  it("compares user-typed paths without case or separator style", () => {
    expect(equalsIgnoreCase("C:/Users/User", `c:${D}users${D}user${D}`)).toBe(true);
  });

  it("still distinguishes different paths", () => {
    expect(equalsIgnoreCase(`C:${D}A`, `C:${D}B`)).toBe(false);
  });
});
