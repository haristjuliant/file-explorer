import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * @tanstack/react-virtual measures its scroll element. jsdom reports 0 for
 * every box, so without these stubs EVERY virtualized test renders zero rows --
 * a failure mode that looks like a component bug and costs an afternoon.
 */
const VIEWPORT_H = 600;
const VIEWPORT_W = 900;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testHeight ? Number(this.dataset.testHeight) : VIEWPORT_H;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => VIEWPORT_W,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => VIEWPORT_H,
  });

  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: VIEWPORT_W,
      bottom: VIEWPORT_H,
      width: VIEWPORT_W,
      height: VIEWPORT_H,
      toJSON: () => ({}),
    } as DOMRect;
  };

  /**
   * jsdom implements no scrolling at all. Column view auto-scrolls the strip to
   * the right as the chain grows, and the virtualizer scrolls rows into view;
   * without these the components throw rather than simply doing nothing.
   */
  if (!HTMLElement.prototype.scrollTo) {
    HTMLElement.prototype.scrollTo = () => {};
    HTMLElement.prototype.scrollBy = () => {};
    HTMLElement.prototype.scrollIntoView = () => {};
  }

  // jsdom has neither, and Quick Look's neighbour preload uses them.
  if (!("requestIdleCallback" in globalThis)) {
    (globalThis as unknown as Record<string, unknown>).requestIdleCallback = (
      cb: IdleRequestCallback,
    ) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 16 }), 0) as unknown as number;
    (globalThis as unknown as Record<string, unknown>).cancelIdleCallback = (id: number) =>
      clearTimeout(id);
  }

  /**
   * A ResizeObserver that actually reports a size.
   *
   * `@tanstack/react-virtual` learns its viewport height through this observer.
   * A stub whose callback never fires leaves the virtualizer believing the
   * viewport is zero pixels tall, so it renders no rows at all -- which looks
   * exactly like a broken component and is nothing of the kind.
   */
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(target: Element): void {
      const rect = target.getBoundingClientRect();
      this.callback(
        [
          {
            target,
            contentRect: rect,
            borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
            contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
            devicePixelContentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }

    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
