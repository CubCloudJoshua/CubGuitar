import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { alphaTab } from "@coderline/alphatab-vite";

export default defineConfig({
  plugins: [react(), alphaTab()],
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
