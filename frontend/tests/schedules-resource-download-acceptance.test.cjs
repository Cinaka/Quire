const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm")
const {setup}=require("./schedules-data-harness.cjs"),{loadTS}=require("./schedules-harness.cjs")
const spec={enabled:true,dailyOrigin:"http://localhost:5173",testOrigin:"http://127.0.0.1:5182"}
const location=()=>({origin:spec.testOrigin,pathname:"/p4-resource-download-acceptance.html"})
const plain=value=>JSON.parse(JSON.stringify(value)),all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
function harness(enabled=true){let token="";const win={location:location()},storage={getItem:()=>token}
 const h=setup({}, {URL,window:win,localStorage:storage,crypto:crypto.webcrypto,AbortController,__QUIRE_P4_RESOURCE_DOWNLOAD_ACCEPTANCE__:enabled})
 h.identity=h.load("resource-download-acceptance/identity.ts");h.mocks["./identity"]={...h.identity,RESOURCE_DEMO_OWNER:h.identity.DOWNLOAD_DEMO_OWNER}
 const tokens={accessTokenSubject:h.identity.downloadAccessTokenSubject,tokenGeneration:h.identity.downloadTokenGeneration,getAccessToken:h.identity.downloadGetAccessToken}
 h.mocks["@/api/tokenStore"]=tokens;h.mocks["./tokenStore"]=tokens
 h.barrier=h.load("resource-download-acceptance/barrier.ts");h.mocks["./barrier"]=h.barrier
 h.mocks["./schema"].waitForScheduleResourceBytes=h.barrier.waitForDownloadAcceptanceTransaction
 h.mocks["@/db/schema"].waitForScheduleResourceBytes=h.barrier.waitForDownloadAcceptanceTransaction
 h.guard=h.load("resource-download-acceptance/guard.ts");h.db.name=h.guard.DOWNLOAD_ACCEPTANCE_DB_NAME
 h.model=h.load("resource-acceptance/model.ts");h.runtime=h.load("resource-download-acceptance/runtime.ts")
 h.window=win;h.token=value=>{token=value};h.activate=()=>h.identity.activateDownloadIdentity(spec)
 h.seed=async()=>{h.activate();await h.runtime.initializeDownloadAcceptance(spec);await h.runtime.seedDownloadAcceptance(spec)}
 h.file=()=>{const text=h.model.resourceFixtureMaterial();return{name:"fixture.json",size:new Blob([text]).size,text:async()=>text}}
 return h
}

test("download gate accepts only the dedicated 5182 origin/path and never the old stores",()=>{
 const h=harness();assert.deepEqual(plain(h.guard.assertDownloadAcceptanceLocation(spec,location())),spec)
 for(const bad of [{...spec,enabled:false},{...spec,dailyOrigin:spec.testOrigin},{...spec,testOrigin:"http://127.0.0.1:5181"},{...spec,testOrigin:"https://real.example"},{...spec,dailyOrigin:"http://u:p@localhost:5173"}])assert.throws(()=>h.guard.assertDownloadAcceptanceLocation(bad,location()))
 for(const loc of [{...location(),origin:spec.dailyOrigin},{...location(),origin:"http://127.0.0.1:5181"},{...location(),pathname:"/p4-resource-acceptance.html"}])assert.throws(()=>h.guard.assertDownloadAcceptanceLocation(spec,loc))
 assert.equal(h.db.name,"quire-p4-resource-download-acceptance");assert.notEqual(h.db.name,"quire-p4-resource-acceptance")
})
for(const mode of ["inactive","normal-build","token","daily","wrong-db"])test(`download identity ${mode} refuses before initialization writes`,async()=>{
 const h=harness(mode!=="normal-build"),before=all(h)
 if(!["inactive","normal-build"].includes(mode))h.activate();if(mode==="normal-build")assert.throws(()=>h.activate())
 if(mode==="token")h.token("real-token");if(mode==="daily")h.window.location.origin=spec.dailyOrigin;if(mode==="wrong-db")h.db.name="quire-p4-resource-acceptance"
 await assert.rejects(h.runtime.initializeDownloadAcceptance(spec));assert.equal(all(h),before)
})
test("initialization writes only a marker; no automatic fixture, download or credentials",async()=>{
 const h=harness();h.activate();await h.runtime.initializeDownloadAcceptance(spec)
 assert.equal(h.stores.meta.rows.size,1);assert.equal(h.stores.entries.rows.size,0);assert.equal(h.identity.downloadGetAccessToken(),"")
 const before=all(h);await h.runtime.initializeDownloadAcceptance(spec);assert.equal(all(h),before)
})
for(const mode of ["entry","unknown-meta","wrong-marker"])test(`unknown download-store ${mode} is not claimed or cleared`,async()=>{
 const h=harness();h.activate()
 if(mode==="entry")await h.db.entries.put({id:"private"});if(mode==="unknown-meta")await h.db.meta.put({key:"private",value:"keep"});if(mode==="wrong-marker")await h.db.meta.put({key:h.guard.DOWNLOAD_ACCEPTANCE_MARKER,value:{unknown:true}})
 const before=all(h);await assert.rejects(h.runtime.initializeDownloadAcceptance(spec));assert.equal(all(h),before)
})
test("one explicit atomic seed has missing media, one intention and one candidate",async()=>{
 const h=harness();await h.seed();const state=await h.runtime.inspectDownloadAcceptance(spec)
 assert.deepEqual(plain(state),{sourceCount:1,entryCount:1,intentionCount:1,candidateCount:1,mediaRows:0,archiveCount:0,originalMatches:false,thumbnailMatches:false,mode:"simulated_download_real_local_write"})
 const before=all(h);await assert.rejects(h.runtime.seedDownloadAcceptance(spec));assert.equal(all(h),before)
 assert.equal(h.model.resourceFixtureRows().intention.ownerUserId,h.identity.DOWNLOAD_DEMO_OWNER)
})
for(const table of ["entries","schedules","meta"])test(`seed ${table} failure leaves only the original marker`,async()=>{
 const h=harness();h.activate();await h.runtime.initializeDownloadAcceptance(spec);const before=all(h);h.failNext(table)
 await assert.rejects(h.runtime.seedDownloadAcceptance(spec));assert.equal(all(h),before)
})
test("concurrent seeds create exactly one fixture and never append copies",async()=>{
 const h=harness();h.activate();await h.runtime.initializeDownloadAcceptance(spec)
 const results=await Promise.allSettled([h.runtime.seedDownloadAcceptance(spec),h.runtime.seedDownloadAcceptance(spec)])
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(h.stores.entries.rows.size,1)
})
test("simulated byte responses drive real controller and panel, prepare is read-only, refresh retains protection",async()=>{
 const h=harness();await h.seed();const session=h.runtime.createDownloadAcceptanceSession(spec,()=>{})
 const panel=h.load("shared/scheduleResourceDownloadPanel.ts").createScheduleResourceDownloadPanel(session.port,h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID])
 try{
  const before=all(h);panel.select([h.model.RESOURCE_MEDIA_ID]);assert.equal(await panel.prepare(),true);assert.equal(all(h),before)
  assert.equal(await panel.apply(),false);panel.confirm(true);assert.equal(await panel.apply(),true)
  const saved=await h.runtime.inspectDownloadAcceptance(spec);assert.equal(saved.mediaRows,1);assert.equal(saved.archiveCount,1);assert.equal(saved.originalMatches,true);assert.equal(saved.thumbnailMatches,true)
  assert.equal(saved.intentionCount,1);assert.equal(saved.candidateCount,1)
  session.close();h.identity.deactivateDownloadIdentity();h.activate();assert.deepEqual(plain(await h.runtime.inspectDownloadAcceptance(spec)),plain(saved))
  const next=h.runtime.createDownloadAcceptanceSession(spec,()=>{});try{const snap=all(h);assert.equal((await next.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID])).ready,false);assert.equal(all(h),snap)}finally{next.close()}
 }finally{panel.dispose();session.close()}
})
for(const point of ["proof","image"])for(const action of ["cancel","close","token","deactivate"])test(`${action} at paused ${point} cannot leave partial downloaded bytes`,async()=>{
 const h=harness();await h.seed();const gate=deferred(),session=h.runtime.createDownloadAcceptanceSession(spec,p=>{if(p)gate.resolve()})
 try{session.pauseNext(point);const before=all(h),pending=session.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID]);await gate.promise
  if(action==="cancel")session.port.cancel();if(action==="close")session.close();if(action==="token")h.token("real credential");if(action==="deactivate")h.identity.deactivateDownloadIdentity()
  session.release();assert.equal((await pending).ready,false);assert.equal(all(h),before)
 }finally{session.close()}
})
for(const action of ["cancel","close","release"])test(`write transaction ${action} preserves atomic cloud repair semantics`,async()=>{
 const h=harness();await h.seed();const gate=deferred(),session=h.runtime.createDownloadAcceptanceSession(spec,p=>{if(p)gate.resolve()})
 try{const r=await session.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID]);assert.equal(r.ready,true);const before=all(h)
  assert.equal(session.pauseNext("transaction"),true);const pending=session.port.repair(r.reviewId,true);await gate.promise
  if(action==="cancel")session.port.cancel();else if(action==="close")session.close();else session.release()
  assert.equal((await pending).repaired,action==="release");if(action!=="release")assert.equal(all(h),before)
  else assert.equal((await h.runtime.inspectDownloadAcceptance(spec)).archiveCount,1)
 }finally{session.close()}
})
for(const table of ["media","meta"])test(`download write ${table} failure rolls back bytes and audit together`,async()=>{
 const h=harness();await h.seed();const session=h.runtime.createDownloadAcceptanceSession(spec,()=>{})
 try{const r=await session.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID]),before=all(h);h.failNext(table)
 assert.equal((await session.port.repair(r.reviewId,true)).repaired,false);assert.equal(all(h),before)}finally{session.close()}
})
for(const mode of ["source","entry","owner","extra-meta","media-bytes","archive-origin","archive-before","archive-proof","archive-unknown","archive-ids","duplicate-audit"])test(`strict refresh rejects changed ${mode}, never repairs or adopts it`,async()=>{
 const h=harness();await h.seed();const session=h.runtime.createDownloadAcceptanceSession(spec,()=>{})
 try{const r=await session.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID]);assert.equal((await session.port.repair(r.reviewId,true)).repaired,true)}finally{session.close()}
 if(["source","entry"].includes(mode)){const table=mode==="source"?h.db.schedules:h.db.entries,row=await table.get(h.model.RESOURCE_SOURCE_ID);row.title="changed";await table.put(row)}
 if(mode==="owner")await h.db.meta.put({key:"ownerUserId",value:"other"});if(mode==="extra-meta")await h.db.meta.put({key:"private",value:"keep"})
 if(mode==="media-bytes"){const row=await h.db.media.get(h.model.RESOURCE_MEDIA_ID);row.blob=new Blob([new Uint8Array(68)],{type:"image/png"});await h.db.media.put(row)}
 if(mode.startsWith("archive-")||mode==="duplicate-audit"){const a=(await h.db.meta.get("scheduleResourceRepairs")).value
  if(mode==="archive-origin")a[0].materialOrigin="file";if(mode==="archive-before")a[0].before.state.entry.title="changed";if(mode==="archive-proof")a[0].cloud.media[0].original.sha256="0".repeat(64);if(mode==="archive-unknown")a[0].future=true;if(mode==="archive-ids")a[0].downloadedMediaIds=[];if(mode==="duplicate-audit")a.push(structuredClone(a[0]));await h.db.meta.put({key:"scheduleResourceRepairs",value:a})}
 const before=all(h);await assert.rejects(h.runtime.inspectDownloadAcceptance(spec));assert.equal(all(h),before)
})
test("wrapper cancellation during preflight starts no late download",async()=>{
 const h=harness();await h.seed();const session=h.runtime.createDownloadAcceptanceSession(spec,()=>{}),before=all(h)
 const pending=session.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID]);session.port.cancel()
 try{assert.equal((await pending).ready,false);assert.equal(all(h),before)}finally{session.close()}
})
test("download barrier owns an exclusive hook and releasing dispose cannot affect the old host hook",async()=>{
 const h=harness(),barrier=h.barrier.createDownloadAcceptanceBarrier(()=>{});assert.throws(()=>h.barrier.createDownloadAcceptanceBarrier(()=>{}))
 barrier.arm("image");const pending=barrier.wait("image");barrier.dispose();await pending
 const next=h.barrier.createDownloadAcceptanceBarrier(()=>{});next.dispose();assert.equal(await h.barrier.waitForDownloadAcceptanceTransaction(Promise.resolve(2)),2)
})
function config(daily=spec.dailyOrigin){let source=fs.readFileSync(path.join(__dirname,"../vite.p4-resource-download-acceptance.config.ts"),"utf8")
 source=require("node:module").stripTypeScriptTypes(source).replace(/^import .*$/gm,"").replaceAll("import.meta.url",JSON.stringify(`file://${path.resolve(__dirname,"../vite.p4-resource-download-acceptance.config.ts")}`)).replace("export default","globalThis.result =")
 const context={URL,fileURLToPath:require("node:url").fileURLToPath,vue:()=>({}),tailwindcss:()=>({}),defineConfig:fn=>fn(),process:{env:{P4_RESOURCE_DOWNLOAD_DAILY_ORIGIN:daily}}}
 vm.runInNewContext(source,context);return context.result
}
test("dedicated config fails closed and injects only its own DB, demo identity and transaction hook",()=>{
 assert.throws(()=>config(""));assert.throws(()=>config(spec.testOrigin))
 const cfg=config(),plugin=cfg.plugins[2],schema=fs.readFileSync(path.join(__dirname,"../src/db/schema.ts"),"utf8")
 const transformed=plugin.transform(schema,"/project/src/db/schema.ts?v=1");assert.match(transformed,/new QuireDb\("quire-p4-resource-download-acceptance"\)/);assert.match(transformed,/waitForDownloadAcceptanceTransaction\(promise\)/)
 assert.throws(()=>plugin.transform(schema.replace("export const db = new QuireDb()","changed"),"/src/db/schema.ts"))
 assert.throws(()=>plugin.transform(schema.replace("return Dexie.waitFor(promise, 10000)","changed"),"/src/db/schema.ts"))
 assert.match(plugin.transform("private-token-code","/project/src/api/tokenStore.ts"),/downloadAccessTokenSubject/)
 assert.equal(plugin.transform("keep","/project/src/shared/types.ts"),undefined);assert.equal(cfg.server.port,5182);assert.equal(cfg.server.strictPort,true);assert.equal(cfg.server.proxy,undefined)
 assert.match(cfg.server.headers["Content-Security-Policy"],/connect-src 'self' ws:\/\/127.0.0.1:5182/)
})
test("server blocks default/old HTML, main, API, media, request adapter and wrong host",()=>{
 let middleware;config().plugins[2].configureServer({middlewares:{use(fn){middleware=fn}}})
 for(const url of ["/index.html","/p4-acceptance.html","/src/main.ts","/api/v1/schedules","/media/image","/src/api/request.ts"]){const response={end(){}};let next=false;middleware({url,headers:{host:"127.0.0.1:5182"}},response,()=>{next=true});assert.equal(response.statusCode,403);assert.equal(next,false)}
 const response={end(){}};middleware({url:"/p4-resource-download-acceptance.html",headers:{host:"localhost:5182"}},response,()=>{});assert.equal(response.statusCode,403)
 let next=false;middleware({url:"/p4-resource-download-acceptance.html",headers:{host:"127.0.0.1:5182"}},{end(){}},()=>{next=true});assert.equal(next,true)
})
test("entry checks native preflight before dynamic business import; page never seeds/mounts a panel automatically",()=>{
 const read=file=>fs.readFileSync(path.join(__dirname,"../src/resource-download-acceptance",file),"utf8"),entry=read("entry.ts"),page=read("DownloadAcceptancePage.vue")
 assert.ok(entry.indexOf("await preflightDownloadAcceptanceDb")<entry.indexOf('await import("./mount")'));assert.match(entry,/confirmed\?\.checked/);assert.match(entry,/quire_access_token/)
 assert.doesNotMatch(entry,/from "vue"|import .*@\/db/);assert.match(page,/v-if="session"/);assert.match(page,/模拟云端证明/);assert.match(page,/最多10秒/)
 assert.doesNotMatch(page,/onMounted|deleteDatabase|db\.[\w.]*clear\(/);assert.doesNotMatch(read("runtime.ts"),/fetch\(|axios|createScheduleCloudResourceTransport|\.clear\(|\.delete\(/)
 assert.doesNotMatch(read("identity.ts"),/setItem|removeItem|addEventListener/)
 const script=page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];assert.doesNotThrow(()=>require("node:module").stripTypeScriptTypes(script))
})
function nativeDb({exists=true,version=30,badMarker=false,upgrade=false,blocked=false}={}){
 const h=harness(),calls=[];let closed=0,aborted=0
 const factory={async databases(){calls.push("list");return exists?[{name:h.guard.DOWNLOAD_ACCEPTANCE_DB_NAME}]:[]},open(name,requestedVersion){calls.push([name,requestedVersion]);const request={transaction:{abort(){aborted++}}}
 queueMicrotask(()=>{if(upgrade){request.onupgradeneeded();return}if(blocked){request.onblocked();return}
 request.result={version,objectStoreNames:{contains:name=>name==="meta"},close(){closed++},transaction(name,mode){calls.push([name,mode]);const tx={objectStore(){return{get(key){calls.push(key);const read={};queueMicrotask(()=>{read.result={value:badMarker?{kind:"quire-p4-acceptance/v1"}:h.guard.downloadAcceptanceMarker(spec)};read.onsuccess();tx.oncomplete()});return read}}}};return tx}};request.onsuccess()});return request}}
 return{factory,calls,stats:()=>({closed,aborted})}
}
test("resource native preflight lists first and only reads registered v3 without upgrade/version or data writes",async()=>{
 const read=loadTS("resource-download-acceptance/preflight.ts").preflightDownloadAcceptanceDb
 const fresh=nativeDb({exists:false});await read(fresh.factory,spec);assert.deepEqual(fresh.calls,["list"])
 const existing=nativeDb();await read(existing.factory,spec);assert.deepEqual(existing.calls[1],["quire-p4-resource-download-acceptance",undefined]);assert.deepEqual(existing.calls[2],["meta","readonly"]);assert.equal(existing.stats().closed,1)
})
for(const options of [{badMarker:true},{version:20},{upgrade:true},{blocked:true}])test(`resource native preflight refuses ${JSON.stringify(options)}`,async()=>{
 const h=nativeDb(options),read=loadTS("resource-download-acceptance/preflight.ts").preflightDownloadAcceptanceDb;await assert.rejects(read(h.factory,spec));if(options.upgrade)assert.equal(h.stats().aborted,1)
})
