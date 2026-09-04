import { describe, expect, it } from "vitest";

import { formatBytes, formatCount, formatDate, formatStatus } from "./format";

describe("formatBytes", () => {
  it("spells out the small cases the way Finder does", () => {
    expect(formatBytes(0)).toBe("Zero bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(999)).toBe("999 bytes");
  });

  it("switches to KB at exactly 1000 (decimal, like Finder)", () => {
    expect(formatBytes(1000)).toBe("1 KB");
    expect(formatBytes(1500)).toBe("1.5 KB");
  });

  it("drops the decimal at and above 100 of a unit", () => {
    expect(formatBytes(9_400_000)).toBe("9.4 MB");
    expect(formatBytes(412_000_000)).toBe("412 MB");
  });

  it("trims a trailing .0 rather than showing 1.0 GB", () => {
    expect(formatBytes(1_000_000_000)).toBe("1 GB");
  });

  it("climbs through the unit table", () => {
    expect(formatBytes(4_200_000_000)).toBe("4.2 GB");
    expect(formatBytes(2_000_000_000_000)).toBe("2 TB");
  });

  it("returns a placeholder for nonsense instead of NaN", () => {
    expect(formatBytes(-1)).toBe("--");
    expect(formatBytes(Number.NaN)).toBe("--");
  });
});

describe("formatDate", () => {
  // Frozen clock: Wed 3 Sep 2026, 15:30 local.
  const now = new Date(2026, 8, 3, 15, 30, 0);

  it("labels today relatively", () => {
    const ms = new Date(2026, 8, 3, 9, 4, 0).getTime();
    expect(formatDate(ms, now)).toMatch(/^Today at /);
  });

  it("labels yesterday relatively", () => {
    const ms = new Date(2026, 8, 2, 23, 59, 0).getTime();
    expect(formatDate(ms, now)).toMatch(/^Yesterday at /);
  });

  it("uses day and month within the same year, with a time", () => {
    const ms = new Date(2026, 2, 12, 9, 12, 0).getTime();
    const out = formatDate(ms, now);
    expect(out).not.toMatch(/Today|Yesterday/);
    expect(out).toContain(" at ");
    expect(out).not.toContain("2026");
  });

  it("includes the year for older dates and drops the time", () => {
    const ms = new Date(2023, 0, 5, 9, 12, 0).getTime();
    const out = formatDate(ms, now);
    expect(out).toContain("2023");
    expect(out).not.toContain(" at ");
  });

  it("treats a zero or invalid timestamp as unknown", () => {
    // Zero is what Rust sends when a filesystem omits the timestamp.
    expect(formatDate(0, now)).toBe("--");
    expect(formatDate(Number.NaN, now)).toBe("--");
  });

  it("does not call today's midnight yesterday", () => {
    const midnight = new Date(2026, 8, 3, 0, 0, 0).getTime();
    expect(formatDate(midnight, now)).toMatch(/^Today at /);
  });
});

describe("formatCount and formatStatus", () => {
  it("pluralises", () => {
    expect(formatCount(1, "item")).toBe("1 item");
    expect(formatCount(2, "item")).toBe("2 items");
  });

  it("omits the selection clause when nothing is selected", () => {
    expect(formatStatus(148, 0)).toBe("148 items");
    expect(formatStatus(148, 12)).toBe("148 items, 12 selected");
  });
});
