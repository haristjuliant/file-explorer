import { beforeEach, describe, expect, it } from "vitest";

import { orderRegistry, type VisibleOrder } from "../order/registry";
import { PREVIEW_COLUMN, useAppStore } from "./appStore";

const D = "\\";
const ROOT = `C:${D}Users${D}User`;
const P = ["a", "b", "c", "d", "e"].map((n) => `${ROOT}${D}${n}`);
const [A, B, C, DD, E] = P;

/** Install a fake order source and capture what it was asked to reveal. */
function registerOrder(paths: string[] = P) {
  const index = new Map(paths.map((p, i) => [p, i] as const));
  const revealed: number[] = [];
  const order: VisibleOrder = {
    paths,
    index,
    scopeOf: () => ROOT,
    entryOf: () => undefined,
  };
  const unregister = orderRegistry.register({
    view: "list",
    getOrder: () => order,
    reveal: (i) => revealed.push(i),
  });
  return { unregister, revealed };
}

const s = () => useAppStore.getState();
const sel = () => [...s().selection].sort();

const INITIAL = useAppStore.getState();

beforeEach(() => {
  orderRegistry.reset();
  useAppStore.setState(INITIAL, true);
});

describe("selection gestures", () => {
  it("click replaces the selection and sets both cursor and anchor", () => {
    registerOrder();
    s().select(C);
    expect(sel()).toEqual([C]);
    expect(s().cursor).toBe(C);
    expect(s().anchor).toBe(C);
  });

  it("ctrl+click toggles without disturbing the rest", () => {
    registerOrder();
    s().select(A);
    s().toggle(C);
    expect(sel()).toEqual([A, C].sort());
    expect(s().cursor).toBe(C);
    expect(s().anchor).toBe(C);
  });

  it("ctrl+click that removes an item leaves the anchor where it was", () => {
    registerOrder();
    s().select(A);
    s().toggle(C);
    s().toggle(C);
    expect(sel()).toEqual([A]);
    // Removing must not relocate the origin of a later shift-range.
    expect(s().anchor).toBe(C);
  });

  it("shift+click selects the range from the anchor and keeps the anchor", () => {
    registerOrder();
    s().select(B);
    s().selectRange(DD);
    expect(sel()).toEqual([B, C, DD].sort());
    expect(s().cursor).toBe(DD);
    expect(s().anchor).toBe(B);
  });

  it("a second shift+click replaces the range rather than growing it", () => {
    registerOrder();
    s().select(C);
    s().selectRange(E);
    s().selectRange(A);
    expect(sel()).toEqual([A, B, C].sort());
    expect(s().anchor).toBe(C);
  });

  it("ctrl+shift+click adds a range to what is already selected", () => {
    registerOrder();
    // Reached by: click A, shift-click nothing yet, ctrl-click E -- leaving E
    // selected with the anchor still back at A.
    s().select(A);
    s().toggle(E);
    useAppStore.setState({ anchor: A });
    s().addRange(B);
    expect(sel()).toEqual([A, B, E].sort());
  });

  it("ctrl+a selects everything in the active order", () => {
    registerOrder();
    s().selectAll();
    expect(sel()).toEqual([...P].sort());
  });

  it("ctrl+a on an empty order does nothing", () => {
    registerOrder([]);
    s().selectAll();
    expect(sel()).toEqual([]);
    expect(s().cursor).toBeNull();
  });

  it("clicking empty space clears everything", () => {
    registerOrder();
    s().select(C);
    s().clearSelection();
    expect(sel()).toEqual([]);
    expect(s().cursor).toBeNull();
    expect(s().anchor).toBeNull();
  });
});

describe("moveCursor", () => {
  it("moves one row and replaces the selection", () => {
    registerOrder();
    s().select(B);
    s().moveCursor(1, false);
    expect(s().cursor).toBe(C);
    expect(sel()).toEqual([C]);
    expect(s().anchor).toBe(C);
  });

  it("enters at the first row when moving down with no cursor", () => {
    registerOrder();
    s().moveCursor(1, false);
    expect(s().cursor).toBe(A);
  });

  it("enters at the last row when moving up with no cursor", () => {
    registerOrder();
    s().moveCursor(-1, false);
    expect(s().cursor).toBe(E);
  });

  it("clamps at the ends instead of wrapping", () => {
    registerOrder();
    s().select(E);
    s().moveCursor(1, false);
    expect(s().cursor).toBe(E);
    s().select(A);
    s().moveCursor(-1, false);
    expect(s().cursor).toBe(A);
  });

  it("shift+arrow extends from the anchor", () => {
    registerOrder();
    s().select(B);
    s().moveCursor(1, true);
    s().moveCursor(1, true);
    expect(sel()).toEqual([B, C, DD].sort());
    expect(s().anchor).toBe(B);
  });

  it("shift+arrow can SHRINK a range back again", () => {
    // The regression this guards: re-anchoring on every move makes a range
    // grow in both directions and never shrink.
    registerOrder();
    s().select(A);
    s().moveCursor(1, true);
    s().moveCursor(1, true);
    s().moveCursor(1, true);
    expect(sel()).toEqual([A, B, C, DD].sort());

    s().moveCursor(-1, true);
    expect(sel()).toEqual([A, B, C].sort());
    s().moveCursor(-1, true);
    expect(sel()).toEqual([A, B].sort());
    expect(s().anchor).toBe(A);
  });

  it("home and end jump to the ends", () => {
    registerOrder();
    s().select(C);
    s().moveCursor("home", false);
    expect(s().cursor).toBe(A);
    s().moveCursor("end", false);
    expect(s().cursor).toBe(E);
  });

  it("shift+end extends to the last row", () => {
    registerOrder();
    s().select(DD);
    s().moveCursor("end", true);
    expect(sel()).toEqual([DD, E].sort());
  });

  it("a page jump is just a larger delta, clamped", () => {
    registerOrder();
    s().select(A);
    s().moveCursor(20, false);
    expect(s().cursor).toBe(E);
  });

  it("ctrl+arrow moves focus without changing the selection", () => {
    registerOrder();
    s().select(A);
    s().moveCursorOnly(2);
    expect(s().cursor).toBe(C);
    expect(sel()).toEqual([A]);
    expect(s().anchor).toBe(A);
  });

  it("asks the view to reveal the new index, after the commit", async () => {
    const { revealed } = registerOrder();
    s().select(A);
    s().moveCursor(2, false);
    expect(revealed).toEqual([]); // deferred, so the virtualizer sees the committed count
    await Promise.resolve();
    expect(revealed).toEqual([2]);
  });

  it("does nothing when no order source is registered", () => {
    s().moveCursor(1, false);
    expect(s().cursor).toBeNull();
  });
});

describe("navigation", () => {
  it("records history and enables back", () => {
    s().navigate(ROOT);
    expect(s().cwd).toBe(ROOT);
    expect(s().canBack).toBe(false);

    s().navigate(`${ROOT}${D}Documents`);
    expect(s().canBack).toBe(true);
    expect(s().canForward).toBe(false);

    s().back();
    expect(s().cwd).toBe(ROOT);
    expect(s().canForward).toBe(true);

    s().forward();
    expect(s().cwd).toBe(`${ROOT}${D}Documents`);
  });

  it("truncates the forward tail when navigating after going back", () => {
    s().navigate(`C:${D}A`);
    s().navigate(`C:${D}B`);
    s().navigate(`C:${D}C`);
    s().back();
    s().navigate(`C:${D}D`);
    expect(s().canForward).toBe(false);
    expect(s().history).toEqual([`C:${D}A`, `C:${D}B`, `C:${D}D`]);
  });

  it("normalises the target so one directory cannot enter history twice", () => {
    s().navigate("C:/Users/User");
    const before = s().history.length;
    s().navigate(`c:${D}Users${D}User${D}`);
    expect(s().history.length).toBe(before);
    expect(s().cwd).toBe(ROOT);
  });

  it("clears selection, filter and Quick Look on arrival", () => {
    registerOrder();
    s().navigate(ROOT);
    s().select(C);
    s().openQuickLook();
    s().setFilterQuery("abc");
    expect(s().quickLookOpen).toBe(true);

    s().navigate(`${ROOT}${D}Documents`);
    expect(sel()).toEqual([]);
    expect(s().cursor).toBeNull();
    expect(s().quickLookOpen).toBe(false);
    expect(s().filterQuery).toBe("");
  });

  it("roots the column chain at the new directory, not its ancestry", () => {
    // Arriving somewhere makes it the leftmost column. Rebuilding the whole
    // ancestry would leave the column strip scrolled far right before the user
    // has opened anything.
    s().navigate(ROOT);
    expect(s().columnChain).toEqual([ROOT]);
  });

  it("up goes to the parent and stops at the drive root", () => {
    s().navigate(ROOT);
    s().up();
    expect(s().cwd).toBe(`C:${D}Users`);
    s().up();
    expect(s().cwd).toBe(`C:${D}`);
    s().up();
    expect(s().cwd).toBe(`C:${D}`);
  });

  it("ignores an empty target", () => {
    s().navigate(ROOT);
    s().navigate("   ");
    expect(s().cwd).toBe(ROOT);
  });
});

describe("sorting", () => {
  it("flips direction when the same column is clicked again", () => {
    s().setSort("name");
    expect(s().sortDir).toBe(-1);
    s().setSort("name");
    expect(s().sortDir).toBe(1);
  });

  it("resets to the natural direction when the column changes", () => {
    s().setSort("size");
    expect(s().sortKey).toBe("size");
    // Size and date start descending: biggest and newest first, as in Finder.
    expect(s().sortDir).toBe(-1);
    s().setSort("kind");
    expect(s().sortDir).toBe(1);
  });
});

describe("tree expansion", () => {
  it("expands and collapses", () => {
    s().toggleTreeExpanded(ROOT);
    expect(s().treeExpanded.has(ROOT)).toBe(true);
    s().toggleTreeExpanded(ROOT);
    expect(s().treeExpanded.has(ROOT)).toBe(false);
  });

  it("honours an explicit force flag idempotently", () => {
    s().toggleTreeExpanded(ROOT, true);
    s().toggleTreeExpanded(ROOT, true);
    expect(s().treeExpanded.has(ROOT)).toBe(true);
  });

  it("rescues the cursor when collapsing the subtree that contains it", () => {
    // Otherwise the cursor vanishes from the visible order and every arrow
    // press restarts at the top of the list.
    const child = `${ROOT}${D}Documents${D}notes.txt`;
    useAppStore.setState({
      treeExpanded: new Set([ROOT]),
      cursor: child,
      anchor: child,
      selection: new Set([child]),
    });
    s().toggleTreeExpanded(ROOT, false);
    expect(s().cursor).toBe(ROOT);
    expect(sel()).toEqual([ROOT]);
  });

  it("leaves a cursor outside the subtree alone", () => {
    const other = `C:${D}Other${D}x.txt`;
    useAppStore.setState({
      treeExpanded: new Set([ROOT]),
      cursor: other,
      anchor: other,
      selection: new Set([other]),
    });
    s().toggleTreeExpanded(ROOT, false);
    expect(s().cursor).toBe(other);
  });
});

describe("column chain", () => {
  it("pushing at a depth truncates everything to its right", () => {
    s().navigate(ROOT);
    s().pushColumn(1, `${ROOT}${D}Documents`);
    s().pushColumn(2, `${ROOT}${D}Documents${D}Deep`);
    expect(s().columnChain).toHaveLength(3);

    s().pushColumn(1, `${ROOT}${D}Other`);
    expect(s().columnChain).toEqual([ROOT, `${ROOT}${D}Other`]);
  });

  it("selecting a file puts the preview sentinel in the trailing slot", () => {
    s().navigate(ROOT);
    s().pushColumn(3, PREVIEW_COLUMN);
    expect(s().columnChain[3]).toBe(PREVIEW_COLUMN);
  });

  it("prepending the parent puts it to the left of the current root", () => {
    s().navigate(ROOT);
    expect(s().columnChain).toEqual([ROOT]);

    // How arrow-left at the leftmost column walks upwards.
    s().prependColumn(`C:${D}Users`);
    expect(s().columnChain).toEqual([`C:${D}Users`, ROOT]);
  });

  it("prepending is a no-op when that folder is already leftmost", () => {
    s().navigate(ROOT);
    s().prependColumn(ROOT);
    expect(s().columnChain).toEqual([ROOT]);
  });
});

describe("view mode handoff", () => {
  it("roots the column strip at the current folder when switching to it", () => {
    useAppStore.setState({ viewMode: "list", cwd: ROOT, cursor: null });
    s().setViewMode("column");
    expect(s().columnChain).toEqual([ROOT]);
  });

  it("uses the cursor's parent as the new directory when leaving tree mode", () => {
    const deep = `${ROOT}${D}Documents${D}Projects${D}app.tsx`;
    useAppStore.setState({ viewMode: "tree", cwd: ROOT, cursor: deep });
    s().setViewMode("list");
    expect(s().cwd).toBe(`${ROOT}${D}Documents${D}Projects`);
  });

  it("keeps the directory when there is no cursor to hand off", () => {
    useAppStore.setState({ viewMode: "tree", cwd: ROOT, cursor: null });
    s().setViewMode("list");
    expect(s().cwd).toBe(ROOT);
  });
});

describe("clipboard", () => {
  it("copies and cuts the current selection", () => {
    registerOrder();
    s().select(A);
    s().toggle(C);
    s().copySelection();
    expect(s().clipboard?.mode).toBe("copy");
    expect([...(s().clipboard?.paths ?? [])].sort()).toEqual([A, C].sort());

    s().cutSelection();
    expect(s().clipboard?.mode).toBe("cut");
  });

  it("refuses to put an empty selection on the clipboard", () => {
    s().copySelection();
    expect(s().clipboard).toBeNull();
  });
});

describe("Quick Look and rename", () => {
  it("will not open without a cursor to preview", () => {
    s().openQuickLook();
    expect(s().quickLookOpen).toBe(false);
  });

  it("toggles once a cursor exists", () => {
    registerOrder();
    s().select(C);
    s().toggleQuickLook();
    expect(s().quickLookOpen).toBe(true);
    s().toggleQuickLook();
    expect(s().quickLookOpen).toBe(false);
  });

  it("starting a rename closes Quick Look and any context menu", () => {
    registerOrder();
    s().select(C);
    s().openQuickLook();
    s().openContextMenu({ x: 1, y: 2, paths: [C] });
    s().beginRename(C);
    expect(s().renamingPath).toBe(C);
    expect(s().quickLookOpen).toBe(false);
    expect(s().contextMenu).toBeNull();
  });
});

describe("chrome dimensions", () => {
  it("clamps the sidebar and preview widths", () => {
    s().setSidebarWidth(10);
    expect(s().sidebarWidth).toBe(150);
    s().setSidebarWidth(9999);
    expect(s().sidebarWidth).toBe(420);
    s().setPreviewWidth(10);
    expect(s().previewWidth).toBe(200);
  });

  it("enforces a wider minimum for the name column", () => {
    s().setListColumnWidth("name", 10);
    expect(s().listColumnWidths.name).toBe(120);
    s().setListColumnWidth("size", 10);
    expect(s().listColumnWidths.size).toBe(60);
  });
});
