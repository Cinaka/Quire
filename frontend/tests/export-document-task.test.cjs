// Actual core/preflight/document/font gate; injected storage, identity and font host.
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createExportSnapshotCore}=require('../src/db/exportSnapshotCore.ts'),{createExportPreflightTask}=require('../src/shared/exportPreflightTask.ts'),{createExportDocumentTask}=require('../src/shared/exportDocumentTask.ts'),{prepareExportFonts}=require('../src/shared/exportFontReadiness.ts')
const all={scope:{kind:'all'}},code=c=>e=>e.code===c,immediate=()=>new Promise(setImmediate)
function fixture(bad=false){
 let identity,changed,watchers=0,valid=true,load=async()=>{};const added=new Set(),made=[],hooks={}
 const row={id:'e',entryDate:'2026-10-21',sortOrder:1,title:'旧标题',contentText:'青简',mood:null,weather:null,tagIds:[],updatedAt:'2026-10-21',isDeleted:0,deletedAt:null,content:{schemaVersion:bad?999:1,doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'旧正文🌿'}]}]}}}
 const io={read:async work=>work(),owner:async()=>({ownerUserId:'A',generation:'epoch'}),auth:()=>({subject:'A',generation:1,valid}),scan:async(_,visit)=>visit(row),tag:async()=>undefined,media:async()=>undefined,observeIdentity:fn=>{identity=fn;return()=>{}},observeContent:fn=>{watchers++;changed=fn;return()=>watchers--},now:()=>1,monotonic:()=>0}
 const port=createExportSnapshotCore(io,{ownerUserId:'A',generation:'epoch',authGeneration:1}),pre=createExportPreflightTask(port)
 const host={create(family,file){const f={family,file,load:async()=>load(f)};made.push(f);return f},add(f){added.add(f)},remove(f){added.delete(f)}}
 const prepare=async(text,mode,options)=>{await hooks.before?.();const lease=await prepareExportFonts(text,mode,{...options,host});await hooks.after?.();return lease}
 const doc=createExportDocumentTask(pre,prepare)
 return {port,pre,doc,row,hooks,added,made,set load(v){load=v},changed:()=>changed(),expire:()=>{valid=false;identity()},get watchers(){return watchers},close(){doc.close();pre.close();port.close()}}
}
async function start(f,mode='full'){await f.pre.run(all);const r=(await f.pre.read()).review;if(mode==='degraded')await f.pre.confirmDegraded(r);return r}
test('controlled document is font-frozen but never print ready; read checks current policy',async()=>{
 const f=fixture(),r=await start(f);await f.doc.prepare('full',r,'wenkai');const d=await f.doc.read();assert.equal(d.completeOutputReady,false);assert.equal(d.document.completeOutputReady,false);assert(d.font.family.includes('Quire Print Session'));assert(d.font.uncoveredScalars>0);assert(f.added.size>0);f.close();assert.equal(f.added.size,0);assert.equal(f.watchers,0)
})
test('ordinary change retains frozen document and fonts with sticky changed flag; rerun cancels it',async()=>{
 const f=fixture(),r=await start(f);await f.doc.prepare('full',r,'wenkai');const old=await f.doc.read();f.row.title='新标题';f.changed();const current=await f.doc.read();assert.equal(current.document,old.document);assert.equal(current.document.entries[0].title,'旧标题');assert(current.changed);assert.equal(current.font.family,old.font.family)
 await f.pre.run(all);assert.equal(f.added.size,0);await assert.rejects(f.doc.read(),code('EXPORT_DOCUMENT_NOT_PREPARED'));f.close()
})
test('full blocked before font request; program confirmed degraded includes diagnostic text',async()=>{
 const f=fixture(true);await f.pre.run(all);const r=(await f.pre.read()).review;await assert.rejects(f.doc.prepare('full',r,'wenkai'),code('EXPORT_FULL_CONTENT_BLOCKED'));assert.equal(f.made.length,0)
 await assert.rejects(f.doc.prepare('degraded',r,'wenkai'),code('EXPORT_DEGRADED_CONFIRMATION_REQUIRED'));await f.pre.confirmDegraded(r);await f.doc.prepare('degraded',r,'system');const d=await f.doc.read();assert.equal(d.document.entries[0].issues[0].code,'CONTENT_UNSUPPORTED');assert.equal(d.font.family,'serif');f.close()
})
test('revocation disposes prepared fonts immediately and cannot revive by reconfirming same review',async()=>{
 const f=fixture(true),r=await start(f,'degraded');await f.doc.prepare('degraded',r,'wenkai');f.pre.revokeDegraded();assert.equal(f.added.size,0);await f.pre.confirmDegraded(r);await assert.rejects(f.doc.read(),code('EXPORT_DOCUMENT_NOT_PREPARED'));f.close()
})
test('cancel during load releases task now; late font never registers',async()=>{
 const f=fixture(),r=await start(f);let resume;f.load=()=>new Promise(resolve=>resume=resolve);const work=f.doc.prepare('full',r,'wenkai');await immediate();f.doc.cancel();await assert.rejects(work,code('CANCELLED'));resume();await immediate();assert.equal(f.added.size,0);f.close()
})
test('identity loss during load closes preflight, prevents late model, clears watchers',async()=>{
 const f=fixture(),r=await start(f);let resume;f.load=()=>new Promise(resolve=>resume=resolve);const work=f.doc.prepare('full',r,'wenkai');await immediate();f.expire();await assert.rejects(work);resume();await immediate();assert.equal(f.added.size,0);assert.equal(f.watchers,0);await assert.rejects(f.doc.read());f.close()
})
test('preflight cancellation while model prepared removes its font family',async()=>{
 const f=fixture(),r=await start(f);await f.doc.prepare('full',r,'wenkai');f.pre.cancel();assert.equal(f.added.size,0);await assert.rejects(f.doc.read());f.close()
})
test('failed font never auto switches family; explicit system retry builds new model',async()=>{
 const f=fixture(),r=await start(f);f.load=async()=>{throw Error('font')};await assert.rejects(f.doc.prepare('full',r,'wenkai'),code('EXPORT_FONT_LOAD_FAILED'));await assert.rejects(f.doc.read());await f.doc.prepare('full',r,'system');const d=await f.doc.read();assert.equal(d.font.family,'serif');assert.equal(f.added.size,0);f.close()
})
test('late returned lease from replaced task disposed, cannot clear new system document',async()=>{
 const f=fixture(),r=await start(f);let resume,entered=false;f.hooks.after=()=>{if(entered)return;entered=true;return new Promise(resolve=>resume=resolve)}
 const old=f.doc.prepare('full',r,'wenkai');await immediate();assert(entered);await f.doc.prepare('full',r,'system');resume();await assert.rejects(old,code('CANCELLED'));assert.equal((await f.doc.read()).font.family,'serif');assert.equal(f.added.size,0);f.close()
})
test('external already-aborted and later abort both stop publication and remove fonts',async()=>{
 for(const aborted of [true,false]){const f=fixture(),r=await start(f),c=new AbortController();if(aborted)c.abort();if(aborted)await assert.rejects(f.doc.prepare('full',r,'wenkai',c.signal),code('CANCELLED'));else{await f.doc.prepare('full',r,'wenkai',c.signal);c.abort();await assert.rejects(f.doc.read());}assert.equal(f.added.size,0);f.close()}
})
test('close idempotent and owns font lease but not caller preflight port',async()=>{
 const f=fixture(),r=await start(f);await f.doc.prepare('full',r,'wenkai');f.doc.close();f.doc.close();assert.equal(f.added.size,0);assert.equal(f.pre.status().state,'checked');await f.pre.read();await assert.rejects(f.doc.prepare('full',r,'system'),code('EXPORT_DOCUMENT_CLOSED'));f.close()
})
test('clone/old review denied before font requests',async()=>{
 const f=fixture(),r=await start(f);await assert.rejects(f.doc.prepare('full',{...r},'wenkai'),code('EXPORT_STALE_REVIEW'));assert.equal(f.made.length,0);await f.pre.run(all);await assert.rejects(f.doc.prepare('full',r,'system'),code('EXPORT_STALE_REVIEW'));f.close()
})
test('revocation in final handoff/outer publication gap cannot publish or leak fonts',async()=>{
 const f=fixture(true),r=await start(f,'degraded'),original=f.pre.readForLayout;let armed=false
 f.pre.readForLayout=async(...args)=>{const value=await original(...args);if(armed)queueMicrotask(()=>f.pre.revokeDegraded());return value}
 f.hooks.after=()=>{armed=true};await assert.rejects(f.doc.prepare('degraded',r,'wenkai'));assert.equal(f.added.size,0);await assert.rejects(f.doc.read());f.close()
})
test('cancel in read final await gap denies stale document copy',async()=>{
 const f=fixture(),r=await start(f);await f.doc.prepare('full',r,'wenkai');const original=f.pre.readForLayout
 f.pre.readForLayout=async(...args)=>{const value=await original(...args);queueMicrotask(()=>f.doc.cancel());return value}
 await assert.rejects(f.doc.read(),code('EXPORT_DOCUMENT_RELEASED'));assert.equal(f.added.size,0);f.close()
})
