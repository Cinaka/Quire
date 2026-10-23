import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {defineConfig} from 'vite'
const root=fileURLToPath(new URL('.',import.meta.url))
export default defineConfig({root:resolve(root,'tests/export-layout-browser'),publicDir:false,
 plugins:[{name:'p6-layout-loopback-only',configureServer(server){server.middlewares.use((req,res,next)=>{if(req.headers.host!=='127.0.0.1:5186'||/^\/(?:api|media|uploads)(?:\/|$)/.test(req.url??'')){res.statusCode=403;res.end('isolated public layout fixtures only');return}next()})}}],
 server:{host:'127.0.0.1',port:5186,strictPort:true,fs:{allow:[root]}}})
