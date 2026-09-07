import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guards the row layout contract.
 *
 * `.fm-row` and each view's own row class have identical specificity, so
 * whichever the bundler emits last wins. When `.fm-row` carried `display: flex`
 * it silently overrode `display: grid` on the list, tree and search rows,
 * turning them into flex containers sized by content: the first column still
 * lined up with its header because it sits at the left edge, and every column
 * after it drifted.
 *
 * A cascade bug like that cannot be caught in jsdom, which does no layout. It
 * can be caught at the source, which is what this does.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Body of the first rule whose selector list matches exactly. */
function ruleBody(css: string, selector: string): string | null {
  const pattern = new RegExp(
    `(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "m",
  );
  return pattern.exec(css)?.[2] ?? null;
}

const declares = (body: string, prop: string) =>
  new RegExp(`(^|;|\\s)${prop}\\s*:`).test(body);

/** Properties that decide where a cell lands, as opposed to how it looks. */
const LAYOUT_PROPS = ["display", "grid-template-columns", "gap", "padding", "margin"];

describe(".fm-row", () => {
  const body = ruleBody(read("./base.css"), ".fm-row");

  it("exists", () => {
    expect(body).not.toBeNull();
  });

  it.each(LAYOUT_PROPS)("does not set %s", (prop) => {
    // Layout belongs to the view that owns the row. Putting any of these back
    // here reintroduces the misalignment, because the two rules tie on
    // specificity and source order decides the winner.
    expect(declares(body ?? "", prop)).toBe(false);
  });

  it("still carries the shared appearance", () => {
    expect(declares(body ?? "", "height")).toBe(true);
    expect(declares(body ?? "", "color")).toBe(true);
  });
});

describe("view row classes own their own layout", () => {
  const cases: Array<{ file: string; selector: string; display: string }> = [
    { file: "../views/list.css", selector: ".fm-list-header,\n.fm-list-row", display: "grid" },
    { file: "../views/tree.css", selector: ".fm-tree-row", display: "grid" },
    { file: "../views/search.css", selector: ".fm-search-header,\n.fm-search-row", display: "grid" },
    { file: "../views/column.css", selector: ".fm-column-row", display: "flex" },
  ];

  for (const { file, selector, display } of cases) {
    const label = selector.split("\n").pop() ?? selector;

    it(`${label} sets display: ${display} itself`, () => {
      const body = ruleBody(read(file), selector);
      expect(body, `${selector} not found in ${file}`).not.toBeNull();
      expect(body).toMatch(new RegExp(`display:\\s*${display}`));
    });
  }

  it("the list header and its rows share one grid template", () => {
    // They are declared as one rule precisely so they cannot drift apart; if
    // someone splits them, this fails.
    const css = read("../views/list.css");
    const body = ruleBody(css, ".fm-list-header,\n.fm-list-row");
    expect(body).toMatch(/grid-template-columns:/);
    expect(body).toMatch(/--fm-col-name/);
    expect(body).toMatch(/--fm-col-modified/);
    expect(body).toMatch(/--fm-col-size/);
    expect(body).toMatch(/--fm-col-kind/);
  });

  it("the search header and its rows share one grid template", () => {
    const body = ruleBody(read("../views/search.css"), ".fm-search-header,\n.fm-search-row");
    expect(body).toMatch(/grid-template-columns:/);
  });

  it("list cells and headers use the same horizontal padding", () => {
    // A cell padded differently from its header is the other way these drift.
    const css = read("../views/list.css");
    expect(ruleBody(css, ".fm-list-row > .fm-cell")).toMatch(/padding:\s*0 8px/);
    expect(ruleBody(css, ".fm-th")).toMatch(/padding:\s*0 8px/);
    expect(ruleBody(css, ".fm-list-name")).toMatch(/padding:\s*0 8px/);
  });
});
