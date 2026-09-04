import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

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
requestAnimationFrame(() => {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().show())
    .catch(() => {
      /* outside Tauri there is no window to show */
    });
});
