import { fileURLToPath, URL } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import vue from "@vitejs/plugin-vue"
import { defineConfig, type Plugin } from "vite"

export default defineConfig(() => {
  const dailyValue = process.env.P4_DAILY_ORIGIN
  if (!dailyValue) throw new Error("必须明确设置P4_DAILY_ORIGIN，禁止猜测日常地址")
  const daily = new URL(dailyValue)
  const isolated = "http://127.0.0.1:5179"
  if (!["http:", "https:"].includes(daily.protocol) || daily.username || daily.password || daily.pathname !== "/" || daily.search || daily.hash || daily.origin === isolated) throw new Error("日常origin配置无效或与隔离origin相同")
  return {
    plugins: [vue(), tailwindcss(), {
      enforce: "pre",
      name: "quire-p4-isolated-storage",
      transform(source, id) {
        if (!(id.split("?")[0] ?? id).replaceAll("\\", "/").endsWith("/src/db/schema.ts")) return
        const original = "export const db = new QuireDb()"
        if (source.split(original).length !== 2) throw new Error("验收数据库注入点已变化，拒绝使用默认quire库")
        return source.replace(original, 'export const db = new QuireDb("quire-p4-acceptance")')
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = new URL(request.url ?? "/", isolated).pathname
          if (request.headers.host !== "127.0.0.1:5179" || path === "/src/main.ts" || /^\/(api|media)(\/|$)/.test(path) ||
            ((request.headers.accept?.includes("text/html") || path.endsWith(".html")) && !["/", "/p4-acceptance.html"].includes(path))) {
            response.statusCode = 403; response.end("仅允许专用P4页面，无后台API/媒体代理"); return
          }
          if (path === "/") { response.statusCode = 302; response.setHeader("Location", "/p4-acceptance.html"); response.end(); return }
          next()
        })
      },
    } satisfies Plugin],
    define: { __QUIRE_P4_ACCEPTANCE__: "true", __QUIRE_P4_DAILY_ORIGIN__: JSON.stringify(daily.origin), __QUIRE_P4_TEST_ORIGIN__: JSON.stringify(isolated) },
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: { host: "127.0.0.1", port: 5179, strictPort: true, open: false },
    build: { outDir: "dist-p4-acceptance", rollupOptions: { input: fileURLToPath(new URL("./p4-acceptance.html", import.meta.url)) } },
  }
})
