const start=document.querySelector('#start'),system=document.querySelector('#system'),cancel=document.querySelector('#cancel'),status=document.querySelector('#status'),output=document.querySelector('#output'),report=document.querySelector('#report')
const exact=location.protocol==='http:'&&location.hostname==='127.0.0.1'&&location.port==='5186'
let controller,source,layout,version=0,restores=[],created=0,revoked=0
function scale(){if(controller&&!layout)return;output.style.zoom=String(Math.min(1,(document.documentElement.clientWidth-32)/(148*96/25.4)))}
scale();addEventListener('resize',scale)
function clear(){version++;controller?.abort();controller=undefined;layout?.release();layout=undefined;source?.release();source=undefined;document.body.dataset.ready='false';for(const fn of restores.splice(0))fn();cancel.disabled=true;start.disabled=system.disabled=!exact}
cancel.addEventListener('click',()=>{clear();status.textContent='已停止并清空，不计通过。';report.textContent=JSON.stringify({complete:false,code:'CANCELLED',urlsCreated:created,urlsRevoked:revoked})})
async function run(mode){
 clear();if(!exact)return
 const token=version,ac=new AbortController();controller=ac;start.disabled=system.disabled=true;cancel.disabled=false;status.textContent='准备固定材料与最终字体…';report.textContent='运行中';created=revoked=0
 const open=indexedDB.open,del=indexedDB.deleteDatabase,create=URL.createObjectURL,revoke=URL.revokeObjectURL
 try {
 indexedDB.open=()=>{throw Error('隔离排版禁止打开数据库')};indexedDB.deleteDatabase=()=>{throw Error('隔离排版禁止删除数据库')}
 URL.createObjectURL=function(blob){created++;return create.call(this,blob)};URL.revokeObjectURL=function(url){revoked++;return revoke.call(this,url)}
 if(indexedDB.open===open||indexedDB.deleteDatabase===del)throw Error('无法安装隔离库守卫')
 restores.push(()=>{indexedDB.open=open;indexedDB.deleteDatabase=del;URL.createObjectURL=create;URL.revokeObjectURL=revoke})
 }catch(error){try{indexedDB.open=open;indexedDB.deleteDatabase=del;URL.createObjectURL=create;URL.revokeObjectURL=revoke}catch{};clear();status.textContent=`停止：${error.message}；未导入数据模块。`;return}
 try{
  const [{fixedSource},{paginateExportA5}]=await Promise.all([import('./fixtures.mjs'),import('../../src/print/exportA5.ts')])
  const prepared=await fixedSource(mode,ac.signal);if(token!==version){prepared.release();return}source=prepared
  status.textContent='按最终字体实测，生成 A5 正文续页…'
  // Do not let preview zoom alter physical measurement. Scale only after checks.
  output.style.zoom='1';const result=await paginateExportA5(prepared,output,{signal:ac.signal});if(token!==version){result.release();return}layout=result
  await result.assertCurrent();if(token!==version)return
  const pages=result.pages.length,bodyStarts=result.bodyStarts
  const bounds=[...result.root.querySelectorAll('.p6-body')].map(body=>{const r=body.getBoundingClientRect();return [...body.querySelectorAll('[data-flow-id]')].every(e=>{const b=e.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1&&b.bottom<=r.bottom+1})})
  const text=result.root.textContent;for(const marker of ['BODY_END_01','CODE_END_02','WORD_END_02','BODY_END_03'])if(!text.includes(marker))throw Error(`缺少终点${marker}`)
  if(bounds.some(v=>!v))throw Error('最终DOM越出安全区')
  const images=[...result.root.querySelectorAll('img')];if(!images.length||images.some(i=>!i.complete||!i.naturalWidth))throw Error('固定图片未就绪')
  const values=[...result.root.querySelectorAll('li[value]')].map(e=>Number(e.getAttribute('value')));if(!values.includes(3)||!values.includes(4))throw Error('列表序号未保留')
  const data={complete:true,scope:prepared.scope,browser:navigator.userAgent,font:{mode:prepared.font.mode,shards:prepared.font.shardCount,uncoveredScalars:prepared.font.uncoveredScalars},bodyPages:pages,bodyStarts,sourceTextCoverage:result.sourceCoverageChecked,coverage:'生产片段连续覆盖及实际DOM文字UTF-16区间核对通过；另核对末端标记/列表序号/几何',bounds,images:images.length,relaxedWidows:result.relaxedWidows,urlsCreated:created,urlsRevoked:revoked,completeOutputReady:false,limitations:['仅正文A5；无封面目录/A4拼版或正式身份','固定材料程序确认降级；不代表真实用户确认','浏览器内存峰值、手机打印与实物未验；无自动打印']}
  report.textContent=JSON.stringify(data,null,2);status.textContent=`A5正文就绪：${pages}页，${bodyStarts.length}篇；范围/几何检查通过。不是完整P6验收。`;document.body.dataset.ready='true';scale()
 }catch(error){if(token!==version)return;clear();status.textContent=`停止：${error.code??error.message}；输出已清空。`;report.textContent=JSON.stringify({complete:false,code:error.code??error.message,urlsCreated:created,urlsRevoked:revoked});scale()}
}
if(!exact){start.disabled=system.disabled=true;status.textContent='仅允许 http://127.0.0.1:5186/；未启动。'}
start.addEventListener('click',()=>run('wenkai'));system.addEventListener('click',()=>run('system'));addEventListener('pagehide',clear)
