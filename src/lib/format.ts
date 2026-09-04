/** Byte, date and count formatting. Pure, and unit-tested against a frozen clock. */

/**
 * Finder-style decimal sizes: 1 KB = 1000 bytes.
 *
 * Note this differs from Explorer, which divides by 1024 while still writing
 * "KB". The visual target is Finder, so we follow Finder and are internally
 * consistent rather than matching Explorer's mislabelling.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes === 0) return "Zero bytes";
  if (bytes === 1) return "1 byte";
  if (bytes < 1000) return `${bytes} bytes`;

  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  // Finder shows one decimal below 100 and none above, so "9.4 MB" but "412 MB".
  const text = value >= 100 ? Math.round(value).toString() : trimZero(value.toFixed(1));
  return `${text} ${units[unit]}`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const sameYearFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const otherYearFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Finder's relative date column.
 *
 * `now` is injectable so tests can freeze the clock instead of mocking Date.
 */
export function formatDate(ms: number, now: Date = new Date()): string {
  if (!ms) return "--";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "--";

  const today = startOfDay(now);
  const day = startOfDay(d);
  const dayMs = 86_400_000;

  if (day === today) return `Today at ${timeFmt.format(d)}`;
  if (day === today - dayMs) return `Yesterday at ${timeFmt.format(d)}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${sameYearFmt.format(d)} at ${timeFmt.format(d)}`;
  }
  return otherYearFmt.format(d);
}

/** Absolute date for the metadata table, where relative is unhelpful. */
const fullFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatDateFull(ms: number): string {
  if (!ms) return "--";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "--" : fullFmt.format(d);
}

export function formatCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

/** "148 items, 12 selected" for the status bar. */
export function formatStatus(total: number, selected: number): string {
  const base = formatCount(total, "item");
  return selected > 0 ? `${base}, ${selected.toLocaleString()} selected` : base;
}
