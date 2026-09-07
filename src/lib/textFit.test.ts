import { describe, expect, it } from "vitest";

import {
  columnWidthCap,
  ELLIPSIS,
  fitColumnWidth,
  middleTruncate,
  type Measure,
} from "./textFit";

/** One unit per character, so every expectation is arithmetic rather than guesswork. */
const perChar: Measure = (t) => [...t].length;

/** A width that varies by character, to catch anything assuming uniform advance. */
const proportional: Measure = (t) =>
  [...t].reduce((sum, c) => sum + (c === "i" || c === "l" ? 0.5 : c === "W" ? 2 : 1), 0);

describe("middleTruncate", () => {
  it("leaves text that already fits untouched", () => {
    expect(middleTruncate("report.pdf", 20, perChar)).toBe("report.pdf");
    expect(middleTruncate("report.pdf", 10, perChar)).toBe("report.pdf");
  });

  it("keeps the start and the end, dropping the middle", () => {
    const out = middleTruncate("abcdefghijklmnop", 9, perChar);
    expect(out).toContain(ELLIPSIS);
    expect(out.startsWith("a")).toBe(true);
    expect(out.endsWith("p")).toBe(true);
    expect(perChar(out)).toBeLessThanOrEqual(9);
  });

  it("never exceeds the budget", () => {
    const name = "a-really-quite-long-document-name-2026-final-v3.txt";
    for (const budget of [4, 8, 12, 20, 30, 40]) {
      expect(perChar(middleTruncate(name, budget, perChar))).toBeLessThanOrEqual(budget);
    }
  });

  it("uses as much of the budget as it can", () => {
    const name = "abcdefghijklmnopqrstuvwxyz";
    const out = middleTruncate(name, 15, perChar);
    // A result far under budget would mean the search gave up early.
    expect(perChar(out)).toBeGreaterThan(12);
    expect(perChar(out)).toBeLessThanOrEqual(15);
  });

  it("keeps a file extension visible, which an end-ellipsis destroys", () => {
    const out = middleTruncate("quarterly-revenue-breakdown-2026.xlsx", 16, perChar);
    expect(out.endsWith("xlsx")).toBe(true);
  });

  it("works with a proportional font, not just fixed advance", () => {
    const name = "WWWWlliiiiWWWWllii";
    const out = middleTruncate(name, 10, proportional);
    expect(proportional(out)).toBeLessThanOrEqual(10);
    expect(out).toContain(ELLIPSIS);
  });

  it("does not split a surrogate pair", () => {
    // Truncating by UTF-16 index would leave half an emoji behind.
    const name = "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂";
    const out = middleTruncate(name, 5, perChar);
    expect([...out].every((c) => c === ELLIPSIS || c === "🙂")).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("degrades to the ellipsis alone when the budget is tiny", () => {
    expect(middleTruncate("abcdefgh", 1, perChar)).toBe(ELLIPSIS);
  });

  it("returns nothing when even the ellipsis will not fit", () => {
    expect(middleTruncate("abcdefgh", 0.5, perChar)).toBe("");
  });

  it("handles degenerate input without throwing", () => {
    expect(middleTruncate("", 10, perChar)).toBe("");
    expect(middleTruncate("a", 0, perChar)).toBe("a");
    expect(middleTruncate("ab", -5, perChar)).toBe("ab");
  });
});

describe("fitColumnWidth", () => {
  const opts = { chrome: 10, min: 50, max: 200 };

  it("sizes to the longest name plus the surrounding chrome", () => {
    // A minimum low enough that the measurement, not the clamp, decides.
    const loose = { chrome: 10, min: 5, max: 200 };
    expect(fitColumnWidth(["ab", "abcdefghij", "abcd"], perChar, loose)).toBe(20);
  });

  it("clamps up to the minimum when the longest name is short", () => {
    expect(fitColumnWidth(["ab", "abcdefghij"], perChar, opts)).toBe(50);
  });

  it("never goes below the minimum", () => {
    expect(fitColumnWidth(["a"], perChar, opts)).toBe(50);
  });

  it("never goes above the maximum, however long the name", () => {
    // The cap is what stops one absurd filename from eating the window.
    expect(fitColumnWidth(["x".repeat(5000)], perChar, opts)).toBe(200);
  });

  it("returns the minimum for an empty directory", () => {
    expect(fitColumnWidth([], perChar, opts)).toBe(50);
  });

  it("finds the widest even when it is buried in a large directory", () => {
    // Only the longest few names are measured, so the sampling must actually
    // pick the widest rather than whatever happened to come first.
    const names = Array.from({ length: 5000 }, (_, i) => `f${i}.txt`);
    names[4321] = "the-single-longest-name-in-this-whole-directory.txt";
    const expected = Math.min(opts.max, perChar(names[4321]) + opts.chrome);
    expect(fitColumnWidth(names, perChar, opts)).toBe(expected);
  });

  it("measures far fewer names than the directory holds", () => {
    let calls = 0;
    const counting: Measure = (t) => {
      calls++;
      return perChar(t);
    };
    fitColumnWidth(
      Array.from({ length: 20_000 }, (_, i) => `file-${i}.txt`),
      counting,
      opts,
    );
    // A hundred thousand canvas calls for one directory would be visible jank.
    expect(calls).toBeLessThanOrEqual(64);
  });
});

describe("columnWidthCap", () => {
  it("uses the absolute cap when there is plenty of room", () => {
    expect(columnWidthCap(1400)).toBe(400);
    expect(columnWidthCap(800)).toBe(400);
  });

  it("shrinks the cap on a narrow window so a second column stays in sight", () => {
    // At the 720px minimum window a flat 400px cap would be over three quarters
    // of the strip, leaving nowhere to see where you came from.
    const narrow = columnWidthCap(520);
    expect(narrow).toBeLessThan(400);
    expect(narrow).toBeCloseTo(520 * 0.55, 5);
  });

  it("never returns less than the column minimum", () => {
    expect(columnWidthCap(100)).toBe(150);
    expect(columnWidthCap(1)).toBe(150);
  });

  it("falls back to the absolute cap before the strip has been measured", () => {
    expect(columnWidthCap(0)).toBe(400);
  });
});
