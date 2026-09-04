import { describe, expect, it } from "vitest";

import {
  BINDINGS,
  bindingsByGroup,
  comboOf,
  duplicateCombos,
  matchBinding,
  prettyCombo,
} from "./keymap";

function ev(over: Partial<Parameters<typeof comboOf>[0]> & { key: string }) {
  return { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over };
}

describe("comboOf", () => {
  it("orders modifiers consistently", () => {
    expect(comboOf(ev({ key: "n", ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+n");
    expect(comboOf(ev({ key: "ArrowLeft", altKey: true }))).toBe("alt+arrowleft");
  });

  it("lower-cases keys so letter case cannot fork a combo", () => {
    expect(comboOf(ev({ key: "N", ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+n");
    expect(comboOf(ev({ key: "n", ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+n");
  });

  it("spells the space bar rather than using an invisible character", () => {
    expect(comboOf(ev({ key: " " }))).toBe("space");
  });

  it("treats the meta key as ctrl, for anyone on a Mac keyboard", () => {
    expect(comboOf(ev({ key: "c", metaKey: true }))).toBe("ctrl+c");
  });
});

describe("the table itself", () => {
  it("binds no combo twice", () => {
    // A duplicate silently shadows one of the two actions, which surfaces only
    // as "that shortcut does nothing".
    expect(duplicateCombos()).toEqual([]);
  });

  it("gives every binding a unique id", () => {
    const ids = BINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only normalized combos", () => {
    for (const b of BINDINGS) {
      expect(b.combo, `${b.id} must be lower-case`).toBe(b.combo.toLowerCase());
      const parts = b.combo.split("+");
      const mods = parts.slice(0, -1);
      expect(mods, `${b.id} must order modifiers ctrl, alt, shift`).toEqual(
        ["ctrl", "alt", "shift"].filter((m) => mods.includes(m)),
      );
    }
  });
});

describe("matchBinding", () => {
  it("resolves plain and shifted arrows to different actions", () => {
    expect(matchBinding(ev({ key: "ArrowDown" }))?.id).toBe("cursor.down");
    expect(matchBinding(ev({ key: "ArrowDown", shiftKey: true }))?.id).toBe("cursor.down.extend");
  });

  it("resolves Ctrl+arrow to focus-only movement, not open or parent", () => {
    // Both of those would collide on this combo; the collision test above is
    // what keeps that decision honest.
    expect(matchBinding(ev({ key: "ArrowDown", ctrlKey: true }))?.id).toBe("cursor.down.only");
    expect(matchBinding(ev({ key: "ArrowUp", ctrlKey: true }))?.id).toBe("cursor.up.only");
  });

  it("maps Enter to open and F2 to rename, not the other way round", () => {
    expect(matchBinding(ev({ key: "Enter" }))?.id).toBe("open");
    expect(matchBinding(ev({ key: "F2" }))?.id).toBe("edit.rename");
  });

  it("distinguishes Delete from Shift+Delete", () => {
    expect(matchBinding(ev({ key: "Delete" }))?.id).toBe("edit.trash");
    expect(matchBinding(ev({ key: "Delete", shiftKey: true }))?.id).toBe(
      "edit.delete.permanent",
    );
  });

  it("maps the three view-mode shortcuts", () => {
    expect(matchBinding(ev({ key: "1", ctrlKey: true }))?.id).toBe("view.list");
    expect(matchBinding(ev({ key: "2", ctrlKey: true }))?.id).toBe("view.column");
    expect(matchBinding(ev({ key: "3", ctrlKey: true }))?.id).toBe("view.tree");
  });

  it("separates filter from recursive search", () => {
    expect(matchBinding(ev({ key: "f", ctrlKey: true }))?.id).toBe("find.filter");
    expect(matchBinding(ev({ key: "f", ctrlKey: true, shiftKey: true }))?.id).toBe(
      "find.recursive",
    );
  });

  it("returns undefined for an unbound key", () => {
    expect(matchBinding(ev({ key: "q", ctrlKey: true }))).toBeUndefined();
    expect(matchBinding(ev({ key: "F9" }))).toBeUndefined();
  });
});

describe("generated shortcut sheet", () => {
  it("covers every group and omits aliases", () => {
    const groups = bindingsByGroup();
    expect(groups.map(([g]) => g)).toEqual(["Navigate", "Select", "View", "Edit", "Find"]);
    for (const [, list] of groups) {
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((b) => !b.alias)).toBe(true);
    }
  });

  it("lists Back once even though three keys trigger it", () => {
    const nav = bindingsByGroup()[0][1];
    expect(nav.filter((b) => b.label === "Back")).toHaveLength(1);
  });
});

describe("prettyCombo", () => {
  it("renders combos the way a menu would", () => {
    expect(prettyCombo("ctrl+shift+n")).toBe("Ctrl+Shift+N");
    expect(prettyCombo("alt+arrowleft")).toBe("Alt+Left");
    expect(prettyCombo("space")).toBe("Space");
    expect(prettyCombo("pagedown")).toBe("PgDn");
    expect(prettyCombo("f2")).toBe("F2");
  });
});
