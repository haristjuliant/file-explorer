/**
 * Which child was last selected in each directory, for column view.
 *
 * Finder remembers this: walk back to the left and forward again, and you land
 * on the same item rather than at the top of the list.
 *
 * Module state rather than store state, because it is a memory aid that no
 * component should re-render for. It lives outside `ColumnView` so that file
 * exports components only -- a non-component export there disables React Fast
 * Refresh for the whole module.
 */

const lastChildOf = new Map<string, string>();

export function rememberChild(dir: string, child: string): void {
  lastChildOf.set(dir, child);
}

export function recallChild(dir: string): string | undefined {
  return lastChildOf.get(dir);
}

/**
 * Test hook. Module state survives between cases in a file, so one case's
 * remembered child would silently change what a later case sees.
 */
export function resetColumnMemory(): void {
  lastChildOf.clear();
}
