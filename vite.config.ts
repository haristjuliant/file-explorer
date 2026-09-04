/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],

  // Don't let Vite clear the screen over Rust compiler errors.
  clearScreen: false,

  server: {
    // Tauri expects a fixed port and must fail loudly if it is taken.
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },

  envPrefix: ["VITE_", "TAURI_ENV_"],

  build: {
    // WebView2 is Chromium, so we can target a modern baseline.
    target: "chrome120",
    // Vite 8 bundles with rolldown and minifies with oxc; naming "esbuild" here
    // would demand a package that is no longer part of the install.
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/order/**", "src/store/**"],
    },
  },
});
