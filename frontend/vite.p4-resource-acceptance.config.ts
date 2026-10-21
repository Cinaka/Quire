import { fileURLToPath, URL } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import vue from "@vitejs/plugin-vue"
import { defineConfig, type Plugin } from "vite"

export default defineConfig(() => {
  const dailyValue = process.env.P4_RESOURCE_DAILY_ORIGIN
  if (!dailyValue) throw new Error("必须明确设置P4_RESOURCE_DAILY_ORIGIN，禁止猜测日常地址")
  const daily = new URL(dailyValue)
  const isolated = "http://127.0.0.1:5181"
  if (!["http:", "https:"].includes(daily.protocol) || daily.username || daily.password || daily.pathname !== "/" || daily.search || daily.hash || daily.origin === isolated) throw new Error("日常origin配置无效或与隔离origin相同")
  return {
    plugins: [vue(), tailwindcss(), {
      enforce: "pre",
      name: "quire-p4-resource-isolated-storage",
      transform(source, id) {
        const filename = (id.split("?")[0] ?? id).replaceAll("\\", "/")
        if (filename.endsWith("/src/api/tokenStore.ts")) return 'export { resourceAccessTokenSubject as accessTokenSubject, resourceTokenGeneration as tokenGeneration, resourceGetAccessToken as getAccessToken } from "/src/resource-acceptance/identity.ts"'
        if (!(id.split("?")[0] ?? id).replaceAll("\\", "/").endsWith("/src/db/schema.ts")) return
        const original = "export const db = new QuireDb()"
        if (source.split(original).length !== 2) throw new Error("验收数据库注入点已变化，拒绝使用默认quire库")
        const wait = "return Dexie.waitFor(promise, 10000)"
        if (source.split(wait).length !== 2) throw new Error("资源事务等待注入点已变化，拒绝启动")
        return 'import { waitForResourceAcceptanceTransaction } from "/src/resource-acceptance/barrier.ts"\n' + source
          .replace(original, 'export const db = new QuireDb("quire-p4-resource-acceptance")')
          .replace(wait, "return Dexie.waitFor(waitForResourceAcceptanceTransaction(promise), 10000)")
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = new URL(request.url ?? "/", isolated).pathname
          if (request.headers.host !== "127.0.0.1:5181" || path === "/src/main.ts" || path === "/src/api/request.ts" || path.startsWith("/src/router/") || /^\/(api|media)(\/|$)/.test(path) ||
            ((request.headers.accept?.includes("text/html") || path.endsWith(".html")) && !["/", "/p4-resource-acceptance.html"].includes(path))) {
            response.statusCode = 403; response.end("仅允许专用P4页面，无后台API/媒体代理"); return
          }
          if (path === "/") { response.statusCode = 302; response.setHeader("Location", "/p4-resource-acceptance.html"); response.end(); return }
          next()
        })
      },
    } satisfies Plugin],
    define: { __QUIRE_P4_RESOURCE_ACCEPTANCE__: "true", __QUIRE_P4_RESOURCE_DAILY_ORIGIN__: JSON.stringify(daily.origin), __QUIRE_P4_RESOURCE_TEST_ORIGIN__: JSON.stringify(isolated) },
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    // No proxy or remote connections: the cloud proof is a labelled in-process fixture.
    server: { headers: { "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws://127.0.0.1:5181; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'" }, host: "127.0.0.1", port: 5181, strictPort: true, open: false },
    build: { outDir: "dist-p4-resource-acceptance", rollupOptions: { input: fileURLToPath(new URL("./p4-resource-acceptance.html", import.meta.url)) } },
  }
})
