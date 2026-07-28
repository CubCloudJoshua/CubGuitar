import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { alphaTab } from "@coderline/alphatab-vite";

// Same-origin API in dev and preview; production serves both behind one host.
const proxy = { "/api": "http://127.0.0.1:8787" };

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
