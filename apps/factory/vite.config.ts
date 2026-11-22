import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The core this dev server talks to. The built factory is served by the core itself, at /factory. */
const core = `127.0.0.1:${process.env.FOUNDRY_PORT || 7717}`;

export default defineConfig({
  base: "/factory/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/state": `http://${core}`,
      "/intents": `http://${core}`,
      "/health": `http://${core}`,
      "/ws": { target: `ws://${core}`, ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
