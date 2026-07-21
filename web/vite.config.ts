import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    // Required so Vite HMR works inside a Docker container on Windows/WSL.
    watch: { usePolling: true },
  },
});
