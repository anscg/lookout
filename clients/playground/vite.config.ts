import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The SDK is a workspace package resolved to its built dist, which Vite
  // would otherwise pre-bundle and cache — the reason SDK edits kept not
  // showing up during this feature's development. Excluding it means a
  // rebuild of @lookout/react is picked up on reload, no server restart.
  optimizeDeps: { exclude: ["@lookout/react", "@lookout/shared"] },
  server: { port: 5199 },
});
