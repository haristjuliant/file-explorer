import { useEffect, useRef } from "react";

import { basename } from "../lib/path";
import { orderRegistry } from "../order/registry";
import { findByPrefix } from "../order/selectionMath";
import { appState } from "../store/appStore";
import { matchBinding, type KeyDeps } from "./keymap";

/**
 * Is the event aimed at somewhere the user is typing?
 *
 * This is a TARGET test, not a store flag. A flag such as `renamingPath !== null`
 * desynchronizes the moment the input unmounts or blurs without a state update;
 * the DOM target never lies.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return target.closest("[data-keys-off]") !== null;
}

/** A single character the user meant to type, not a named key. */
function isPrintable(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key !== " ";
}

/**
 * Keys WebView2 would otherwise act on itself. Left unhandled, Ctrl+F opens
 * Chromium's find bar over our UI and F5 reloads the whole app.
 */
const BROWSER_KEYS = new Set(["f", "r", "p", "g", "j", "u", "s", "o", "+", "-", "0"]);

function shouldSuppressBrowserDefault(e: KeyboardEvent): boolean {
  if (e.key === "F5" || e.key === "F3" || e.key === "F7") return true;
  if ((e.ctrlKey || e.metaKey) && BROWSER_KEYS.has(e.key.toLowerCase())) return true;
  return false;
}

const TYPE_BUFFER_RESET_MS = 700;

/**
 * The one keyboard handler, mounted once by the app shell.
 *
 * It works across all three views without duplication because every binding is
 * written against the store and the `OrderSource` registry. A view contributes
 * at most three callbacks and inherits the rest.
 */
export function useGlobalKeyboard(deps: Partial<KeyDeps>): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const typeBuffer = useRef("");
  const typeStamp = useRef(0);

  useEffect(() => {
    function typeToSelect(char: string): void {
      const now = Date.now();
      const order = orderRegistry.get();
      if (order.paths.length === 0) return;

      const expired = now - typeStamp.current > TYPE_BUFFER_RESET_MS;
      const repeat = !expired && typeBuffer.current === char;

      typeBuffer.current = expired ? char : repeat ? char : typeBuffer.current + char;
      typeStamp.current = now;

      const s = appState();
      const names = order.paths.map((p) => basename(p));
      const cursorIndex = s.cursor === null ? -1 : (order.index.get(s.cursor) ?? -1);

      // Repeating one letter walks through that group; a growing buffer
      // restarts from the top so the match tracks what was typed.
      const from = repeat ? cursorIndex + 1 : 0;
      const hit = findByPrefix(names, typeBuffer.current, from);
      if (hit < 0) return;

      s.select(order.paths[hit]);
      queueMicrotask(() => orderRegistry.source()?.reveal(hit));
    }

    function handleQuickLook(e: KeyboardEvent): boolean {
      const s = appState();
      if (!s.quickLookOpen) return false;

      // While the overlay is open it owns every arrow key. Finder treats
      // left/right as previous/next inside Quick Look regardless of the layout
      // underneath, and in tree and column mode that is the only sane mapping.
      switch (e.key) {
        case "ArrowDown":
        case "ArrowRight":
          s.moveCursor(1, false);
          return true;
        case "ArrowUp":
        case "ArrowLeft":
          s.moveCursor(-1, false);
          return true;
        case "Home":
          s.moveCursor("home", false);
          return true;
        case "End":
          s.moveCursor("end", false);
          return true;
        case " ":
        case "Escape":
          s.closeQuickLook();
          return true;
        case "Enter":
          depsRef.current.openCursor?.();
          return true;
        default:
          return false;
      }
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.isComposing) return;
      if (isTextEntryTarget(e.target)) return;

      // Modal layers first, in precedence order.
      if (handleQuickLook(e)) {
        e.preventDefault();
        return;
      }

      const s = appState();
      if (s.contextMenu && e.key === "Escape") {
        s.closeContextMenu();
        e.preventDefault();
        return;
      }

      if (e.key === "Escape") {
        s.clearSelection();
        return;
      }

      const binding = matchBinding(e);
      if (binding) {
        e.preventDefault();
        binding.run(
          { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey },
          depsRef.current,
        );
        return;
      }

      if (isPrintable(e)) {
        e.preventDefault();
        typeToSelect(e.key);
        return;
      }

      if (shouldSuppressBrowserDefault(e)) e.preventDefault();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * Track window focus so selected rows can grey out when the app is not
 * frontmost. Finder's grey inactive selection is one of the strongest visual
 * cues that this is a Finder-like app, and it costs one boolean.
 */
export function useWindowFocusTracking(): void {
  useEffect(() => {
    const onFocus = () => appState().setWindowFocused(true);
    const onBlur = () => appState().setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    appState().setWindowFocused(document.hasFocus());
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}

/** Suppress the native context menu everywhere, so ours is the only one. */
export function useSuppressNativeContextMenu(): void {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (isTextEntryTarget(e.target)) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
}
