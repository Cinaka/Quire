// Actual TypeScript bodies; injected Axios/Dexie/auth ports, not Vue/browser/HTTP tests.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')
const { test } = require('node:test')
const root = path.resolve(__dirname, '..')
const ID = '0198f2a1-4b3c-7000-8000-abcdef123458'
const blob = () => new Blob(['public fixture'], { type: 'image/png' })

async function load(relative, dependencies, globals = {}) {
  const context = vm.createContext({ Blob, AbortController, console, navigator: { onLine: true }, ...globals })
  const source = stripTypeScriptTypes(fs.readFileSync(path.join(root, relative), 'utf8'))
  const module = new vm.SourceTextModule(source, { context, identifier: relative })
  await module.link(async name => {
    assert.ok(Object.hasOwn(dependencies, name), `unmocked import: ${name}`)
    const exports = dependencies[name]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  return module.namespace
}

class ApiError extends Error {}
async function transport(overrides = {}) {
  const state = { subject: 'A', generation: 1, calls: [], status: 200, data: blob(), ...overrides }
  const mod = await load('src/api/privateMedia.ts', {
    './request': { ApiError, http: { get: async (url, options) => {
      state.calls.push({ url, options })
      if (state.during) state.during(options)
      if (state.error) throw state.error
      return { status: state.status, data: state.data }
    } } },
    './tokenStore': { accessTokenSubject: () => state.subject, tokenGeneration: () => state.generation },
  })
  return { state, read: () => mod.readPrivateMedia(ID, 'original', { ownerUserId: 'A', tokenGeneration: 1 }), mod }
}

test('private bytes use fixed API ID path and a pinned bearer interceptor lease', async () => {
  const { state, read } = await transport()
  assert.equal((await read()).type, 'image/png')
  const { url, options } = state.calls[0]
  assert.equal(url, `/media/${ID}/original`)
  assert.equal(options._syncOwner, 'A'); assert.equal(options._tokenGeneration, 1)
  assert.equal(options.responseType, 'blob'); assert.equal(url.includes('token'), false)
})
test('invalid ID rejected before Axios', async () => {
  const { state, mod } = await transport()
  await assert.rejects(mod.readPrivateMedia('https://evil.test/image', 'original', { ownerUserId:'A',tokenGeneration:1 }))
  assert.equal(state.calls.length, 0)
})
test('account switch rejects a late image response', async () => {
  const { state, read } = await transport(); state.during = () => { state.subject = 'B' }
  await assert.rejects(read())
})
test('restore/auth generation change rejects a late image response', async () => {
  const { state, read } = await transport(); state.during = () => { state.generation++ }
  await assert.rejects(read())
})
test('oversize download progress aborts and final size is also checked', async () => {
  const { state, read } = await transport({data:new Blob([new Uint8Array(10*1024*1024+1)],{type:'image/png'})})
  state.during = options => options.onDownloadProgress({ loaded:10*1024*1024+1 })
  await assert.rejects(read()); assert.equal(state.calls[0].options.signal.aborted,true)
})
test('HTML, empty, and non-200 blobs never become local media', async () => {
  for (const overrides of [{data:new Blob(['html'],{type:'text/html'})},{data:new Blob([],{type:'image/png'})},{status:404}]) {
    const { read }=await transport(overrides);await assert.rejects(read())
  }
})
test('429, 401 and 503 failures do not pretend to be image success', async () => {
  for(const code of [429,401,503]) { const {read}=await transport({error:new Error(String(code))});await assert.rejects(read()) }
})

async function cloud(overrides={}) {
  const item={id:ID,blob:new Blob([]),thumbBlob:null,remoteUrl:'https://evil.test/no-fetch',thumbRemoteUrl:'',dirty:1}
  const state={item,epoch:1,generation:1,assertions:0,reads:[],updates:0,...overrides}
  const db={meta:{},media:{
    get:async()=>state.item,
    update:async(id,patch)=>{state.updates++;state.item={...state.item,...patch};if(state.afterWrite)state.afterWrite()},
  },transaction:async(...args)=>{
    const before=state.item
    try{return await args.at(-1)()}catch(error){state.item=before;throw error}
  }}
  const mod=await load('src/db/cloudMediaRepo.ts',{
    '@/api/privateMedia':{readPrivateMedia:async(id,variant,context)=>{
      state.reads.push({id,variant,context});if(state.afterRead)state.afterRead();if(state.error)throw state.error;return blob()
    }},
    '@/api/tokenStore':{accessTokenSubject:()=> 'A',tokenGeneration:()=>state.generation},
    '@/api/syncContext':{
      captureSyncContext:async()=>({ownerUserId:'A',tokenGeneration:1,epoch:state.epoch}),
      assertSyncContext:async context=>{if(context.epoch!==state.epoch)throw Error('stale');state.assertions++;if(state.afterAssert)state.afterAssert()},
    },
    './mediaRepo':{localMediaRepo:{get:async()=>state.item,getThumb:async()=>state.item?.blob}},
    './schema':{db},
  })
  return {state,repo:mod.localFirstMediaRepo}
}
test('local bytes remain usable without a cloud request',async()=>{
  const {state,repo}=await cloud();state.item.blob=blob();await repo.get(ID)
  assert.equal(state.reads.length,0)
})
test('cloud fill uses ID not wire URL, preserves dirty flag',async()=>{
  const {state,repo}=await cloud();const result=await repo.get(ID)
  assert.equal(state.reads[0].id,ID);assert.equal(state.reads[0].variant,'original')
  assert.equal(result.dirty,1);assert.equal(result.blob.type,'image/png')
})
test('failed cloud request does not write or clear local data',async()=>{
  const {state,repo}=await cloud({error:Error('429')});const before=state.item
  assert.equal(await repo.get(ID),undefined);assert.equal(state.updates,0);assert.equal(state.item,before)
})
test('restored DB epoch cancels late download before any write',async()=>{
  const {state,repo}=await cloud();state.afterRead=()=>state.epoch++
  assert.equal(await repo.get(ID),undefined);assert.equal(state.updates,0)
})
test('deleted media row is never recreated by late response',async()=>{
  const {state,repo}=await cloud();state.afterRead=()=>{state.item=undefined}
  assert.equal(await repo.get(ID),undefined);assert.equal(state.updates,0)
})
test('context failure after write aborts mock transaction, does not publish bytes',async()=>{
  const {state,repo}=await cloud();const before=state.item;state.afterWrite=()=>state.epoch++
  assert.equal(await repo.get(ID),undefined);assert.equal(state.item,before)
})
test('auth change inside final awaited owner check still aborts publication',async()=>{
  const {state,repo}=await cloud();const before=state.item
  state.afterAssert=()=>{if(state.assertions===3)state.generation++}
  assert.equal(await repo.get(ID),undefined);assert.equal(state.item,before)
})
test('newer local bytes are not overwritten by a pending download',async()=>{
  const {state,repo}=await cloud();const newer=blob();state.afterRead=()=>{state.item={...state.item,blob:newer}}
  const result=await repo.get(ID);assert.equal(result.blob,newer);assert.equal(state.updates,0)
})

async function syncScenario({paused=false,message='账号图片容量已达上限'}={}) {
  let errors=paused?[{kind:'media',id:ID,message,paused:true,count:3}]:[]
  const media={id:ID,entryId:'entry',blob:blob(),thumbBlob:null,dirty:1}
  let uploads=0, pushes=0
  const table=items=>({where:()=>({equals:()=>({toArray:async()=>items})})})
  const db={entries:table([]),tags:table([]),media:table([media]),schedules:{},meta:{
    get:async key=>({value:key==='syncErrors'?errors:key==='ownerUserId'?'A':undefined}),
    put:async row=>{if(row.key==='syncErrors')errors=row.value},
  },transaction:async(...args)=>args.at(-1)()}
  const identity=value=>value
  const held=async()=>({entryIds:new Set(),tagIds:new Set(),mediaIds:new Set()})
  const mod=await load('src/api/sync.ts',{
    '@/api/endpoints':{uploadMedia:async()=>{uploads++;throw Error(message)},pushBatch:async()=>{pushes++;throw Error('unexpected push')},pullChanges:async()=>{throw Error('unexpected pull')}},
    '@/api/mappers':Object.fromEntries(['fromWireEntry','fromWireTag','mediaPatchFromWire','toWireEntry','toWireMediaMetaPush','toWireTag'].map(name=>[name,identity])),
    '@/db/schema':{db},'@/db/scheduleStateRepo':{holdConversionServerEntry:async()=>{},protectedConversions:held},
    './syncContext':{assertSyncContext:async()=>{},captureSyncContext:async()=>({ownerUserId:'A',generation:1,tokenGeneration:1})},
    '@/shared/time':{utcNow:()=>new Date().toISOString()},
  })
  await assert.rejects(mod.runSync(), error => error.message.includes(message))
  assert.equal(media.dirty,1);assert.equal(pushes,0);assert.equal(uploads,paused?0:1)
}
test('upload quota failure keeps dirty and rejects sync instead of success',async()=>syncScenario())
test('paused media error cannot turn later no-work sync into success',async()=>syncScenario({paused:true}))

test('503 cloud fill preserves local metadata and dirty',async()=>{
  const {state,repo}=await cloud({error:Error('503 安全限流服务暂不可用')});const before=state.item
  assert.equal(await repo.get(ID),undefined);assert.equal(state.updates,0);assert.equal(state.item,before)
  assert.equal(state.item.dirty,1)
})
test('503 upload failure keeps dirty and rejects sync',async()=>syncScenario({message:'503 安全限流服务暂不可用'}))
test('paused 503 error never becomes later sync success',async()=>syncScenario({paused:true,message:'503 安全限流服务暂不可用'}))
