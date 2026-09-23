import { fileURLToPath, URL } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
      // 后端下发的图片地址是同源相对路径 /media/...。
      // 开发环境也必须转发，否则 Vite 会返回 SPA HTML，随后被误存成图片 Blob。
      "/media": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
})
