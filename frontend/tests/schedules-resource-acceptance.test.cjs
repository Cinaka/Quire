const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm")
const {setup}=require("./schedules-data-harness.cjs"),{loadTS}=require("./schedules-harness.cjs")
const spec={enabled:true,dailyOrigin:"http://localhost:5173",testOrigin:"http://127.0.0.1:5181"}
const location=()=>({origin:spec.testOrigin,pathname:"/p4-resource-acceptance.html"})
const plain=value=>JSON.parse(JSON.stringify(value)),all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
function harness(enabled=true){let token="";const win={location:location()},storage={getItem:()=>token}
 const h=setup({}, {URL,window:win,localStorage:storage,crypto:crypto.webcrypto,__QUIRE_P4_RESOURCE_ACCEPTANCE__:enabled})
 h.identity=h.load("resource-acceptance/identity.ts");h.mocks["./identity"]=h.identity
 const tokens={accessTokenSubject:h.identity.resourceAccessTokenSubject,tokenGeneration:h.identity.resourceTokenGeneration,getAccessToken:h.identity.resourceGetAccessToken}
 h.mocks["@/api/tokenStore"]=tokens;h.mocks["./tokenStore"]=tokens
 h.barrier=h.load("resource-acceptance/barrier.ts");h.mocks["./barrier"]=h.barrier
 h.mocks["./schema"].waitForScheduleResourceBytes=h.barrier.waitForResourceAcceptanceTransaction
 h.mocks["@/db/schema"].waitForScheduleResourceBytes=h.barrier.waitForResourceAcceptanceTransaction
 h.guard=h.load("resource-acceptance/guard.ts");h.db.name=h.guard.RESOURCE_ACCEPTANCE_DB_NAME
 h.model=h.load("resource-acceptance/model.ts");h.runtime=h.load("resource-acceptance/runtime.ts")
 h.window=win;h.token=value=>{token=value};h.activate=()=>h.identity.activateResourceIdentity(spec)
 h.seed=async()=>{h.activate();await h.runtime.initializeResourceAcceptance(spec);await h.runtime.seedResourceAcceptance(spec)}
 h.file=()=>{const text=h.model.resourceFixtureMaterial();return{name:"fixture.json",size:new Blob([text]).size,text:async()=>text}}
 return h
}
test("resource gate requires independent explicit origin/path/build and never adopts daily or old guest store",()=>{
 const h=harness();assert.deepEqual(plain(h.guard.assertResourceAcceptanceLocation(spec,location())),spec)
 for(const bad of [{...spec,enabled:false},{...spec,dailyOrigin:spec.testOrigin},{...spec,testOrigin:"https://real.example"},{...spec,dailyOrigin:"http://user:pass@localhost:5173"}])assert.throws(()=>h.guard.assertResourceAcceptanceLocation(bad,location()))
 for(const loc of [{...location(),origin:spec.dailyOrigin},{...location(),origin:"http://127.0.0.1:5179"},{...location(),pathname:"/p4-acceptance.html"}])assert.throws(()=>h.guard.assertResourceAcceptanceLocation(spec,loc))
 assert.notEqual(h.db.name,"quire");assert.notEqual(h.db.name,"quire-p4-acceptance")
})
for(const mode of ["inactive","normal-build","token","daily","wrong-db"])test(`identity ${mode} refuses before initialization mutates tables`,async()=>{
 const h=harness(mode!=="normal-build"),before=all(h)
 if(mode!=="inactive"&&mode!=="normal-build")h.activate()
 if(mode==="normal-build")assert.throws(()=>h.activate())
 if(mode==="token")h.token("real-token")
 if(mode==="daily")h.window.location.origin=spec.dailyOrigin
 if(mode==="wrong-db")h.db.name="quire"
 await assert.rejects(h.runtime.initializeResourceAcceptance(spec));assert.equal(all(h),before)
})
test("explicit activation has no real token; deactivation invalidates the demo generation",()=>{
 const h=harness();assert.equal(h.identity.resourceAccessTokenSubject(),"");h.activate();const gen=h.identity.resourceTokenGeneration()
 assert.equal(h.identity.resourceAccessTokenSubject(),h.identity.RESOURCE_DEMO_OWNER);assert.equal(h.identity.resourceGetAccessToken(),"")
 h.identity.deactivateResourceIdentity();assert.equal(h.identity.resourceAccessTokenSubject(),"");assert.ok(h.identity.resourceTokenGeneration()>gen)
})
test("initialization only writes a strict origin marker, no fixture or owner until explicit seed",async()=>{
 const h=harness();h.activate();await h.runtime.initializeResourceAcceptance(spec)
 assert.equal(h.stores.meta.rows.size,1);assert.equal(h.stores.entries.rows.size,0);assert.equal(h.stores.media.rows.size,0)
 const before=all(h);await h.runtime.initializeResourceAcceptance(spec);assert.equal(all(h),before)
})
for(const existing of ["entry","unknown-meta","wrong-marker"])test(`unknown ${existing} is never claimed, cleared or overwritten`,async()=>{
 const h=harness();h.activate()
 if(existing==="entry")await h.db.entries.put({id:"private"})
 if(existing==="unknown-meta")await h.db.meta.put({key:"private",value:"keep"})
 if(existing==="wrong-marker")await h.db.meta.put({key:h.guard.RESOURCE_ACCEPTANCE_MARKER,value:{unknown:true}})
 const before=all(h);await assert.rejects(h.runtime.initializeResourceAcceptance(spec));assert.equal(all(h),before)
})
test("one atomic seed retains source, diary, intention and candidate while leaving image row missing",async()=>{
 const h=harness();await h.seed();const state=await h.runtime.inspectResourceAcceptance(spec)
 assert.deepEqual(plain(state),{sourceCount:1,entryCount:1,intentionCount:1,candidateCount:1,mediaRows:0,archiveCount:0,originalMatches:false,thumbnailMatches:false})
 const text=h.model.resourceFixtureMaterial(),proof=await h.model.resourceFixtureProof();assert.equal(proof.media[0].original.size,68)
 const parsed=h.load("shared/scheduleResourceEvidence.ts").parseScheduleResourceEvidence(text);assert.equal(parsed.completeLocalResources,true);assert.equal(parsed.media.length,1)
 assert.doesNotMatch(text,/ownerUserId|https:\/\/|tokenGeneration/)
 const before=all(h);await assert.rejects(h.runtime.seedResourceAcceptance(spec));assert.equal(all(h),before)
})
test("concurrent seeds create exactly one fixture without adding copies",async()=>{
 const h=harness();h.activate();await h.runtime.initializeResourceAcceptance(spec)
 const results=await Promise.allSettled([h.runtime.seedResourceAcceptance(spec),h.runtime.seedResourceAcceptance(spec)])
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(h.stores.entries.rows.size,1)
})
for(const table of ["entries","schedules","meta"])test(`seed ${table} failure rolls back every row and owner binding`,async()=>{
 const h=harness();h.activate();await h.runtime.initializeResourceAcceptance(spec);const before=all(h);h.failNext(table)
 await assert.rejects(h.runtime.seedResourceAcceptance(spec));assert.equal(all(h),before)
})
test("credential appearing during seed rolls back and never removes that credential",async()=>{
 const h=harness();h.activate();await h.runtime.initializeResourceAcceptance(spec);const before=all(h),add=h.db.entries.add
 h.db.entries.add=async row=>{await add(row);h.token("unexpected-real-token")}
 await assert.rejects(h.runtime.seedResourceAcceptance(spec));assert.equal(all(h),before);assert.throws(()=>h.identity.resourceAccessTokenSubject())
})
test("dedicated session uses the real repairer, actual SHA and immutable demo business data",async()=>{
 const h=harness();await h.seed();const rows=h.model.resourceFixtureRows(),session=h.runtime.createResourceAcceptanceSession(spec,()=>{})
 try{const r=await session.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID],h.file());assert.equal(r.ready,true)
  const before=await h.runtime.inspectResourceAcceptance(spec);assert.equal(before.mediaRows,0)
  assert.equal((await session.port.repair(r.reviewId,false)).repaired,false)
  const result=await session.port.repair(r.reviewId,true);assert.equal(result.repaired,true);assert.equal(result.intentStatus,"unchanged_protected")
  const status=await h.runtime.inspectResourceAcceptance(spec);assert.equal(status.mediaRows,1);assert.equal(status.archiveCount,1);assert.equal(status.originalMatches,true);assert.equal(status.thumbnailMatches,true)
  assert.deepEqual(await h.db.entries.get(rows.entry.id),plain(rows.entry));assert.deepEqual((await h.db.meta.get("scheduleConversions")).value,[plain(rows.intention)])
  assert.equal((await session.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID],h.file())).ready,false)
 }finally{session.close()}
})
for(const mode of ["wrong-source","wrong-selection","foreign-file","changed-owner","extra-meta","changed-diary","foreign-media","unknown-archive"])test(`session rejects ${mode} without importing bytes`,async()=>{
 const h=harness();await h.seed();const session=h.runtime.createResourceAcceptanceSession(spec,()=>{});let id=h.model.RESOURCE_SOURCE_ID,ids=[h.model.RESOURCE_MEDIA_ID],file=h.file()
 if(mode==="wrong-source")id=ids[0]
 if(mode==="wrong-selection")ids=[id]
 if(mode==="foreign-file"){const text=JSON.stringify({...JSON.parse(await file.text()),exportedAt:"2026-10-09T10:00:00.000Z"});file={size:new Blob([text]).size,text:async()=>text}}
 if(mode==="changed-owner")await h.db.meta.put({key:"ownerUserId",value:"foreign"})
 if(mode==="extra-meta")await h.db.meta.put({key:"draft",value:{private:true}})
 if(mode==="changed-diary"){const row=await h.db.entries.get(id);row.title="private";await h.db.entries.put(row)}
 if(mode==="foreign-media")await h.db.media.put({id:ids[0],entryId:"foreign"})
 if(mode==="unknown-archive")await h.db.meta.put({key:"scheduleResourceRepairs",value:[{unknown:true}]})
 const before=all(h);try{assert.equal((await session.port.prepare(id,ids,file)).ready,false);assert.equal(all(h),before)}finally{session.close()}
})
for(const stage of ["proof","transaction"])for(const action of ["cancel","close"])test(`pause ${stage} then ${action} preserves missing bytes and protection`,async()=>{
 const h=harness();await h.seed();const entered=deferred();let waiting=null
 const session=h.runtime.createResourceAcceptanceSession(spec,point=>{waiting=point;if(point)entered.resolve()}),id=h.model.RESOURCE_SOURCE_ID,ids=[h.model.RESOURCE_MEDIA_ID]
 let reviewId,pending
 try{
  if(stage==="transaction"){reviewId=(await session.port.prepare(id,ids,h.file())).reviewId;assert.ok(reviewId>0)}
  assert.equal(session.pauseNext(stage),true)
  pending=stage==="proof"?session.port.prepare(id,ids,h.file()):session.port.repair(reviewId,true)
  await entered.promise;assert.equal(waiting,stage);assert.equal((await session.port.prepare(id,ids,h.file())).reason,"busy")
  if(action==="close")session.close();else session.port.cancel()
  const result=await pending;assert.equal(stage==="proof"?result.ready:result.repaired,false);assert.equal(waiting,null)
  const state=await h.runtime.inspectResourceAcceptance(spec);assert.equal(state.mediaRows,0);assert.equal(state.archiveCount,0);assert.equal(state.intentionCount,1)
 }finally{session.close()}
})
test("transaction pause can explicitly resume into one complete real-factory repair",async()=>{
 const h=harness();await h.seed();const entered=deferred(),session=h.runtime.createResourceAcceptanceSession(spec,p=>{if(p)entered.resolve()})
 try{const r=await session.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID],h.file());session.pauseNext("transaction")
 const pending=session.port.repair(r.reviewId,true);await entered.promise;session.release();assert.equal((await pending).repaired,true)
 assert.equal((await h.runtime.inspectResourceAcceptance(spec)).archiveCount,1)}finally{session.close()}
})
test("cancel during wrapper preflight never starts a new underlying operation afterwards",async()=>{
 const h=harness();await h.seed();const session=h.runtime.createResourceAcceptanceSession(spec,()=>{}),before=all(h)
 const pending=session.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID],h.file());session.port.cancel()
 try{assert.equal((await pending).ready,false);assert.equal(all(h),before)}finally{session.close()}
})
test("barrier refuses overlapping sessions and disposes stale transaction hooks",async()=>{
 const h=harness(),calls=[],barrier=h.barrier.createResourceAcceptanceBarrier(point=>calls.push(point));assert.throws(()=>h.barrier.createResourceAcceptanceBarrier(()=>{}))
 barrier.arm("transaction");const pending=h.barrier.waitForResourceAcceptanceTransaction(Promise.resolve("ok"));await new Promise(r=>setImmediate(r));assert.equal(calls[0],"transaction")
 barrier.dispose();assert.equal(await pending,"ok");assert.equal(calls[1],null)
 const next=h.barrier.createResourceAcceptanceBarrier(()=>{});next.dispose();assert.equal(await h.barrier.waitForResourceAcceptanceTransaction(Promise.resolve(2)),2)
})
function config(daily=spec.dailyOrigin){let source=fs.readFileSync(path.join(__dirname,"../vite.p4-resource-acceptance.config.ts"),"utf8")
 source=require("node:module").stripTypeScriptTypes(source).replace(/^import .*$/gm,"").replaceAll("import.meta.url",JSON.stringify(`file://${path.resolve(__dirname,"../vite.p4-resource-acceptance.config.ts")}`)).replace("export default","globalThis.result =")
 const context={URL,fileURLToPath:require("node:url").fileURLToPath,vue:()=>({}),tailwindcss:()=>({}),defineConfig:fn=>fn(),process:{env:{P4_RESOURCE_DAILY_ORIGIN:daily}}}
 vm.runInNewContext(source,context);return context.result
}
test("dedicated config fails closed and injects only its own DB, demo identity and transaction hook",()=>{
 assert.throws(()=>config(""));assert.throws(()=>config(spec.testOrigin))
 const cfg=config(),plugin=cfg.plugins[2],schema=fs.readFileSync(path.join(__dirname,"../src/db/schema.ts"),"utf8")
 const transformed=plugin.transform(schema,"/project/src/db/schema.ts?v=1");assert.match(transformed,/new QuireDb\("quire-p4-resource-acceptance"\)/);assert.match(transformed,/waitForResourceAcceptanceTransaction\(promise\)/)
 assert.throws(()=>plugin.transform(schema.replace("export const db = new QuireDb()","changed"),"/src/db/schema.ts"))
 assert.throws(()=>plugin.transform(schema.replace("return Dexie.waitFor(promise, 10000)","changed"),"/src/db/schema.ts"))
 assert.match(plugin.transform("private-token-code","/project/src/api/tokenStore.ts"),/resourceAccessTokenSubject/)
 assert.equal(plugin.transform("keep","/project/src/shared/types.ts"),undefined);assert.equal(cfg.server.port,5181);assert.equal(cfg.server.strictPort,true);assert.equal(cfg.server.proxy,undefined)
 assert.match(cfg.server.headers["Content-Security-Policy"],/connect-src 'self' ws:\/\/127.0.0.1:5181/)
})
test("server blocks default/old HTML, main, API, media, request adapter and wrong host",()=>{
 let middleware;config().plugins[2].configureServer({middlewares:{use(fn){middleware=fn}}})
 for(const url of ["/index.html","/p4-acceptance.html","/src/main.ts","/api/v1/schedules","/media/image","/src/api/request.ts"]){const response={end(){}};let next=false;middleware({url,headers:{host:"127.0.0.1:5181"}},response,()=>{next=true});assert.equal(response.statusCode,403);assert.equal(next,false)}
 const response={end(){}};middleware({url:"/p4-resource-acceptance.html",headers:{host:"localhost:5181"}},response,()=>{});assert.equal(response.statusCode,403)
 let next=false;middleware({url:"/p4-resource-acceptance.html",headers:{host:"127.0.0.1:5181"}},{end(){}},()=>{next=true});assert.equal(next,true)
})
test("entry checks native preflight before dynamic business import; page never seeds/mounts a panel automatically",()=>{
 const read=file=>fs.readFileSync(path.join(__dirname,"../src/resource-acceptance",file),"utf8"),entry=read("entry.ts"),page=read("ResourceAcceptancePage.vue")
 assert.ok(entry.indexOf("await preflightResourceAcceptanceDb")<entry.indexOf('await import("./mount")'));assert.match(entry,/confirmed\?\.checked/);assert.match(entry,/quire_access_token/)
 assert.doesNotMatch(entry,/from "vue"|import .*@\/db/);assert.match(page,/v-if="session"/);assert.match(page,/本地模拟证明/);assert.match(page,/最多10秒/)
 assert.doesNotMatch(page,/onMounted|deleteDatabase|db\.[\w.]*clear\(/);assert.match(page,/urls\.clear\(/);assert.doesNotMatch(read("runtime.ts"),/fetch\(|axios|createScheduleCloudResourceTransport|\.clear\(|\.delete\(/)
 assert.doesNotMatch(read("identity.ts"),/setItem|removeItem|addEventListener/)
 const script=page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];assert.doesNotThrow(()=>require("node:module").stripTypeScriptTypes(script))
})
function nativeDb({exists=true,version=30,badMarker=false,upgrade=false,blocked=false}={}){
 const h=harness(),calls=[];let closed=0,aborted=0
 const factory={async databases(){calls.push("list");return exists?[{name:h.guard.RESOURCE_ACCEPTANCE_DB_NAME}]:[]},open(name,requestedVersion){calls.push([name,requestedVersion]);const request={transaction:{abort(){aborted++}}}
 queueMicrotask(()=>{if(upgrade){request.onupgradeneeded();return}if(blocked){request.onblocked();return}
 request.result={version,objectStoreNames:{contains:name=>name==="meta"},close(){closed++},transaction(name,mode){calls.push([name,mode]);const tx={objectStore(){return{get(key){calls.push(key);const read={};queueMicrotask(()=>{read.result={value:badMarker?{kind:"quire-p4-acceptance/v1"}:h.guard.resourceAcceptanceMarker(spec)};read.onsuccess();tx.oncomplete()});return read}}}};return tx}};request.onsuccess()});return request}}
 return{factory,calls,stats:()=>({closed,aborted})}
}
test("resource native preflight lists first and only reads registered v3 without upgrade/version or data writes",async()=>{
 const read=loadTS("resource-acceptance/preflight.ts").preflightResourceAcceptanceDb
 const fresh=nativeDb({exists:false});await read(fresh.factory,spec);assert.deepEqual(fresh.calls,["list"])
 const existing=nativeDb();await read(existing.factory,spec);assert.deepEqual(existing.calls[1],["quire-p4-resource-acceptance",undefined]);assert.deepEqual(existing.calls[2],["meta","readonly"]);assert.equal(existing.stats().closed,1)
})
for(const options of [{badMarker:true},{version:20},{upgrade:true},{blocked:true}])test(`resource native preflight refuses ${JSON.stringify(options)}`,async()=>{
 const h=nativeDb(options),read=loadTS("resource-acceptance/preflight.ts").preflightResourceAcceptanceDb;await assert.rejects(read(h.factory,spec));if(options.upgrade)assert.equal(h.stats().aborted,1)
})
for(const mode of ["token","deactivate"])test(`identity ${mode} during paused proof cannot resume to import`,async()=>{
 const h=harness();await h.seed();const gate=deferred(),session=h.runtime.createResourceAcceptanceSession(spec,p=>{if(p)gate.resolve()})
 try{session.pauseNext("proof");const pending=session.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID],h.file());await gate.promise
 const before=all(h);if(mode==="token")h.token("real credential");else h.identity.deactivateResourceIdentity();session.release()
 assert.equal((await pending).ready,false);assert.equal(all(h),before)}finally{session.close()}
})
