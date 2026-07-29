import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { alphaTab } from "@coderline/alphatab-vite";

// Same-origin API in dev and preview; production serves both behind one host.
// Ports are overridable so the e2e harness can run against isolated services
// without colliding with a developer's running stack.
const apiPort = process.env.CUBSCORE_API_PORT ?? "8787";
const syncPort = process.env.CUBSCORE_SYNC_PORT ?? "8788";
const proxy = {
  "/api": `http://127.0.0.1:${apiPort}`,
  "/ws": { target: `ws://127.0.0.1:${syncPort}`, ws: true },
};

export default defineConfig({
  plugins: [react(), alphaTab()],
  server: { proxy },
  preview: { proxy },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        // Headless harness driven by tools/corpus-check.mjs.
        corpus: resolve(__dirname, "corpus.html"),
      },
    },
  },
});
