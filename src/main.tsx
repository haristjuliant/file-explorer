import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

import App from "./App";
import { hydratePrefs } from "./store/persist";

// Before the first render, so the app never flashes the default view mode
// and then snaps to the saved one.
hydratePrefs();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  // StrictMode is kept on deliberately: it double-invokes effects, which is
  // exactly the pressure the refcounted watcher lifecycle needs to survive.
  <StrictMode>
    <App />
  </StrictMode>,
);

// The window starts hidden and appears only once there is something to show,
// so launching never flashes an empty white rectangle.
//
// A static import: WindowControls already pulls this module in, so deferring it
// here bought nothing and only split the chunk graph.
requestAnimationFrame(() => {
  try {
    void getCurrentWindow()
      .show()
      .catch(() => {});
  } catch {
    /* outside Tauri there is no window to show */
  }
});
