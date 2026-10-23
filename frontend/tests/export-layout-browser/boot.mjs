const start=document.querySelector('#start'),system=document.querySelector('#system'),cancel=document.querySelector('#cancel'),status=document.querySelector('#status'),output=document.querySelector('#output'),report=document.querySelector('#report'),modes=[...document.querySelectorAll('[data-mode]')],sample=document.querySelector('#sample'),title=document.querySelector('#book-title')
const exact=location.protocol==='http:'&&location.hostname==='127.0.0.1'&&location.port==='5186'
let controller,source,layout,version=0,restores=[],created=0,revoked=0,busy=false
function scale(){if(busy)return;const width=layout?.mapping.mode==='a5'||!layout?148:297;output.style.width=width+'mm';output.style.zoom=String(Math.min(1,(document.documentElement.clientWidth-32)/(width*96/25.4)))}
scale();addEventListener('resize',scale)
function clear(){version++;controller?.abort();controller=undefined;layout?.release();layout=undefined;source?.release();source=undefined;document.body.dataset.ready='false';for(const fn of restores.splice(0))fn();busy=false;cancel.disabled=true;start.disabled=system.disabled=!exact;sample.disabled=title.disabled=false;for(const b of modes){b.disabled=true;b.setAttribute('aria-pressed','false')}}
cancel.addEventListener('click',()=>{clear();status.textContent='已停止并清空，不计通过。';report.textContent=JSON.stringify({complete:false,code:'CANCELLED',urlsCreated:created,urlsRevoked:revoked});scale()})
function show(){
 const map=layout.mapping
 for(const button of modes){button.disabled=false;button.setAttribute('aria-pressed',String(button.dataset.mode===map.mode))}
 const data={complete:true,scope:source.scope,browser:navigator.userAgent,font:{mode:source.font.mode,shards:source.font.shardCount,uncoveredScalars:source.font.uncoveredScalars},logicalPages:layout.logicalPages,tocPages:layout.tocPages,titlePages:layout.titlePages,trace:layout.trace,sourceTextCoverage:layout.sourceCoverageChecked,mapping:map,urlsCreated:created,urlsRevoked:revoked,completeOutputReady:false,limitations:['固定材料，非真实身份/正式快照入口','仅PDF与屏幕可核验；实物折叠/手机内存未验','系统回退必须明确选择并重新编排']}
 report.textContent=JSON.stringify(data,null,2);status.textContent=`书页就绪：${layout.logicalPages}逻辑页，${layout.tocPages}页目录；${map.paperFaces}纸面、${map.blankPanels}补白面板；单面${map.singleSidedSheets}张／双面${map.duplexSheets}张。${map.mode==='booklet'?'左侧装订；须实物核对翻转方向。':''}不是完整P6验收。`;document.body.dataset.ready='true';busy=false;scale()
}
async function run(mode){
 clear();if(!exact)return
 const token=version,ac=new AbortController();controller=ac;busy=true;start.disabled=system.disabled=sample.disabled=title.disabled=true;cancel.disabled=false;status.textContent='准备固定材料、最终字体与完整逻辑页…';report.textContent='运行中'
 const open=indexedDB.open,del=indexedDB.deleteDatabase,create=URL.createObjectURL,revoke=URL.revokeObjectURL
 try{
  indexedDB.open=()=>{throw Error('隔离排版禁止打开数据库')};indexedDB.deleteDatabase=()=>{throw Error('隔离排版禁止删除数据库')}
  URL.createObjectURL=function(blob){created++;return create.call(this,blob)};URL.revokeObjectURL=function(url){revoked++;return revoke.call(this,url)}
  if(indexedDB.open===open||indexedDB.deleteDatabase===del)throw Error('无法安装隔离库守卫')
  restores.push(()=>{indexedDB.open=open;indexedDB.deleteDatabase=del;URL.createObjectURL=create;URL.revokeObjectURL=revoke})
 }catch(error){try{indexedDB.open=open;indexedDB.deleteDatabase=del;URL.createObjectURL=create;URL.revokeObjectURL=revoke}catch{};clear();status.textContent=`停止：${error.message}；未导入数据模块。`;return}
 created=revoked=0
 try{
  const [{fixedSource},{prepareExportBook}]=await Promise.all([import('./fixtures.mjs'),import('../../src/print/exportBook.ts')])
  const prepared=await fixedSource(mode,ac.signal,sample.value,title.value);if(token!==version){prepared.release();return}source=prepared
  output.style.zoom='1';output.style.width='148mm';const result=await prepareExportBook(prepared,output,{signal:ac.signal});if(token!==version){result.release();return}layout=result
  await result.assertCurrent();if(token!==version)return
  show()
 }catch(error){if(token!==version)return;clear();status.textContent=`停止：${error.code??error.message}；输出已清空。`;report.textContent=JSON.stringify({complete:false,code:error.code??error.message,urlsCreated:created,urlsRevoked:revoked});scale()}
}
for(const button of modes)button.addEventListener('click',async()=>{
 if(!layout||busy)return;const token=version;busy=true;document.body.dataset.ready='false';for(const b of modes)b.disabled=true;status.textContent='核对同一份逻辑页映射…';output.style.zoom='1'
 try{await layout.setMode(button.dataset.mode);if(token!==version)return;show()}catch(error){if(token!==version)return;clear();status.textContent=`停止：${error.code??error.message}；输出已清空。`;scale()}
})
if(!exact){start.disabled=system.disabled=true;status.textContent='仅允许 http://127.0.0.1:5186/；未启动。'}
start.addEventListener('click',()=>run('wenkai'));system.addEventListener('click',()=>run('system'));addEventListener('pagehide',clear)
