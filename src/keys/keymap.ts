/**
 * The declarative keyboard map.
 *
 * Every binding is expressed in terms of the store and the `OrderSource`
 * registry, never in terms of a view. That is what lets a view implement three
 * small callbacks (`onArrowLeft`, `onArrowRight`, `activateDir`) and inherit
 * roughly forty shortcuts.
 *
 * Combos are exhaustive rather than clever: `shift+arrowdown` has its own entry
 * instead of falling back to `arrowdown` and inspecting the modifier. A single
 * lookup with no fallback rule is far easier to reason about, and `assertNoDuplicateCombos`
 * makes a collision a test failure rather than a silent shadowing.
 *
 * Because the table is data, the "Keyboard Shortcuts" sheet is generated from it
 * rather than maintained separately.
 */

import { orderRegistry, type KeyCtx } from "../order/registry";
import { appState } from "../store/appStore";

/**
 * Callbacks the shell supplies. Actions belonging to phases that are not built
 * yet are simply absent; the runner reports an unwired action in dev instead of
 * silently doing nothing, which would be a debugging trap.
 */
export interface KeyDeps {
  openCursor(): void;
  renameCursor(): void;
  newFolder(): void;
  deleteSelection(permanent: boolean): void;
  paste(): void;
  duplicateSelection(): void;
  undo(): void;
  reload(): void;
  focusFilter(): void;
  focusPathBar(): void;
  startRecursiveSearch(): void;
  revealCursor(): void;
  showShortcuts(): void;
  /** Rows per viewport, for PageUp / PageDown. */
  pageSize(): number;
}

export type BindingGroup = "Navigate" | "Select" | "View" | "Edit" | "Find";

export interface Binding {
  id: string;
  /** Normalized combo -- see `comboOf`. Unique across the table. */
  combo: string;
  /** Human label for the generated shortcut sheet. */
  label: string;
  group: BindingGroup;
  /** Omitted from the generated sheet, for aliases of a listed binding. */
  alias?: boolean;
  run(ctx: KeyCtx, deps: Partial<KeyDeps>): void;
}

function unwired(name: string): void {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(`[keys] action "${name}" is not wired up yet`);
  }
}

function call(deps: Partial<KeyDeps>, name: keyof KeyDeps): void {
  const fn = deps[name];
  if (typeof fn === "function") (fn as () => void)();
  else unwired(name);
}

const DEFAULT_PAGE = 10;

export const BINDINGS: Binding[] = [
  // -- Navigate -------------------------------------------------------------
  {
    id: "cursor.down",
    combo: "arrowdown",
    label: "Move down",
    group: "Navigate",
    run: () => appState().moveCursor(1, false),
  },
  {
    id: "cursor.up",
    combo: "arrowup",
    label: "Move up",
    group: "Navigate",
    run: () => appState().moveCursor(-1, false),
  },
  {
    id: "nav.left",
    combo: "arrowleft",
    label: "Collapse, or previous column",
    group: "Navigate",
    run: (c) => {
      orderRegistry.source()?.onArrowLeft?.(c);
    },
  },
  {
    id: "nav.right",
    combo: "arrowright",
    label: "Expand, or next column",
    group: "Navigate",
    run: (c) => {
      orderRegistry.source()?.onArrowRight?.(c);
    },
  },
  {
    id: "cursor.home",
    combo: "home",
    label: "First item",
    group: "Navigate",
    run: () => appState().moveCursor("home", false),
  },
  {
    id: "cursor.end",
    combo: "end",
    label: "Last item",
    group: "Navigate",
    run: () => appState().moveCursor("end", false),
  },
  {
    id: "cursor.pagedown",
    combo: "pagedown",
    label: "Page down",
    group: "Navigate",
    run: (_c, deps) => appState().moveCursor(deps.pageSize?.() ?? DEFAULT_PAGE, false),
  },
  {
    id: "cursor.pageup",
    combo: "pageup",
    label: "Page up",
    group: "Navigate",
    run: (_c, deps) => appState().moveCursor(-(deps.pageSize?.() ?? DEFAULT_PAGE), false),
  },
  {
    id: "nav.back",
    combo: "alt+arrowleft",
    label: "Back",
    group: "Navigate",
    run: () => appState().back(),
  },
  {
    id: "nav.back.backspace",
    combo: "backspace",
    label: "Back",
    group: "Navigate",
    alias: true,
    run: () => appState().back(),
  },
  {
    id: "nav.forward",
    combo: "alt+arrowright",
    label: "Forward",
    group: "Navigate",
    run: () => appState().forward(),
  },
  {
    id: "nav.up",
    combo: "alt+arrowup",
    label: "Enclosing folder",
    group: "Navigate",
    run: () => appState().up(),
  },

  // -- Select ---------------------------------------------------------------
  {
    id: "cursor.down.extend",
    combo: "shift+arrowdown",
    label: "Extend selection down",
    group: "Select",
    run: () => appState().moveCursor(1, true),
  },
  {
    id: "cursor.up.extend",
    combo: "shift+arrowup",
    label: "Extend selection up",
    group: "Select",
    run: () => appState().moveCursor(-1, true),
  },
  {
    id: "cursor.home.extend",
    combo: "shift+home",
    label: "Extend to first item",
    group: "Select",
    run: () => appState().moveCursor("home", true),
  },
  {
    id: "cursor.end.extend",
    combo: "shift+end",
    label: "Extend to last item",
    group: "Select",
    run: () => appState().moveCursor("end", true),
  },
  {
    id: "cursor.pagedown.extend",
    combo: "shift+pagedown",
    label: "Extend selection a page down",
    group: "Select",
    run: (_c, deps) => appState().moveCursor(deps.pageSize?.() ?? DEFAULT_PAGE, true),
  },
  {
    id: "cursor.pageup.extend",
    combo: "shift+pageup",
    label: "Extend selection a page up",
    group: "Select",
    run: (_c, deps) => appState().moveCursor(-(deps.pageSize?.() ?? DEFAULT_PAGE), true),
  },
  {
    id: "nav.left.extend",
    combo: "shift+arrowleft",
    label: "Extend across columns",
    group: "Select",
    run: (c) => {
      orderRegistry.source()?.onArrowLeft?.(c);
    },
  },
  {
    id: "nav.right.extend",
    combo: "shift+arrowright",
    label: "Extend across columns",
    group: "Select",
    alias: true,
    run: (c) => {
      orderRegistry.source()?.onArrowRight?.(c);
    },
  },
  {
    // Explorer convention: Ctrl+arrow moves focus without disturbing the
    // selection. It deliberately does NOT mean "open" (Enter does) nor
    // "enclosing folder" (Alt+Up does), both of which would collide here.
    id: "cursor.down.only",
    combo: "ctrl+arrowdown",
    label: "Move focus down, keeping the selection",
    group: "Select",
    run: () => appState().moveCursorOnly(1),
  },
  {
    id: "cursor.up.only",
    combo: "ctrl+arrowup",
    label: "Move focus up, keeping the selection",
    group: "Select",
    run: () => appState().moveCursorOnly(-1),
  },
  {
    id: "select.all",
    combo: "ctrl+a",
    label: "Select all",
    group: "Select",
    run: () => appState().selectAll(),
  },
  {
    id: "select.none",
    combo: "ctrl+shift+a",
    label: "Deselect all",
    group: "Select",
    run: () => appState().clearSelection(),
  },

  // -- Edit -----------------------------------------------------------------
  {
    // Enter opens and F2 renames -- Windows semantics, not Finder's.
    // Enter-to-rename is the one mismatch that is data-adjacent: a user
    // double-taps Enter expecting to open a folder, lands in rename mode on a
    // file, and the next keystroke starts destroying the filename.
    id: "open",
    combo: "enter",
    label: "Open",
    group: "Edit",
    run: (_c, deps) => call(deps, "openCursor"),
  },
  {
    id: "edit.rename",
    combo: "f2",
    label: "Rename",
    group: "Edit",
    run: (_c, deps) => call(deps, "renameCursor"),
  },
  {
    id: "edit.newfolder",
    combo: "ctrl+shift+n",
    label: "New folder",
    group: "Edit",
    run: (_c, deps) => call(deps, "newFolder"),
  },
  {
    id: "edit.duplicate",
    combo: "ctrl+d",
    label: "Duplicate",
    group: "Edit",
    run: (_c, deps) => call(deps, "duplicateSelection"),
  },
  {
    id: "edit.trash",
    combo: "delete",
    label: "Move to Recycle Bin",
    group: "Edit",
    run: (_c, deps) => {
      if (deps.deleteSelection) deps.deleteSelection(false);
      else unwired("deleteSelection");
    },
  },
  {
    id: "edit.delete.permanent",
    combo: "shift+delete",
    label: "Delete permanently",
    group: "Edit",
    run: (_c, deps) => {
      if (deps.deleteSelection) deps.deleteSelection(true);
      else unwired("deleteSelection");
    },
  },
  {
    id: "edit.copy",
    combo: "ctrl+c",
    label: "Copy",
    group: "Edit",
    run: () => appState().copySelection(),
  },
  {
    id: "edit.cut",
    combo: "ctrl+x",
    label: "Cut",
    group: "Edit",
    run: () => appState().cutSelection(),
  },
  {
    id: "edit.paste",
    combo: "ctrl+v",
    label: "Paste",
    group: "Edit",
    run: (_c, deps) => call(deps, "paste"),
  },
  {
    id: "edit.undo",
    combo: "ctrl+z",
    label: "Undo",
    group: "Edit",
    run: (_c, deps) => call(deps, "undo"),
  },

  // -- View -----------------------------------------------------------------
  {
    id: "ql.toggle",
    combo: "space",
    label: "Quick Look",
    group: "View",
    run: () => appState().toggleQuickLook(),
  },
  {
    id: "view.list",
    combo: "ctrl+1",
    label: "List view",
    group: "View",
    run: () => appState().setViewMode("list"),
  },
  {
    id: "view.column",
    combo: "ctrl+2",
    label: "Column view",
    group: "View",
    run: () => appState().setViewMode("column"),
  },
  {
    id: "view.tree",
    combo: "ctrl+3",
    label: "Tree view",
    group: "View",
    run: () => appState().setViewMode("tree"),
  },
  {
    id: "view.hidden",
    combo: "ctrl+h",
    label: "Show hidden files",
    group: "View",
    run: () => appState().toggleHidden(),
  },
  {
    id: "view.system",
    combo: "ctrl+shift+h",
    label: "Show system files",
    group: "View",
    run: () => appState().toggleSystem(),
  },
  {
    id: "view.preview",
    combo: "ctrl+,",
    label: "Show preview pane",
    group: "View",
    run: () => appState().togglePreview(),
  },
  {
    id: "view.reload",
    combo: "ctrl+r",
    label: "Reload",
    group: "View",
    run: (_c, deps) => call(deps, "reload"),
  },
  {
    id: "view.reload.f5",
    combo: "f5",
    label: "Reload",
    group: "View",
    alias: true,
    run: (_c, deps) => call(deps, "reload"),
  },
  {
    id: "view.shortcuts",
    combo: "ctrl+/",
    label: "Keyboard shortcuts",
    group: "View",
    run: (_c, deps) => call(deps, "showShortcuts"),
  },

  // -- Find -----------------------------------------------------------------
  {
    id: "find.filter",
    combo: "ctrl+f",
    label: "Filter this folder",
    group: "Find",
    run: (_c, deps) => call(deps, "focusFilter"),
  },
  {
    id: "find.recursive",
    combo: "ctrl+shift+f",
    label: "Search subfolders",
    group: "Find",
    run: (_c, deps) => call(deps, "startRecursiveSearch"),
  },
  {
    id: "find.pathbar",
    combo: "ctrl+l",
    label: "Edit path",
    group: "Find",
    run: (_c, deps) => call(deps, "focusPathBar"),
  },
  {
    id: "find.reveal",
    combo: "ctrl+shift+e",
    label: "Reveal in Explorer",
    group: "Find",
    run: (_c, deps) => call(deps, "revealCursor"),
  },
];

export interface ComboSource {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
}

/**
 * Normalize a keyboard event into a lookup string.
 *
 * Modifier order is fixed (ctrl, alt, shift) and keys are lower-cased, so
 * `Ctrl+Shift+N` and `Ctrl+Shift+n` are one combo. The space bar is spelled
 * "space" rather than " ", which would be invisible in the table.
 */
export function comboOf(e: ComboSource): string {
  const key = e.key === " " ? "space" : e.key.toLowerCase();
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

const TABLE = new Map<string, Binding>();
for (const b of BINDINGS) {
  if (!TABLE.has(b.combo)) TABLE.set(b.combo, b);
}

/** Resolve an event to its binding, or `undefined` when unbound. */
export function matchBinding(e: ComboSource): Binding | undefined {
  return TABLE.get(comboOf(e));
}

/**
 * Every combo bound to more than one action. Must be empty: a duplicate means
 * one of the two actions is unreachable, which is the kind of bug that only
 * shows up as "that shortcut does nothing".
 */
export function duplicateCombos(): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const b of BINDINGS) {
    if (seen.has(b.combo)) dupes.add(b.combo);
    seen.add(b.combo);
  }
  return [...dupes];
}

/** Grouped bindings for the generated shortcut sheet, aliases omitted. */
export function bindingsByGroup(): Array<[BindingGroup, Binding[]]> {
  const order: BindingGroup[] = ["Navigate", "Select", "View", "Edit", "Find"];
  return order.map((g) => [g, BINDINGS.filter((b) => b.group === g && !b.alias)]);
}

/** Render a combo for display, e.g. "ctrl+shift+n" -> "Ctrl+Shift+N". */
export function prettyCombo(combo: string): string {
  return combo
    .split("+")
    .map((part) => {
      switch (part) {
        case "ctrl":
          return "Ctrl";
        case "alt":
          return "Alt";
        case "shift":
          return "Shift";
        case "space":
          return "Space";
        case "arrowup":
          return "Up";
        case "arrowdown":
          return "Down";
        case "arrowleft":
          return "Left";
        case "arrowright":
          return "Right";
        case "pageup":
          return "PgUp";
        case "pagedown":
          return "PgDn";
        default:
          return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1);
      }
    })
    .join("+");
}
