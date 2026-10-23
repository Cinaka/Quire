import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { replacement } from './tests/export-browser/isolation.mjs'
const root = fileURLToPath(new URL('.', import.meta.url))
export default defineConfig({
  root: resolve(root, 'tests/export-browser'), publicDir: false,
  plugins: [{ name: 'p6-isolated-snapshot-io', enforce: 'pre',
    resolveId(source, importer) { return replacement(source, importer, root) },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (req.headers.host !== '127.0.0.1:5185' || /^\/(?:api|media|uploads)(?:\/|$)/.test(path)) {
          res.statusCode = 403; res.end('isolated fixture server only'); return
        }
        next()
      })
    },
  }],
  resolve: { alias: { '@': resolve(root, 'src') } },
  server: { host: '127.0.0.1', port: 5185, strictPort: true, fs: { allow: [root] } },
  // No API proxy, auto-open, service worker, production build or output directory.
})
