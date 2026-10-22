const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNotebookReadCore } = require('../src/db/notebookReadCore.ts')
const { createNotebookImageLoader } = require('../src/capabilities/notebookImageLoader.ts')
const { createNotebookObjectUrls } = require('../src/capabilities/notebookObjectUrls.ts')
const id = '019b178b-1111-7111-8111-111111111111'
function fixture() {
  const entry={id:'entry',title:'原题',content:{schemaVersion:1,doc:{type:'doc',content:[{type:'image',attrs:{src:`local://media/${id}`}}]}},contentText:'',entryDate:'2026-10-21',isDeleted:0,deletedAt:null,dirty:1,updatedAt:'revision',tagIds:[]}
  const media={id,blob:new Blob(['png'],{type:'image/png'}),thumbBlob:null,dirty:1,remoteUrl:'https://must-not-fetch.test',size:3}
  let owner={ownerUserId:'A',generation:'epoch1'},auth={subject:'A',generation:1,valid:true},hook=async()=>{},observer,stops=0
  let entryValue=entry
  const calls=[]
  const io={read:async work=>{calls.push('r');const r=await work();await hook();return r},owner:async()=>({...owner}),auth:()=>({...auth}),entry:async()=>entryValue,media:async()=>{calls.push('media');return media},observe:(_ids,changed,failed)=>{observer={changed,failed};return()=>{stops++}}}
  const port=createNotebookReadCore(io,{ownerUserId:'A',generation:'epoch1',authGeneration:1})
  return {port,entry,media,calls,setEntry:v=>entryValue=v,setOwner:v=>owner=v,setAuth:v=>auth=v,setHook:v=>hook=v,emit:()=>observer.changed(),get stops(){return stops}}
}
test('reads dirty entry and original Blob without business mutation/download',async()=>{
  const f=fixture(),before=JSON.stringify([f.entry,f.media])
  assert.equal((await f.port.readEntry('entry')).title,'原题')
  const r=await f.port.readMedia(f.entry,id);assert.equal(r.state,'ready');assert.equal(r.thumbnailOnly,false)
  assert.equal(JSON.stringify([f.entry,f.media]),before);assert.deepEqual(f.calls,['r','r','media'])
})
for(const state of ['deletedFlag','deletedTimestamp','missing']) test(`exclude ${state}`,async()=>{
  const f=fixture();if(state==='deletedFlag') f.entry.isDeleted=1
  if(state==='deletedTimestamp') f.entry.deletedAt='2026-10-21'
  if(state==='missing') f.setEntry(undefined)
  assert.equal(await f.port.readEntry('entry'),undefined)
})
for(const change of ['account','logout-generation','token-expiry','owner','epoch']) test(`reject ${change} at transaction completion`,async()=>{
  const f=fixture();f.setHook(async()=>{
    if(change==='account') f.setAuth({subject:'B',generation:2,valid:true})
    if(change==='logout-generation') f.setAuth({subject:'A',generation:2,valid:true})
    if(change==='token-expiry') f.setAuth({subject:'A',generation:1,valid:false})
    if(change==='owner') f.setOwner({ownerUserId:'B',generation:'epoch1'})
    if(change==='epoch') f.setOwner({ownerUserId:'A',generation:'epoch2'})
  });await assert.rejects(f.port.readEntry('entry'),/失效/)
})
test('owner-empty is not implicit claim',async()=>{const f=fixture();f.setOwner({ownerUserId:'',generation:'epoch1'});await assert.rejects(f.port.readEntry('entry'))})
test('no fetch fallback when original/thumbnail missing',async()=>{
  const f=fixture();f.media.blob=new Blob([],{type:'image/png'})
  assert.equal((await f.port.readMedia(f.entry,id)).state,'missing')
})
test('existing thumbnail is an explicit downgrade, not generated or written',async()=>{
  const f=fixture();f.media.blob=new Blob();f.media.thumbBlob=new Blob(['thumb'],{type:'image/webp'})
  const r=await f.port.readMedia(f.entry,id);assert.equal(r.state,'ready');assert.equal(r.thumbnailOnly,true)
})
for(const mime of ['image/svg+xml','text/html','application/octet-stream']) test(`unsupported media ${mime}`,async()=>{
  const f=fixture();f.media.blob=new Blob(['<svg>'],{type:mime});assert.equal((await f.port.readMedia(f.entry,id)).state,'unsupported')
})
test('unreferenced media never reaches IO',async()=>{const f=fixture();await assert.rejects(f.port.readMedia(f.entry,'other'));assert(!f.calls.includes('media'))})
test('changed Entry revision rejects stale image snapshot',async()=>{
  const f=fixture(),snapshot=structuredClone(f.entry);f.entry.title='新题';await assert.rejects(f.port.readMedia(snapshot,id),/变化/)
})
test('close stops subscriptions and late callbacks, rejects all reads',async()=>{
  const f=fixture();let changed=0;const stop=f.port.subscribe(['entry'],()=>changed++,()=>{})
  f.emit();assert.equal(changed,1);f.port.close();f.emit();stop();assert.equal(changed,1);assert.equal(f.stops,1)
  await assert.rejects(f.port.readEntry('entry'))
})
test('IO failure propagates, never becomes empty success',async()=>{const f=fixture();f.setHook(async()=>{throw new Error('storage failed')});await assert.rejects(f.port.readEntry('entry'),/storage failed/)})
function urlFixture(){const created=[],revoked=[];const api={createObjectURL:()=>{const url=`blob:test-${created.length}`;created.push(url);return url},revokeObjectURL:url=>revoked.push(url)};return{api,created,revoked}}
const ready={state:'ready',blob:new Blob(['img'],{type:'image/png'}),thumbnailOnly:false}
const tick=()=>new Promise(r=>setImmediate(r))
test('URL ownership is per instance, close idempotent and blocks reuse',()=>{
  const f=urlFixture(),a=createNotebookObjectUrls(f.api),b=createNotebookObjectUrls(f.api)
  const one=a.create(ready.blob),two=b.create(ready.blob);a.release(two);a.close();a.close();assert.deepEqual(f.revoked,[one]);assert.throws(()=>a.create(ready.blob));b.close();assert.deepEqual(f.revoked,[one,two])
})
test('actual image controller drops slow older image before allocating URL',async()=>{
  const f=urlFixture(),states=[];let resolveOld
  const loader=createNotebookImageLoader(s=>states.push(s),f.api)
  const slow=loader.load({readMedia:()=>new Promise(r=>resolveOld=r),assertCurrent:async()=>{}},{},'old')
  await loader.load({readMedia:async()=>ready,assertCurrent:async()=>{}},{},'new')
  resolveOld(ready);await slow;assert.equal(f.created.length,1);assert.equal(states.at(-1).url,f.created[0]);loader.close();assert.deepEqual(f.revoked,f.created)
})
test('clear while reading (offscreen/entry changed) drops delayed result',async()=>{
  const f=urlFixture();let resolve
  const loader=createNotebookImageLoader(()=>{},f.api),p=loader.load({readMedia:()=>new Promise(r=>resolve=r),assertCurrent:async()=>{}},{},id)
  loader.clear();resolve(ready);await p;assert.equal(f.created.length,0)
})
test('identity invalidation during post-read guard allocates no URL',async()=>{
  const f=urlFixture(),states=[],loader=createNotebookImageLoader(s=>states.push(s),f.api)
  await loader.load({readMedia:async()=>ready,assertCurrent:async()=>{throw Error('expired')}},{},id)
  assert.equal(f.created.length,0);assert(states.at(-1).message.includes('失败'))
})
test('unmount during guard suppresses late publication and URL allocation',async()=>{
  const f=urlFixture(),states=[];let resolve
  const loader=createNotebookImageLoader(s=>states.push(s),f.api)
  const p=loader.load({readMedia:async()=>ready,assertCurrent:()=>new Promise(r=>resolve=r)},{},id)
  await tick();loader.close();const count=states.length;resolve();await p;assert.equal(f.created.length,0);assert.equal(states.length,count)
})
test('replace releases previous URL; missing/failed image stays readable as notice',async()=>{
  const f=urlFixture(),states=[],loader=createNotebookImageLoader(s=>states.push(s),f.api)
  const port={readMedia:async()=>ready,assertCurrent:async()=>{}}
  await loader.load(port,{},id);await loader.load({...port,readMedia:async()=>({state:'missing'})},{},id)
  assert.deepEqual(f.revoked,f.created);assert.equal(states.at(-1).url,'');assert.equal(states.at(-1).message,'本机图片未就绪')
})
test('close actively tells displayed readers to clear, not merely stops future IO',()=>{
  const f=fixture();let cleared=0
  f.port.subscribe(['entry'],()=>{},()=>{cleared++})
  f.port.close();f.port.close();assert.equal(cleared,1)
})
test('visible-image subscription observes only supplied media identity and is disposed',()=>{
  const f=fixture();let changed=0
  const stop=f.port.subscribeMedia('entry',id,()=>changed++,()=>{})
  f.emit();assert.equal(changed,1);stop();f.emit();assert.equal(changed,1);assert.equal(f.stops,1)
})

for (const [name, original, thumbnail, expected] of [
  ['empty supported MIME with null thumbnail', new Blob([], {type:'image/png'}), null, 'missing'],
  ['empty original with unsupported thumbnail', new Blob(), new Blob(['svg'], {type:'image/svg+xml'}), 'unsupported'],
  ['unsupported original with empty thumbnail', new Blob(['html'], {type:'text/html'}), new Blob([], {type:'image/png'}), 'unsupported'],
]) test(`Blob guard false branch: ${name}`, async()=>{
  const f=fixture();f.media.blob=original;f.media.thumbBlob=thumbnail
  const result=await f.port.readMedia(f.entry,id)
  assert.equal(result.state,expected)
  assert.equal(f.media.blob,original);assert.equal(f.media.thumbBlob,thumbnail)
})
