const path=require('node:path'),{pathToFileURL}=require('node:url')
const root=path.resolve(__dirname,'..')
async function main(){let entry;try{entry=require.resolve('vite',{paths:[root]})}catch{throw Error('未找到既有Vite；未安装/升级依赖')}
 const {createServer}=await import(pathToFileURL(entry).href),server=await createServer({configFile:path.join(root,'vite.export-layout.config.mjs')});await server.listen();console.log('P6-2 固定A5正文样张：http://127.0.0.1:5186/；点击才运行，Ctrl+C停止。')
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void server.close().then(()=>process.exit(0))})}
main().catch(e=>{console.error(`未启动（不换端口、不安装）：${e.message}`);process.exitCode=1})
