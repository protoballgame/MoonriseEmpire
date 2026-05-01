import { defineConfig } from "vitest/config";

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
