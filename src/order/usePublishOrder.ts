import { useEffect, useRef } from "react";

import { orderRegistry, type OrderSource, type ViewMode, type VisibleOrder } from "./registry";

type OrderApi = Omit<OrderSource, "view" | "getOrder">;

/**
 * Register the calling view as the active `OrderSource`.
 *
 * `build` must be memoized by the caller: its identity IS the identity of the
 * order, and a change to it republishes. Both `build` and `api` are held in refs
 * so the registration effect runs once per view mount -- per-render churn, and
 * the re-subscription storm it would cause, is structurally impossible.
 */
export function usePublishOrder(view: ViewMode, build: () => VisibleOrder, api: OrderApi): void {
  usePublishOrderIf(true, view, build, api);
}

/**
 * Conditional variant, for column mode: only the column that currently holds
 * the cursor registers, so exactly one source is ever active.
 */
export function usePublishOrderIf(
  active: boolean,
  view: ViewMode,
  build: () => VisibleOrder,
  api: OrderApi,
): void {
  const buildRef = useRef(build);
  buildRef.current = build;

  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    if (!active) return;
    return orderRegistry.register({
      view,
      getOrder: () => buildRef.current(),
      reveal: (i) => apiRef.current.reveal(i),
      onArrowLeft: (ctx) => apiRef.current.onArrowLeft?.(ctx) ?? false,
      onArrowRight: (ctx) => apiRef.current.onArrowRight?.(ctx) ?? false,
      activateDir: (p) => apiRef.current.activateDir?.(p) ?? false,
    });
  }, [active, view]);

  // Republish when the order's content changes. `build` identity is the signal.
  useEffect(() => {
    if (active) orderRegistry.publish();
  }, [active, build]);
}
