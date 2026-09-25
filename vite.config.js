import { defineConfig } from "vite";
export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 4173,
    allowedHosts: ["terminal.local"],
    headers: { "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" },
    proxy: {
      "/api": { target: "http://127.0.0.1:4318", ws: true, changeOrigin: true },
    },
  },
  build: {
    emptyOutDir: false,
    chunkSizeWarningLimit: 850,
    rollupOptions: {
      input: {desktop:'index.html', mobile:'mobile.html'},
      output: {
        manualChunks: {
          three: ["three"],
          terminal: ["@xterm/xterm", "@xterm/addon-fit"],
        },
      },
    },
  },
});
