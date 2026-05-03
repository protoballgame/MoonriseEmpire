import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** Production / GoDaddy entry must be `mrts.html` (not index). Dev-only `index.html` redirects here. */
export default defineConfig({
  base: "./",
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      input: resolve(__dirname, "mrts.html"),
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three/examples")) return "three-examples";
          if (id.includes("node_modules/three")) return "three";
          if (id.includes("node_modules")) return "vendor";
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    /** Allow other machines on the LAN to load dev assets (same origin as the page). */
    host: true
  },
  assetsInclude: ["**/*.glb", "**/*.gltf", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.webp"]
});
