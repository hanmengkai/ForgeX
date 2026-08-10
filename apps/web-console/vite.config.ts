import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
