/**
 * Text measurement and middle truncation for column view.
 *
 * Two things CSS cannot do: size a column to its longest entry, and elide the
 * MIDDLE of a name. `text-overflow: ellipsis` only ever clips the end, which
 * for a file is the worst half to lose -- it takes the extension with it.
 *
 * Measurement goes through a canvas rather than the DOM: laying out a hidden
 * element per name would thrash layout, and a canvas answers in about a
 * microsecond. The measure function is injected everywhere so the logic can be
 * tested without a canvas, which jsdom does not implement.
 */

/** Returns the rendered width of `text`, in CSS pixels. */
export type Measure = (text: string) => number;

/** U+2026, one character rather than three dots. */
export const ELLIPSIS = "…";

/**
 * A canvas-backed measurer, with a crude fallback.
 *
 * The fallback matters: `getContext("2d")` returns null in jsdom and in some
 * locked-down environments, and a column that throws is worse than a column
 * whose width is approximate.
 */
export function createMeasurer(font: string): Measure {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }

  if (!ctx) {
    // Roughly the average advance width of the UI font at 13px. Only ever used
    // where real measurement is unavailable.
    const approx = 6.6;
    return (text) => text.length * approx;
  }

  ctx.font = font;
  const cache = new Map<string, number>();
  return (text) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const w = ctx.measureText(text).width;
    // Bounded so a huge directory cannot grow the cache without limit.
    if (cache.size < 4096) cache.set(text, w);
    return w;
  };
}

/** The font shorthand an element is actually rendered with. */
export function fontOf(el: Element | null): string {
  const fallback = '13px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
  if (!el) return fallback;
  try {
    const cs = getComputedStyle(el);
    if (!cs.fontSize || !cs.fontFamily) return fallback;
    return `${cs.fontStyle || "normal"} ${cs.fontWeight || "400"} ${cs.fontSize} ${cs.fontFamily}`;
  } catch {
    return fallback;
  }
}

/**
 * Keep the start and the end of `text`, dropping the middle, so the result fits
 * within `maxWidth`.
 *
 * The split favours the head slightly -- names are distinguished by how they
 * start -- while leaving enough tail that a file extension survives, which is
 * exactly what an end-ellipsis destroys.
 */
export function middleTruncate(text: string, maxWidth: number, measure: Measure): string {
  if (maxWidth <= 0 || text.length <= 1) return text;
  if (measure(text) <= maxWidth) return text;

  const chars = [...text]; // code points, so surrogate pairs are never split
  const ellipsisWidth = measure(ELLIPSIS);
  if (ellipsisWidth > maxWidth) return "";

  // Binary search the number of characters to keep in total.
  const build = (keep: number): string => {
    const head = Math.ceil(keep * 0.6);
    const tail = keep - head;
    return chars.slice(0, head).join("") + ELLIPSIS + (tail > 0 ? chars.slice(-tail).join("") : "");
  };

  let lo = 0;
  let hi = chars.length - 1;
  let best = "";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = build(mid);
    if (measure(candidate) <= maxWidth) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best === "" ? ELLIPSIS : best;
}

export interface FitOptions {
  /** Everything around the name: icon, gaps, padding, chevron. */
  chrome: number;
  min: number;
  max: number;
}

/**
 * How wide a column should be to show its longest entry.
 *
 * Only the longest few names are measured. Character count correlates closely
 * enough with pixel width to pick the candidates, and measuring all of them
 * would mean a hundred thousand canvas calls for one large directory.
 */
const CANDIDATES = 40;

export function fitColumnWidth(
  names: readonly string[],
  measure: Measure,
  { chrome, min, max }: FitOptions,
): number {
  if (names.length === 0) return min;

  // One O(n) pass to find the longest candidates by character count.
  const longest: string[] = [];
  let shortestKept = 0;
  for (const name of names) {
    if (longest.length < CANDIDATES) {
      longest.push(name);
      if (longest.length === CANDIDATES) {
        longest.sort((a, b) => a.length - b.length);
        shortestKept = longest[0].length;
      }
      continue;
    }
    if (name.length > shortestKept) {
      longest[0] = name;
      longest.sort((a, b) => a.length - b.length);
      shortestKept = longest[0].length;
    }
  }

  let widest = 0;
  for (const name of longest) {
    const w = measure(name);
    if (w > widest) widest = w;
  }

  return Math.round(Math.min(max, Math.max(min, widest + chrome)));
}

/**
 * A column sizes itself to its longest entry, within these bounds.
 *
 * The maximum is the judgement call. Windows allows 255-character names, and a
 * column that honoured one would swallow the whole window. 400px fits roughly
 * fifty characters of the UI font, which covers the overwhelming majority of
 * real names; anything longer is elided in the middle instead, so the start AND
 * the extension both stay readable.
 */
export const MIN_COLUMN_W = 150;
export const MAX_COLUMN_W = 400;

/** No single column may take more than this share of the visible strip. */
const MAX_COLUMN_SHARE = 0.55;

/**
 * The largest a column may become, given how much room there is.
 *
 * The absolute cap alone is not enough: at the 720px minimum window size, 400px
 * is over three quarters of the strip, leaving nowhere to see where you came
 * from. Scaling with the window keeps a second column in sight on a small
 * screen while changing nothing on a large one.
 */
export function columnWidthCap(stripWidth: number): number {
  if (stripWidth <= 0) return MAX_COLUMN_W;
  return Math.max(MIN_COLUMN_W, Math.min(MAX_COLUMN_W, stripWidth * MAX_COLUMN_SHARE));
}
