import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev` proxies the API to a local server (override with NEEDLEDB_URL).
const api = process.env.NEEDLEDB_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  build: { outDir: "../needledb/server/static", emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(["/indexes", "/stats", "/health", "/metrics"].map((p) => [p, api])),
  },
});
