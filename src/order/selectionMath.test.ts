import { describe, expect, it } from "vitest";

import {
  findByPrefix,
  marqueeRange,
  pruneToOrder,
  rangeBetween,
  stepIndex,
  toggleIn,
  unionRange,
} from "./selectionMath";

const P = ["a", "b", "c", "d", "e"];

describe("rangeBetween", () => {
  it("selects forwards", () => {
    expect(rangeBetween(P, "b", "d")).toEqual(["b", "c", "d"]);
  });

  it("selects backwards, still in list order", () => {
    expect(rangeBetween(P, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("selects a single item when both ends are the same", () => {
    expect(rangeBetween(P, "c", "c")).toEqual(["c"]);
  });

  it("degrades to just the target when the anchor is gone", () => {
    // The anchor was deleted, filtered out, or swallowed by a tree collapse.
    // Selecting everything, or throwing, would both be worse.
    expect(rangeBetween(P, "zzz", "c")).toEqual(["c"]);
  });

  it("selects nothing when the target itself is gone", () => {
    expect(rangeBetween(P, "a", "zzz")).toEqual([]);
  });

  it("selects nothing in an empty order", () => {
    expect(rangeBetween([], "a", "b")).toEqual([]);
  });
});

describe("stepIndex", () => {
  it("moves by one in either direction", () => {
    expect(stepIndex(5, 2, 1)).toBe(3);
    expect(stepIndex(5, 2, -1)).toBe(1);
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(stepIndex(5, 4, 1)).toBe(4);
    expect(stepIndex(5, 0, -1)).toBe(0);
  });

  it("enters at the first row when moving down with no cursor", () => {
    expect(stepIndex(5, -1, 1)).toBe(0);
  });

  it("enters at the last row when moving up with no cursor", () => {
    expect(stepIndex(5, -1, -1)).toBe(4);
  });

  it("handles a page-sized jump", () => {
    expect(stepIndex(100, 0, 20)).toBe(20);
    expect(stepIndex(100, 95, 20)).toBe(99);
    expect(stepIndex(10, 5, -20)).toBe(0);
  });

  it("returns -1 for an empty list", () => {
    expect(stepIndex(0, -1, 1)).toBe(-1);
  });
});

describe("toggleIn", () => {
  it("adds a missing path and removes a present one", () => {
    const s = new Set(["a"]);
    expect([...toggleIn(s, "b")].sort()).toEqual(["a", "b"]);
    expect([...toggleIn(s, "a")]).toEqual([]);
  });

  it("never mutates the input, because the store treats Sets as immutable", () => {
    const s = new Set(["a"]);
    toggleIn(s, "b");
    expect([...s]).toEqual(["a"]);
  });
});

describe("unionRange", () => {
  it("adds a range without dropping the existing selection", () => {
    const s = new Set(["e"]);
    expect([...unionRange(s, P, "a", "c")].sort()).toEqual(["a", "b", "c", "e"]);
  });
});

describe("pruneToOrder", () => {
  it("drops paths that are no longer visible", () => {
    const s = new Set(["a", "zzz", "c"]);
    expect([...pruneToOrder(s, P)].sort()).toEqual(["a", "c"]);
  });

  it("returns an empty set when nothing survives", () => {
    expect([...pruneToOrder(new Set(["x"]), P)]).toEqual([]);
  });
});

describe("marqueeRange", () => {
  it("converts a downward drag into an index range", () => {
    // Fixed row height makes this arithmetic -- no DOM hit-testing.
    expect(marqueeRange(0, 71, 24, 10)).toEqual({ from: 0, to: 2 });
  });

  it("normalises an upward drag", () => {
    expect(marqueeRange(71, 0, 24, 10)).toEqual({ from: 0, to: 2 });
  });

  it("clamps a drag that runs past the last row", () => {
    expect(marqueeRange(0, 10_000, 24, 10)).toEqual({ from: 0, to: 9 });
  });

  it("selects nothing for an empty list", () => {
    expect(marqueeRange(0, 100, 24, 0)).toBeNull();
  });
});

describe("findByPrefix", () => {
  const names = ["Alpha", "apple", "Beta", "banana", "Cherry"];

  it("matches case-insensitively from the given index", () => {
    expect(findByPrefix(names, "b", 0)).toBe(2);
  });

  it("advances past the current match so repeats walk the group", () => {
    // Typing "a" repeatedly should alternate between Alpha and apple.
    expect(findByPrefix(names, "a", 0)).toBe(0);
    expect(findByPrefix(names, "a", 1)).toBe(1);
    expect(findByPrefix(names, "a", 2)).toBe(0);
  });

  it("wraps around the end of the list", () => {
    expect(findByPrefix(names, "c", 4)).toBe(4);
    expect(findByPrefix(names, "a", 4)).toBe(0);
  });

  it("matches a multi-character prefix", () => {
    expect(findByPrefix(names, "ban", 0)).toBe(3);
  });

  it("returns -1 when nothing matches or the prefix is empty", () => {
    expect(findByPrefix(names, "zz", 0)).toBe(-1);
    expect(findByPrefix(names, "", 0)).toBe(-1);
    expect(findByPrefix([], "a", 0)).toBe(-1);
  });
});
