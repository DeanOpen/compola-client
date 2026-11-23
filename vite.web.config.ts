import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import { writeFileSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import { fileURLToPath } from "node:url";

// The web client of Compola Server (docs/compola-server.md, "Web client"): the same app as the desktop UI, served by
// the host at /web/ and talking to it over /ws, /media/load and /upload with the console's cookie session.
// `npm run build:web` → src-tauri/web-dist. `npm run dev:web` serves it at http://localhost:1440/web/ with the server's
// routes proxied to a host on this machine (sign in first at http://localhost:1440/admin/ through the same proxy).

const outDir = fileURLToPath(new URL("./src-tauri/web-dist", import.meta.url));

// emptyOutDir wipes the folder, including the .gitkeep that keeps it in git (the Rust side embeds it).
function keepGitkeep(): Plugin {
  return {
    name: "compola-web-gitkeep",
    apply: "build",
    closeBundle() {
      writeFileSync(`${outDir}/.gitkeep`, "");
    },
  };
}

const target = "http://127.0.0.1:39218";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/web/",
  plugins: [react(), keepGitkeep()],
  clearScreen: false,
  build: {
    outDir,
    emptyOutDir: true,
  },
  server: {
    port: 1440,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "/ws": { target, ws: true, changeOrigin: false },
      "/api": { target, changeOrigin: false },
      "/media": { target, changeOrigin: false },
      "/upload": { target, changeOrigin: false },
      "/admin": { target, changeOrigin: false },
    },
  },
});
