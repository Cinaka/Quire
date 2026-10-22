import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { replacement } from "./tests/notebook-browser/isolation"
const root = fileURLToPath(new URL(".", import.meta.url))
export default defineConfig({
  root: resolve(root, "tests/notebook-browser"),
  plugins: [
    { name: "p5-test-only-io", enforce: "pre", resolveId(source, importer) { return replacement(source, importer, root) } },
    vue(),
  ],
  resolve: { alias: { "@": resolve(root, "src") } },
  server: { host: "127.0.0.1", port: 5183, strictPort: true, fs: { allow: [root] } },
  // No API/media proxy, production route, build output or public production assets.
  publicDir: false,
})
