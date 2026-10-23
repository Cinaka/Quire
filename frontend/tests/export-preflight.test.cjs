// Actual snapshot core + actual resource pipeline; injected storage/identity/native decode.
// Not real IndexedDB, authentication, browser decoder or print acceptance.
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createExportSnapshotCore}=require('../src/db/exportSnapshotCore.ts')
const {createExportPreflightTask}=require('../src/shared/exportPreflightTask.ts')
const {SerialImageDecoder}=require('../src/shared/exportImageResources.ts')
const {touchesExportContent}=require('../src/shared/exportContentMutation.ts')
const fixtures=import('../tools/print-lab/resource-fixtures.mjs')
const all={scope:{kind:'all'}},id='01900000-0000-7000-8000-000000000001'
const immediate=()=>new Promise(setImmediate),code=c=>e=>e.code===c
function fixture(blob){
 let txn=false,auth={subject:'A',generation:1,valid:true},identity,contentChanged,contentFailed,watchers=0,reads=0
 const hooks={},row={id:'e1',entryDate:'2026-10-21',sortOrder:1,title:'old',contentText:'old',mood:null,weather:null,tagIds:[],updatedAt:'2026-10-21',isDeleted:0,deletedAt:null,
 content:{schemaVersion:1,doc:{type:'doc',content:blob?[{type:'image',attrs:{src:`local://media/${id}`}}]:[{type:'paragraph',content:[{type:'text',text:'old'}]}]}}}
 const io={read:async work=>{assert(!txn);txn=true;try{return await work()}finally{txn=false;await hooks.commit?.()}},owner:async()=>({ownerUserId:'A',generation:'epoch'}),auth:()=>auth,
 scan:async(_,visit)=>{visit(structuredClone(row));await hooks.scan?.()},tag:async()=>undefined,media:async()=>({id,blob,thumbBlob:null}),
 observeIdentity:changed=>{identity=changed;return()=>{}},observeContent:(changed,failed)=>{watchers++;contentChanged=changed;contentFailed=failed;return()=>watchers--},now:()=>1,monotonic:()=>0}
 const port=createExportSnapshotCore(io,{ownerUserId:'A',generation:'epoch',authGeneration:1}),q=new SerialImageDecoder(),bitmaps=[]
 const decode=async()=>{assert.equal(txn,false,'decode inside transaction');await hooks.decode?.();const b={width:512,height:768,closed:0,close(){this.closed++}};bitmaps.push(b);return b}
 const task=createExportPreflightTask(port,{decoder:q,decode})
 return {port,task,q,row,hooks,io,bitmaps,decode,changed:()=>contentChanged(),failed:()=>contentFailed(),expire:()=>{auth={...auth,valid:false};identity()},get txn(){return txn},get watchers(){return watchers},get reads(){return reads},inc(){reads++}}
}
test('capture commits before Blob read/decode; checked never means full output readiness',async()=>{
 const {fixtureBlob}=await fixtures,b=fixtureBlob('png'),f=fixture(b),arrayBuffer=b.arrayBuffer.bind(b)
 b.arrayBuffer=async()=>{assert(!f.txn);f.inc();return arrayBuffer()};await f.task.run(all);const m=await f.task.read()
 assert.equal(f.reads,1);assert.equal(m.images.pixels,512*768);assert.equal(m.completeOutputReady,false);assert.equal(m.snapshot.completeOutputReady,false);assert(f.bitmaps.every(b=>b.closed===1));f.task.close();assert.equal(f.watchers,0);f.port.close()
})
test('empty images checked without decoding; incomplete diagnostic is retained, never silently skipped',async()=>{
 const f=fixture();await f.task.run(all);assert.equal((await f.task.read()).images.items.length,0);f.task.close();f.port.close()
 const g=fixture();g.row.content={schemaVersion:999,doc:{type:'doc',content:[]}};await g.task.run(all);assert.equal((await g.task.read()).snapshot.diagnostics[0].code,'CONTENT_UNSUPPORTED');assert.equal((await g.task.read()).completeOutputReady,false);g.task.close();g.port.close()
})
test('sticky conservative mutation notice preserves old content; rerun explicitly takes new snapshot',async()=>{
 const f=fixture(),events=[];f.task.subscribe(()=>{throw Error('consumer')});f.task.subscribe(s=>events.push(s));await f.task.run(all);const old=(await f.task.read()).snapshot
 f.row.title='new';f.changed();assert.equal(f.task.status().changed,true);assert.equal((await f.task.read()).snapshot,old);assert.equal(old.entries[0].title,'old');
 await f.task.run(all);assert.equal((await f.task.read()).snapshot.entries[0].title,'new');assert.equal(f.task.status().changed,false);assert.equal(f.watchers,1);f.task.close();assert.equal(f.watchers,0);f.port.close()
})
test('mutation in commit/publication gap is not missed; late subscriber immediately sees sticky notice',async()=>{
 const f=fixture();f.hooks.commit=f.changed;const h=await f.port.capture(all);assert(h.hasChanges());let calls=0;h.subscribeChanged(()=>calls++);assert.equal(calls,1);h.release();assert.equal(f.watchers,0);f.port.close()
})
test('watcher failure closes identity context and task; no stale ready result',async()=>{
 const f=fixture();await f.task.run(all);f.failed();assert.equal(f.task.status().state,'closed');await assert.rejects(f.task.read(),code('EXPORT_PREFLIGHT_NOT_CHECKED'));assert.equal(f.watchers,0)
})
test('snapshot direct release or replacement immediately clears checked task, not only on next read',async()=>{
 const f=fixture();await f.task.run(all);const next=await f.port.capture(all);assert.equal(f.task.status().state,'idle');await assert.rejects(f.task.read(),code('EXPORT_PREFLIGHT_NOT_CHECKED'));await next.read();next.release();f.task.close();f.port.close()
})
test('cancel, external abort and close after checked release handle, watcher and readable data',async()=>{
 for(const operation of ['cancel','abort','close']){const f=fixture(),c=new AbortController();await f.task.run(all,c.signal);if(operation==='abort')c.abort();else f.task[operation]();assert.equal(f.watchers,0);await assert.rejects(f.task.read(),code('EXPORT_PREFLIGHT_NOT_CHECKED'));f.task.close();f.port.close()}
})
test('already aborted signal never reads or publishes checked; retry works',async()=>{
 const f=fixture(),c=new AbortController();c.abort();await assert.rejects(f.task.run(all,c.signal),code('CANCELLED'));assert.equal(f.task.status().state,'failed');assert.equal(f.watchers,0);await f.task.run(all);f.task.close();f.port.close()
})
test('identity changes during native decode cancel job, keep queue busy until late bitmap disposal',async()=>{
 const {fixtureBlob}=await fixtures,f=fixture(fixtureBlob('png'));let release;f.hooks.decode=()=>new Promise(r=>release=r)
 const pending=f.task.run(all);await immediate();assert(release);f.expire();await assert.rejects(pending);assert.equal(f.task.status().state,'closed');assert(f.q.busy);assert.equal(f.watchers,0)
 release();await immediate();assert.equal(f.q.busy,false);assert.equal(f.bitmaps.length,1);assert.equal(f.bitmaps[0].closed,1);await assert.rejects(f.task.read(),code('EXPORT_PREFLIGHT_NOT_CHECKED'));f.port.close()
})
test('cancel pending decode and reject replacement DECODER_BUSY; retry only after late close',async()=>{
 const {fixtureBlob}=await fixtures,f=fixture(fixtureBlob('png'));let release;f.hooks.decode=()=>new Promise(r=>release=r)
 const pending=f.task.run(all);await immediate();f.task.cancel();await assert.rejects(pending,code('CANCELLED'));assert(f.q.busy);await assert.rejects(f.task.run(all),code('DECODER_BUSY'))
 assert.equal(f.task.status().state,'failed');release();await immediate();assert.equal(f.bitmaps[0].closed,1);f.hooks.decode=null;await f.task.run(all);assert.equal(f.task.status().state,'checked');f.task.close();f.port.close()
})
test('individual broken image becomes explicit review blocker, never full content; explicit retry recaptures',async()=>{
 const f=fixture(new Blob(['not PNG'],{type:'image/png'}));await f.task.run(all);const bad=await f.task.read();
 assert.equal(bad.review.state,'requires-degraded-confirmation');assert.equal(bad.availableImagesChecked,false);assert.equal(bad.images.items.length,0)
 await assert.rejects(f.task.readForLayout('full',bad.review),code('EXPORT_FULL_CONTENT_BLOCKED'));await assert.rejects(f.task.readForLayout('degraded',bad.review),code('EXPORT_DEGRADED_CONFIRMATION_REQUIRED'))
 await f.task.confirmDegraded(bad.review);assert.equal((await f.task.readForLayout('degraded',bad.review)).completeOutputReady,false);f.task.close();assert.equal(f.watchers,0);f.port.close()
 const {fixtureBlob}=await fixtures,g=fixture(fixtureBlob('png'));g.hooks.decode=()=>{throw Error('injected native failure')};await g.task.run(all);const old=(await g.task.read()).review;
 assert.equal(old.issues[0].code,'IMAGE_DECODE_FAILED');g.hooks.decode=null;await g.task.run(all);const current=await g.task.read();assert.equal(current.review.state,'full-content-available');await assert.rejects(g.task.confirmDegraded(old),code('EXPORT_STALE_REVIEW'));g.task.close();g.port.close()
})
test('old late capture cannot clear newer task; old external abort cannot cancel replacement',async()=>{
 const f=fixture();let release,n=0;f.hooks.scan=()=>{if(++n===1)return new Promise(r=>release=r)}
 // IO deliberately disallows concurrent transaction: queue the first at owner boundary instead.
 f.hooks.scan=null;const owner=f.io.owner;let first=true;f.io.owner=async()=>{if(first){first=false;await new Promise(r=>release=r)}return owner()}
 const c=new AbortController(),old=f.task.run(all,c.signal);await immediate();await f.task.run(all);c.abort();release();await assert.rejects(old);assert.equal(f.task.status().state,'checked');await f.task.read();f.task.close();f.port.close()
})
test('mutation routing isolates database/table, includes indexes/deletions; metadata never content notice',()=>{
 for(const table of ['entries','tags','media'])for(const index of ['',':dels',':id','[isDeleted+entryDate]'])assert(touchesExportContent('q',{[`idb://q/${table}/${index}`]:{}}))
 for(const key of ['idb://other/entries/', 'idb://qq/entries/', 'idb://q/meta/', 'idb://q/schedules/', 'idb://q/entriesExtra/'])assert(!touchesExportContent('q',{[key]:{}}))
})
test('content watch removed after failed acquisition and repeated release; bad listeners isolated',async()=>{
 const f=fixture();f.hooks.scan=()=>{throw Error('read')};await assert.rejects(f.port.capture(all));assert.equal(f.watchers,0);f.hooks.scan=null;const h=await f.port.capture(all);let calls=0;h.subscribeReleased(()=>{throw Error('consumer')});h.subscribeReleased(()=>calls++);h.release();h.release();assert.equal(calls,1);assert.equal(f.watchers,0);f.port.close()
})
test('close during pending ownership await removes content watch immediately, not when IO finally resolves',async()=>{
 const f=fixture();let resume;const original=f.io.owner;f.io.owner=async()=>{await new Promise(r=>resume=r);return original()}
 const pending=f.port.capture(all);await immediate();assert.equal(f.watchers,1);f.port.close();assert.equal(f.watchers,0);resume();await assert.rejects(pending);assert.equal(f.watchers,0);f.task.close()
})

test('degraded confirmation is exact-object, current-task scoped, revocable and not a print capability',async()=>{
 const f=fixture();f.row.content={schemaVersion:999,doc:{type:'doc',content:[]}};await f.task.run(all);const first=await f.task.read();
 await assert.rejects(f.task.confirmDegraded({...first.review}),code('EXPORT_STALE_REVIEW'))
 await f.task.confirmDegraded(first.review);assert.equal((await f.task.read()).degradedConfirmed,true);assert.equal(f.task.status().contentPolicy,'degraded-confirmed')
 assert.equal((await f.task.readForLayout('degraded',first.review)).completeOutputReady,false)
 await assert.rejects(f.task.readForLayout('full',first.review),code('EXPORT_FULL_CONTENT_BLOCKED'))
 f.task.revokeDegraded();await assert.rejects(f.task.readForLayout('degraded',first.review),code('EXPORT_DEGRADED_CONFIRMATION_REQUIRED'))
 await f.task.confirmDegraded(first.review);f.changed();assert.equal((await f.task.read()).degradedConfirmed,true);assert.equal((await f.task.read()).snapshot,first.snapshot)
 await f.task.run(all);assert.equal((await f.task.read()).degradedConfirmed,false);await assert.rejects(f.task.confirmDegraded(first.review),code('EXPORT_STALE_REVIEW'));f.task.close();f.port.close()
})
test('equal diagnostics from another task cannot confirm this task, cancellation or identity clears confirmation',async()=>{
 const a=fixture(),b=fixture();for(const f of[a,b]){f.row.content={schemaVersion:999,doc:{type:'doc',content:[]}};await f.task.run(all)}
 const ar=(await a.task.read()).review,br=(await b.task.read()).review;assert.deepEqual(ar,br);await assert.rejects(a.task.confirmDegraded(br),code('EXPORT_STALE_REVIEW'))
 await a.task.confirmDegraded(ar);a.expire();await assert.rejects(a.task.readForLayout('degraded',ar));await assert.rejects(a.task.confirmDegraded(ar));assert.equal(a.watchers,0)
 await b.task.confirmDegraded(br);b.task.cancel();await assert.rejects(b.task.readForLayout('degraded',br));a.task.close();b.task.close();a.port.close();b.port.close()
})
test('full content handoff still never ready; empty selection cannot become an empty printed book',async()=>{
 const f=fixture();await f.task.run(all);const value=await f.task.read();assert.equal((await f.task.readForLayout('full',value.review)).completeOutputReady,false)
 await assert.rejects(f.task.confirmDegraded(value.review),code('EXPORT_DEGRADED_NOT_NEEDED'));f.task.close();f.port.close()
 const g=fixture();g.row.isDeleted=1;await g.task.run(all);const empty=await g.task.read();assert.equal(empty.review.state,'empty-selection');await assert.rejects(g.task.readForLayout('full',empty.review),code('EXPORT_EMPTY_SELECTION'));g.task.close();g.port.close()
})
test('identity is rechecked while acknowledging, old pending confirmation cannot bless a replacement',async()=>{
 const f=fixture();f.row.content={schemaVersion:999,doc:{type:'doc',content:[]}};await f.task.run(all);const review=(await f.task.read()).review
 const owner=f.io.owner;let resume,once=true;f.io.owner=async()=>{if(once){once=false;await new Promise(r=>resume=r)}return owner()}
 const pending=f.task.confirmDegraded(review);await immediate();await f.task.run(all);resume();await assert.rejects(pending);assert.equal((await f.task.read()).degradedConfirmed,false);f.task.close();f.port.close()
})
test('cancel or revoke between nested read completion and layout publication cannot return stale permission',async()=>{
 for(const action of ['cancel','revokeDegraded']){
  const f=fixture(),capture=f.port.capture;let intervene=false
  f.port.capture=async(...args)=>{const h=await capture(...args),read=h.read;return{...h,async read(){const model=await read();if(intervene){intervene=false;queueMicrotask(()=>queueMicrotask(()=>f.task[action]()))}return model}}}
  f.row.content={schemaVersion:999,doc:{type:'doc',content:[]}};await f.task.run(all);const review=(await f.task.read()).review;await f.task.confirmDegraded(review);intervene=true
  await assert.rejects(f.task.readForLayout('degraded',review),e=>['EXPORT_STALE_REVIEW','EXPORT_DEGRADED_CONFIRMATION_REQUIRED','EXPORT_PREFLIGHT_RELEASED'].includes(e.code));f.task.close();f.port.close()
 }
})
test('revoking while confirmation awaits identity prevents late acknowledgement from restoring consent',async()=>{
 const f=fixture();f.row.content={schemaVersion:999,doc:{type:'doc',content:[]}};await f.task.run(all);const review=(await f.task.read()).review
 const owner=f.io.owner;let resume,once=true;f.io.owner=async()=>{if(once){once=false;await new Promise(r=>resume=r)}return owner()}
 const pending=f.task.confirmDegraded(review);await immediate();f.task.revokeDegraded();resume();await assert.rejects(pending,code('EXPORT_STALE_REVIEW'));assert.equal((await f.task.read()).degradedConfirmed,false);f.task.close();f.port.close()
})
