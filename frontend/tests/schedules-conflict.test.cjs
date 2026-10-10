const {test}=require("node:test"),assert=require("node:assert/strict")
const fs=require("node:fs"),path=require("node:path")
const {ID,OTHER_ID,AT,content,schedule,entry,terminal,intent,setup}=require("./schedules-data-harness.cjs")
const {networkHarness}=require("./schedules-network-harness.cjs")
const SERVER="2026-10-08T10:00:02.000Z",REMOTE="2026-10-08T10:00:01.000Z"
const ARCHIVE="scheduleConflictArchive",PREFIX="scheduleServerState:"
function wire(row){return {id:row.id,remind_date:row.remindDate,title:row.title,content:row.content,content_text:row.contentText,
  status:row.status,converted_entry_id:row.convertedEntryId,converted_at:row.convertedAt,client_updated_at:row.clientUpdatedAt,
  deleted_at:row.deletedAt,created_at:row.createdAt,updated_at:row.serverUpdatedAt}}
const all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
const conflicts=async h=>(await h.db.meta.get("scheduleConflicts"))?.value??[]
async function harness(options={}){
  const h=setup(),calls=[],exports=[];h.mocks["@/api/tokenStore"]=h.tokens
  const local=schedule({title:"本机文字"}),cloud=schedule({title:"云端文字",content:content("云端正文"),contentText:"云端正文",clientUpdatedAt:REMOTE,serverUpdatedAt:SERVER,updatedAt:SERVER,dirty:0,...options.cloud})
  h.local=local;h.cloud=cloud
  await h.db.meta.put({key:"ownerUserId",value:"account-a"});await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
  await h.db.schedules.put(local)
  const candidates=[{scheduleId:ID,kind:"schedule-push",reason:"stale",submitted:local,expectedServerRevision:null,serverSchedule:cloud},
    {scheduleId:ID,kind:"schedule-pull-conflict",reason:"dirty_conflict",localSchedule:local,serverSchedule:cloud},
    {scheduleId:OTHER_ID,kind:"old-other",keep:"unchanged"}]
  await h.db.meta.put({key:"scheduleConflicts",value:candidates})
  const transport={async detail(id,lease){calls.push({id,lease:structuredClone(lease)});if(options.duringGet)await options.duringGet(h,calls.length)
    if(options.getFail)throw new Error("private SQL/token");return wire(options.remote??cloud)}}
  const resolver=h.load("db/scheduleConflictRepo.ts").createInternalScheduleConflictResolver(transport)
  const preserve=async evidence=>{exports.push(structuredClone(evidence));if(options.duringExport)await options.duringExport(h);if(options.exportFail)throw new Error("download failed")}
  return {...h,local,cloud,candidates,calls,exports,preserve,resolver,options,transport}
}
test("review is read only and exposes explicit pending choices with full source versions",async()=>{
  const h=await harness(),before=all(h),r=await h.resolver.review(ID)
  assert.equal(r.ready,true);assert.equal(JSON.stringify(r.choices),JSON.stringify(["keep-local","use-cloud"]))
  assert.equal(r.local.title,"本机文字");assert.equal(r.server.title,"云端文字");assert.equal(r.candidates.length,2)
  assert.equal(h.calls.length,1);assert.equal(all(h),before)
})
for(const choice of ["keep-local","use-cloud"]){
  test(`${choice} exports all versions before atomically adopting and archiving only its target`,async()=>{
    const h=await harness();await h.db.entries.put(entry({id:OTHER_ID,fromScheduleId:undefined}))
    await h.db.meta.put({key:"lastSyncAt",value:"P2-kept"});await h.db.meta.put({key:"scheduleLastSyncAt",value:"unchanged cursor"})
    const entries=JSON.stringify(await h.db.entries.toArray()),r=await h.resolver.review(ID)
    h.options.duringExport=async h=>{assert.equal((await conflicts(h)).length,3);assert.equal((await h.db.schedules.get(ID)).title,"本机文字");assert.equal(await h.db.meta.get(ARCHIVE),undefined)}
    assert.equal((await h.resolver.resolve(r.reviewId,choice,true,h.preserve)).applied,true)
    const current=await h.db.schedules.get(ID),e=h.exports[0]
    assert.equal(current.title,choice==="keep-local"?"本机文字":"云端文字");assert.equal(current.dirty,choice==="keep-local"?1:0)
    if(choice==="keep-local"){assert.ok(current.clientUpdatedAt>REMOTE);assert.equal(current.createdAt,AT)}
    assert.equal(e.local.title,"本机文字");assert.equal(e.server.title,"云端文字");assert.equal(e.candidates.length,2)
    const text=JSON.stringify(e);for(const forbidden of ["ownerUserId","tokenGeneration","generation","Bearer"])assert.equal(text.includes(forbidden),false)
    assert.equal((await conflicts(h)).length,1);assert.equal((await conflicts(h))[0].scheduleId,OTHER_ID)
    const archive=(await h.db.meta.get(ARCHIVE)).value;assert.equal(archive.length,1);assert.equal(archive[0].choice,choice)
    assert.equal((await h.db.meta.get(PREFIX+ID)).value.source.clientUpdatedAt,REMOTE)
    assert.equal(JSON.stringify(await h.db.entries.toArray()),entries);assert.equal((await h.db.meta.get("lastSyncAt")).value,"P2-kept")
    assert.equal((await h.db.meta.get("scheduleLastSyncAt")).value,"unchanged cursor");assert.equal(h.calls.length,2)
  })
}
for(const invalid of ["no-confirm","no-export","unknown-choice","wrong-review"]){
  test(`${invalid} cannot write or silently choose a version`,async()=>{
    const h=await harness(),r=await h.resolver.review(ID),before=all(h)
    const result=await h.resolver.resolve(invalid==="wrong-review"?r.reviewId+1:r.reviewId,invalid==="unknown-choice"?"automatic":"use-cloud",invalid!=="no-confirm",invalid==="no-export"?undefined:h.preserve)
    assert.equal(result.applied,false);assert.equal(h.exports.length,0);assert.equal(all(h),before);assert.equal(h.calls.length,1)
  })
}
for(const mode of ["export-failed","changed-local","changed-candidate","new-intent","new-draft","new-linked","owner","epoch","relogin"]){
  test(`export boundary ${mode} preserves conflicts and original business state`,async()=>{
    const h=await harness({exportFail:mode==="export-failed",duringExport:async h=>{
      if(mode==="changed-local")await h.db.schedules.put({...h.local,title:"new local"})
      if(mode==="changed-candidate"){const rows=await conflicts(h);rows.push({...rows[0],reason:"conflict"});await h.db.meta.put({key:"scheduleConflicts",value:rows})}
      if(mode==="new-intent")await h.db.meta.put({key:"scheduleConversions",value:[intent({ownerUserId:"account-a"})]})
      if(mode==="new-draft")await h.db.meta.put({key:"scheduleDraft",value:{unsaved:"keep"}})
      if(mode==="new-linked")await h.db.entries.put(entry())
      if(mode==="owner")h.user("account-b")
      if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restored"})
      if(mode==="relogin"){h.user("account-b");h.user("account-a")}
    }})
    const r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).applied,false)
    assert.equal(await h.db.meta.get(ARCHIVE),undefined);assert.equal(await h.db.meta.get(PREFIX+ID),undefined)
    assert.equal((await h.db.schedules.get(ID)).title,mode==="changed-local"?"new local":"本机文字")
    assert.ok((await conflicts(h)).length>=3)
  })
}
for(const table of ["schedules","meta"]){
  test(`${table} resolution write failure rolls back archive, proof, source and candidate removal`,async()=>{
    const h=await harness({duringExport:async h=>h.failNext(table)}),r=await h.resolver.review(ID),before=all(h)
    assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).applied,false)
    assert.equal(h.exports.length,1);assert.equal(all(h),before)
  })
}
test("failure removing the active conflict cannot leave an adopted source without its evidence",async()=>{
  const h=await harness(),r=await h.resolver.review(ID),before=all(h),put=h.db.meta.put
  h.db.meta.put=async row=>{if(row.key==="scheduleConflicts")throw new Error("conflict removal failed");return put(row)}
  assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).applied,false);assert.equal(all(h),before)
})
for(const mode of ["local-terminal","server-terminal","queue","linked-entry","draft","unknown-local","too-new","unknown-report","history-terminal"]){
  test(`${mode} review is protected read-only and cannot clear conversion identities`,async()=>{
    const h=await harness()
    if(mode==="local-terminal")await h.db.schedules.put(terminal())
    if(mode==="server-terminal")h.options.remote=terminal({dirty:0,serverUpdatedAt:SERVER})
    if(mode==="queue")await h.db.meta.put({key:"scheduleConversions",value:[intent({ownerUserId:"account-a"})]})
    if(mode==="linked-entry")await h.db.entries.put(entry())
    if(mode==="draft")await h.db.meta.put({key:"scheduleDraft",value:{unsaved:"keep"}})
    if(mode==="unknown-local")await h.db.schedules.put({...h.local,futureField:{keep:true}})
    if(mode==="too-new")await h.db.schedules.put({...h.local,content:{schemaVersion:999,doc:{type:"doc",content:[]}}})
    if(mode==="unknown-report"){const rows=await conflicts(h);rows[0].secret="must not export";await h.db.meta.put({key:"scheduleConflicts",value:rows})}
    if(mode==="history-terminal"){const rows=await conflicts(h);rows[0].serverSchedule=terminal();await h.db.meta.put({key:"scheduleConflicts",value:rows})}
    const before=all(h),r=await h.resolver.review(ID);assert.equal(r.ready,true);assert.equal(r.choices.length,0)
    assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).applied,false)
    assert.equal(h.exports.length,0);assert.equal(all(h),before)
  })
}
test("reviewed server changing before confirmation requires reopening without export or write",async()=>{
  const h=await harness(),r=await h.resolver.review(ID),before=all(h)
  h.options.remote={...h.cloud,title:"new remote",clientUpdatedAt:SERVER}
  assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).reason,"server_changed_reopen")
  assert.equal(h.exports.length,0);assert.equal(all(h),before)
  assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).applied,false)
})
test("stale review after local edit rejects before second request",async()=>{
  const h=await harness(),r=await h.resolver.review(ID);await h.db.schedules.put({...h.local,title:"new"})
  assert.equal((await h.resolver.resolve(r.reviewId,"keep-local",true,h.preserve)).applied,false);assert.equal(h.calls.length,1)
})
test("repeated resolve cannot archive or adopt twice",async()=>{
  const h=await harness(),r=await h.resolver.review(ID)
  assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).applied,true)
  assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).applied,false)
  assert.equal((await h.db.meta.get(ARCHIVE)).value.length,1);assert.equal(h.exports.length,1)
})
test("known newer proof and malformed archive cannot be bypassed by explicit choice",async()=>{
  const h=await harness();await h.db.meta.put({key:PREFIX+ID,value:{ownerUserId:"account-a",generation:"epoch",source:{...h.cloud,serverUpdatedAt:"2026-10-08T10:00:03.000Z",updatedAt:"2026-10-08T10:00:03.000Z"}}})
  let r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).applied,false)
  assert.equal((await h.db.schedules.get(ID)).title,"本机文字")
  await h.db.meta.put({key:ARCHIVE,value:"keep malformed"});r=await h.resolver.review(ID);assert.equal(r.ready,false)
  assert.equal((await h.db.meta.get(ARCHIVE)).value,"keep malformed")
})
test("cloud soft deletion or restoration is a source choice, not diary deletion or conversion",async()=>{
  for(const deleted of [true,false]){const h=await harness({cloud:{isDeleted:deleted?1:0,deletedAt:deleted?REMOTE:null}}),r=await h.resolver.review(ID)
    assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).applied,true)
    assert.equal((await h.db.schedules.get(ID)).isDeleted,deleted?1:0);assert.equal(h.stores.entries.rows.size,0);assert.equal((await h.db.schedules.get(ID)).status,"pending")}
})
test("same instance protects review/resolve single-flight during export",async()=>{
  let release;const gate=new Promise(r=>release=r);const h=await harness({duringExport:()=>gate}),r=await h.resolver.review(ID)
  const first=h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve);await new Promise(r=>setTimeout(r,20))
  assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).reason,"busy")
  assert.equal((await h.resolver.review(OTHER_ID)).reason,"busy");release();assert.equal((await first).applied,true)
})
test("detail read failures and bad IDs never discard candidates or expose raw errors",async()=>{
  const h=await harness({getFail:true}),before=all(h);assert.equal((await h.resolver.review(ID)).ready,false)
  assert.equal(all(h),before);assert.equal((await h.resolver.review("bad")).ready,false);assert.equal(h.calls.length,1)
})
test("real detail GET adapter pins original account and rejects injected IDs",async()=>{
  const h=await harness(),net=networkHarness(()=>({status:200,data:{code:0,data:wire(h.cloud)}}))
  h.mocks["./request"]=net.api;h.mocks["./tokenStore"]=net.tokens;h.mocks["@/api/tokenStore"]=net.tokens
  const transport=h.load("api/scheduleConflictTransport.ts").createScheduleConflictTransport()
  const resolver=h.load("db/scheduleConflictRepo.ts").createInternalScheduleConflictResolver(transport)
  assert.equal((await resolver.review(ID)).ready,true);assert.equal(net.calls[0].url,`/schedules/${ID}`)
  assert.equal(net.calls[0]._tokenGeneration,0)
  await assert.rejects(net.api.getPinnedScheduleDetail(`${ID}?other`,{ownerUserId:"account-a",tokenGeneration:0}))
  assert.equal(net.calls.length,1)
})
test("conflict resolver is not mounted or automatically run by sync",()=>{
  for(const file of ["repo/index.ts","api/sync.ts","router/index.ts","db/scheduleSyncRepo.ts"]){const text=fs.readFileSync(path.join(__dirname,"../src",file),"utf8");assert.equal(text.includes("createInternalScheduleConflictResolver"),false)}
})
test("two independent resolvers cannot resolve the same captured source twice",async()=>{
  const h=await harness(),second=h.load("db/scheduleConflictRepo.ts").createInternalScheduleConflictResolver(h.transport)
  const a=await h.resolver.review(ID),b=await second.review(ID)
  assert.equal((await h.resolver.resolve(a.reviewId,"use-cloud",true,h.preserve)).applied,true)
  assert.equal((await second.resolve(b.reviewId,"keep-local",true,h.preserve)).applied,false)
  assert.equal((await h.db.meta.get(ARCHIVE)).value.length,1)
})
test("same cloud watermark with contradictory proof prevents both choices",async()=>{
  const h=await harness();await h.db.meta.put({key:PREFIX+ID,value:{ownerUserId:"account-a",generation:"epoch",source:{...h.cloud,title:"contradictory proof"}}})
  const r=await h.resolver.review(ID),before=all(h)
  assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).applied,false);assert.equal(all(h),before)
})
test("prior archives remain untouched and file evidence remains a separate, owner-free format",async()=>{
  const h=await harness(),older={scheduleId:OTHER_ID,kind:"old-proof",ownerUserId:"old-owner",generation:"old-epoch",evidence:{keep:true}}
  await h.db.meta.put({key:ARCHIVE,value:[older]});const r=await h.resolver.review(ID)
  assert.equal((await h.resolver.resolve(r.reviewId,"keep-local",true,h.preserve)).applied,true)
  const archives=(await h.db.meta.get(ARCHIVE)).value;assert.equal(archives.length,2);assert.equal(JSON.stringify(archives[0]),JSON.stringify(older))
  assert.equal(h.exports[0].format,"schedule-conflict-evidence");assert.equal(h.exports[0].formatVersion,1)
})
test("account switching during live detail read cannot produce an actionable ticket",async()=>{
  const h=await harness({duringGet:async h=>h.user("account-b")}),before=all(h)
  assert.equal((await h.resolver.review(ID)).ready,false);assert.equal(all(h),before)
})
test("preserved evidence mutation by callback cannot change the internal choice or archive",async()=>{
  const h=await harness(),r=await h.resolver.review(ID)
  const result=await h.resolver.resolve(r.reviewId,"use-cloud",true,async evidence=>{evidence.server.title="tampered";evidence.local.title="tampered"})
  assert.equal(result.applied,true);assert.equal((await h.db.schedules.get(ID)).title,"云端文字")
  assert.equal((await h.db.meta.get(ARCHIVE)).value[0].evidence.local.title,"本机文字")
})
test("unsafe candidate metadata does not enter a portable export",async()=>{
  const h=await harness(),rows=await conflicts(h);rows[0].reason="private Bearer token";await h.db.meta.put({key:"scheduleConflicts",value:rows})
  const r=await h.resolver.review(ID);assert.equal(r.choices.length,0)
  assert.equal((await h.resolver.resolve(r.reviewId,"use-cloud",true,h.preserve)).applied,false);assert.equal(h.exports.length,0)
})
