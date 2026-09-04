import { screen, waitFor } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { expect } from "vitest";
import type { ReactNode } from "react";

import { QuickLook } from "../src/components/quicklook/QuickLook";
import { useGlobalKeyboard } from "../src/keys/useGlobalKeyboard";
import { useAppStore } from "../src/store/appStore";

/**
 * The shared Quick Look harness and contract.
 *
 * The whole promise of the `OrderSource` registry is that Quick Look behaves
 * identically over any view. That claim is only worth something if it is tested
 * as ONE routine run against each view, rather than three similar-looking tests
 * that could quietly drift apart -- so `assertQuickLookContract` lives here and
 * every view's test calls it verbatim.
 *
 * If a view leaks view-specific knowledge into Quick Look, this fails.
 */
export function Harness({ view }: { view: ReactNode }) {
  useGlobalKeyboard({ openCursor: () => {}, pageSize: () => 10 });
  return (
    <>
      {view}
      <QuickLook />
    </>
  );
}

export function dialogTitle(): string {
  return screen.getByRole("dialog").querySelector(".fm-ql-title")?.textContent ?? "";
}

const s = () => useAppStore.getState();

export interface QuickLookContract {
  user: UserEvent;
  /** Where to put the cursor before opening. */
  startPath: string;
  /**
   * File names in the order the view presents them, starting at `startPath`.
   * At least three, so stepping forwards and back is actually exercised.
   */
  expectedForward: string[];
}

/**
 * Open Quick Look on `startPath`, step forward through `expectedForward`, step
 * back, and close -- asserting throughout that the view's cursor tracks the
 * overlay.
 */
export async function assertQuickLookContract({
  user,
  startPath,
  expectedForward,
}: QuickLookContract): Promise<void> {
  expect(
    expectedForward.length,
    "the contract needs at least three items to exercise stepping",
  ).toBeGreaterThanOrEqual(3);

  s().select(startPath);

  // Space opens on the cursor.
  await user.keyboard(" ");
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  expect(dialogTitle()).toBe(expectedForward[0]);

  // Down steps forward, and the view's cursor follows so that closing leaves
  // the user where they expect.
  for (let i = 1; i < expectedForward.length; i++) {
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(dialogTitle()).toBe(expectedForward[i]));
    expect(s().cursor?.endsWith(expectedForward[i])).toBe(true);
  }

  // Up walks back.
  for (let i = expectedForward.length - 2; i >= 0; i--) {
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(dialogTitle()).toBe(expectedForward[i]));
  }

  // Right and Left are previous/next inside the overlay regardless of what the
  // underlying view does with them.
  await user.keyboard("{ArrowRight}");
  await waitFor(() => expect(dialogTitle()).toBe(expectedForward[1]));
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => expect(dialogTitle()).toBe(expectedForward[0]));

  // The counter reflects the view's own order.
  expect(screen.getByText(new RegExp(`^1 of `))).toBeInTheDocument();

  // Escape closes and leaves the selection alone.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(s().quickLookOpen).toBe(false));
  expect(s().cursor?.endsWith(expectedForward[0])).toBe(true);
}
