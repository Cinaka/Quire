const {test}=require("node:test"),assert=require("node:assert/strict")
const fs=require("node:fs"),path=require("node:path")
const {ID,OTHER_ID,AT,content,schedule,terminal,entry,intent,setup}=require("./schedules-data-harness.cjs")
const SERVER="2026-10-08T10:00:02.000Z",LATER="2026-10-08T10:00:01.123456Z"
const KEEP="cloud-source-keep-diary",CLOUD="cloud-source-use-diary",ARCHIVE="scheduleConflictArchive",PREFIX="scheduleServerState:"
function sourceWire(row){return {id:row.id,remind_date:row.remindDate,title:row.title,content:row.content,content_text:row.contentText,status:row.status,
  converted_entry_id:row.convertedEntryId,converted_at:row.convertedAt,client_updated_at:row.clientUpdatedAt,deleted_at:row.deletedAt,created_at:row.createdAt,updated_at:SERVER}}
function entryWire(row){return {id:row.id,from_schedule_id:row.fromScheduleId,entry_date:row.entryDate,sort_order:row.sortOrder,title:row.title,
  content:row.content,content_text:row.contentText,mood:row.mood,weather:row.weather,tag_ids:row.tagIds,client_updated_at:row.clientUpdatedAt,
  deleted_at:row.deletedAt,created_at:row.createdAt,updated_at:SERVER}}
const all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
const queue=async h=>(await h.db.meta.get("scheduleConversions"))?.value??[]
const conflicts=async h=>(await h.db.meta.get("scheduleConflicts"))?.value??[]
async function harness(options={}){
  const h=setup(),calls=[],exports=[];h.mocks["@/api/tokenStore"]=h.tokens
  const source=terminal({title:"本机首次",content:content("本机首次正文")}),local=entry({title:"本机后来编辑",content:content("本机后来正文"),clientUpdatedAt:AT})
  const remoteSource=terminal({title:"另一设备首次",content:content("另一设备首次正文"),serverUpdatedAt:SERVER,updatedAt:SERVER,dirty:0})
  const remoteEntry=entry({title:"云端后来编辑",content:content("云端后来正文"),clientUpdatedAt:LATER,serverUpdatedAt:SERVER,updatedAt:SERVER,dirty:0})
  const first=intent({ownerUserId:"account-a",source:schedule({title:"本机首次",content:content("本机首次正文")}),entry:entry({title:"本机首次",content:content("本机首次正文")})})
  const reply={read_only:true,reviewable:true,reason:"terminal_review",receipt_known:true,first_entry_date:"2026-10-07",first_entry_deleted:false,
    schedule:sourceWire(remoteSource),entry:entryWire(remoteEntry),entry_state:"active"}
  Object.assign(h,{source,local,remoteSource,remoteEntry,first,reply,calls,exports})
  await h.db.meta.put({key:"ownerUserId",value:"account-a"});await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
  await h.db.schedules.put(source);await h.db.entries.put(local);await h.db.meta.put({key:"scheduleConversions",value:[first]})
  await h.db.meta.put({key:"scheduleConflicts",value:[{scheduleId:ID,kind:"conversion-entry",localEntry:local,serverEntry:remoteEntry},
    {scheduleId:ID,kind:"conversion-ack",reason:"server_entry_changed",firstIntent:first,serverSchedule:remoteSource,serverEntry:remoteEntry},
    {scheduleId:OTHER_ID,kind:"keep-other"}]})
  const transport={async review(id,lease){calls.push({id,lease:structuredClone(lease)});if(options.duringGet)await options.duringGet(h,calls.length)
    if(options.networkFail)throw new Error("private Bearer");return h.reply}}
  const resolver=h.load("db/scheduleTerminalConflictRepo.ts").createInternalScheduleTerminalConflictResolver(transport)
  const preserve=async evidence=>{exports.push(structuredClone(evidence));if(options.duringExport)await options.duringExport(h);if(options.exportFail)throw new Error("file failed")}
  return {...h,resolver,transport,preserve,options}
}
for(const choice of [KEEP,CLOUD]){
  test(`${choice} requires full evidence before atomically adopting cloud source and handing off diary`,async()=>{
    const h=await harness(),before=all(h),r=await h.resolver.review(ID);assert.equal(r.ready,true);assert.equal(r.choices.length,2);assert.equal(all(h),before)
    const firstCopy=JSON.stringify(h.first.entry)
    h.options.duringExport=async h=>{assert.equal((await queue(h)).length,1);assert.equal((await h.db.entries.get(ID)).title,"本机后来编辑");assert.equal(await h.db.meta.get(ARCHIVE),undefined)}
    const result=await h.resolver.resolve(r.reviewId,choice,true,h.preserve);assert.equal(result.applied,true);assert.equal(result.localIntentStatus,"superseded_by_explicit_choice")
    const source=await h.db.schedules.get(ID),diary=await h.db.entries.get(ID)
    assert.equal(source.title,"另一设备首次");assert.equal(source.status,"converted");assert.equal(source.dirty,0);assert.equal(source.convertedEntryId,ID)
    assert.equal(diary.id,ID);assert.equal(diary.fromScheduleId,ID);assert.equal(diary.title,choice===KEEP?"本机后来编辑":"云端后来编辑")
    assert.equal(diary.dirty,choice===KEEP?1:0)
    if(choice===KEEP){assert.ok(diary.clientUpdatedAt>LATER);assert.ok(/^.*\.\d{3}Z$/.test(diary.clientUpdatedAt))}
    else assert.equal(diary.clientUpdatedAt,LATER)
    assert.equal((await queue(h)).length,0);assert.equal((await conflicts(h)).length,1);assert.equal((await conflicts(h))[0].scheduleId,OTHER_ID)
    const archive=(await h.db.meta.get(ARCHIVE)).value;assert.equal(archive.length,1);assert.equal(archive[0].kind,"terminal-text-resolution")
    const evidence=h.exports[0];assert.equal(evidence.intentions[0].entry.title,"本机首次");assert.equal(evidence.cloudReview.firstEntryDate,"2026-10-07")
    assert.equal(JSON.stringify(evidence.intentions[0].entry),firstCopy)
    assert.equal(evidence.meaning,"explicit_choice_not_first_intent_confirmation")
    for(const private of ["ownerUserId","tokenGeneration","generation","Bearer"])assert.equal(JSON.stringify(evidence).includes(private),false)
    const protectedNow=await h.load("db/scheduleStateRepo.ts").protectedConversions();assert.equal(protectedNow.entryIds.has(ID),false)
    assert.equal(h.calls.length,3);assert.equal(h.stores.entries.rows.size,1)
  })
}
for(const mode of ["purged","receipt_unknown","missing-local","pending-server","local-tag","remote-tag","local-image","remote-image","historical-image","media-row","protected-media","source-delete","pending-purge","p2-conflict","schedule-draft","diary-draft","bad-identity","duplicate-link","unknown-local","unknown-candidate"]){
  test(`${mode} remains read-only and never releases identity or media protection`,async()=>{
    const h=await harness()
    if(mode==="purged"){h.reply.entry=null;h.reply.entry_state="purged"}
    if(mode==="receipt_unknown"){h.reply.receipt_known=false;h.reply.reviewable=false;h.reply.reason="receipt_unknown";h.reply.first_entry_date=null;h.reply.first_entry_deleted=null}
    if(mode==="missing-local")await h.db.entries.delete(ID)
    if(mode==="pending-server"){h.reply.schedule=sourceWire(schedule());h.reply.entry=null;h.reply.entry_state="unknown";h.reply.reviewable=false;h.reply.receipt_known=false;h.reply.reason="not_terminal";h.reply.first_entry_date=null;h.reply.first_entry_deleted=null}
    if(mode==="local-tag")await h.db.entries.put({...h.local,tagIds:[OTHER_ID]})
    if(mode==="remote-tag")h.reply.entry.tag_ids=[OTHER_ID]
    const image={schemaVersion:1,doc:{type:"doc",content:[{type:"image",attrs:{src:`local://media/${OTHER_ID}`}}]}}
    if(mode==="local-image")await h.db.entries.put({...h.local,content:image})
    if(mode==="remote-image")h.reply.entry.content=image
    if(mode==="historical-image"){const rows=await conflicts(h);rows[0].localEntry.content=image;await h.db.meta.put({key:"scheduleConflicts",value:rows})}
    if(mode==="media-row")await h.db.media.put({id:OTHER_ID,entryId:ID,blob:new Blob(["keep bytes"])})
    if(mode==="protected-media"){const rows=await queue(h);rows[0].protectedMediaIds=[OTHER_ID];await h.db.meta.put({key:"scheduleConversions",value:rows})}
    if(mode==="source-delete")await h.db.schedules.put({...h.source,isDeleted:1,deletedAt:AT})
    if(mode==="pending-purge")await h.db.meta.put({key:"pendingPurges",value:[ID]})
    if(mode==="p2-conflict")await h.db.meta.put({key:"conflicts",value:[{entryId:ID,local:h.local}]})
    if(mode==="schedule-draft")await h.db.meta.put({key:"scheduleDraft",value:{unsaved:"keep"}})
    if(mode==="diary-draft")await h.db.meta.put({key:"draft",value:{unsaved:"keep"}})
    if(mode==="bad-identity")await h.db.entries.put({...h.local,fromScheduleId:OTHER_ID})
    if(mode==="duplicate-link")await h.db.entries.put(entry({id:OTHER_ID,fromScheduleId:ID}))
    if(mode==="unknown-local")await h.db.entries.put({...h.local,futureField:{keep:true}})
    if(mode==="unknown-candidate"){const rows=await conflicts(h);rows[0].privateToken="do not export";await h.db.meta.put({key:"scheduleConflicts",value:rows})}
    const before=all(h),r=await h.resolver.review(ID);assert.equal(r.ready,true);assert.equal(r.choices.length,0)
    assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false);assert.equal(h.exports.length,0);assert.equal(all(h),before)
  })
}
for(const mode of ["confirm","export","choice","review"]){
  test(`missing ${mode} cannot bypass explicit cloud-source scope`,async()=>{
    const h=await harness(),r=await h.resolver.review(ID),before=all(h)
    assert.equal((await h.resolver.resolve(mode==="review"?r.reviewId+1:r.reviewId,mode==="choice"?"keep-local":KEEP,mode!=="confirm",mode==="export"?undefined:h.preserve)).applied,false)
    assert.equal(all(h),before);assert.equal(h.calls.length,1)
  })
}
for(const mode of ["export-failure","account","relogin","epoch","entry","source","queue","candidate","media","draft","p2-conflict","purge"]){
  test(`evidence boundary ${mode} retains state and prevents late handoff`,async()=>{
    let after;const h=await harness({exportFail:mode==="export-failure",duringExport:async h=>{
      if(mode==="account")h.user("account-b")
      if(mode==="relogin"){h.user("account-b");h.user("account-a")}
      if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restored"})
      if(mode==="entry")await h.db.entries.put({...h.local,title:"new local"})
      if(mode==="source")await h.db.schedules.put({...h.source,title:"new source"})
      if(mode==="queue"){const rows=await queue(h);rows[0].queuedAt=SERVER;await h.db.meta.put({key:"scheduleConversions",value:rows})}
      if(mode==="candidate"){const rows=await conflicts(h);rows.push({...rows[0],localEntry:{...h.local,title:"new"}});await h.db.meta.put({key:"scheduleConflicts",value:rows})}
      if(mode==="media")await h.db.media.put({id:OTHER_ID,entryId:ID,blob:new Blob(["new bytes"])})
      if(mode==="draft")await h.db.meta.put({key:"draft",value:{unsaved:"new"}})
      if(mode==="p2-conflict")await h.db.meta.put({key:"conflicts",value:[{entryId:ID,local:h.local}]})
      if(mode==="purge")await h.db.meta.put({key:"pendingPurges",value:[ID]})
      after=all(h)
    }})
    const r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false);assert.equal(all(h),after)
    assert.equal(await h.db.meta.get(ARCHIVE),undefined);assert.equal(await h.db.meta.get(PREFIX+ID),undefined)
  })
}
for(const table of ["entries","schedules","meta"]){
  test(`failed ${table} handoff rolls back diary/source/proof/archive/queue/candidates together`,async()=>{
    const h=await harness({duringExport:async h=>h.failNext(table)}),r=await h.resolver.review(ID),before=all(h)
    assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false);assert.equal(all(h),before);assert.equal(h.exports.length,1)
  })
}
test("last candidate-clear failure cannot leave a partially released identity",async()=>{
  const h=await harness(),r=await h.resolver.review(ID),before=all(h),put=h.db.meta.put
  h.db.meta.put=async row=>{if(row.key==="scheduleConflicts")throw new Error("last write fails");return put(row)}
  assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false);assert.equal(all(h),before)
})
for(const when of ["before-export","after-export"]){
  test(`remote edit ${when} requires reopening and cannot adopt a version not reviewed`,async()=>{
    const options={duringGet:async(h,n)=>{if(n===(when==="before-export"?2:3))h.reply.entry.title="new remote"}},h=await harness(options),r=await h.resolver.review(ID),before=all(h)
    assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).reason,"server_changed_reopen")
    assert.equal(all(h),before);assert.equal(h.exports.length,when==="before-export"?0:1)
  })
}
for(const mode of ["local-deleted","remote-deleted"]){
  test(`${mode} permits only the non-resurrection selection`,async()=>{
    const h=await harness()
    if(mode==="local-deleted")await h.db.entries.put({...h.local,isDeleted:1,deletedAt:AT})
    else{h.reply.entry.deleted_at=AT;h.reply.entry_state="deleted"}
    const r=await h.resolver.review(ID),allowed=mode==="local-deleted"?KEEP:CLOUD,blocked=mode==="local-deleted"?CLOUD:KEEP
    assert.equal(JSON.stringify(r.choices),JSON.stringify([allowed]))
    assert.equal((await h.resolver.resolve(r.reviewId,blocked,true,h.preserve)).applied,false)
    assert.equal((await h.resolver.resolve(r.reviewId,allowed,true,h.preserve)).applied,true)
    assert.equal((await h.db.entries.get(ID)).isDeleted,1)
  })
}
test("other intentions/candidates, P2 and P4 cursors, metadata and tags are preserved",async()=>{
  const h=await harness(),other=intent({scheduleId:OTHER_ID,ownerUserId:"account-a",source:schedule({id:OTHER_ID}),entry:entry({id:OTHER_ID,fromScheduleId:OTHER_ID})})
  await h.db.meta.put({key:"scheduleConversions",value:[h.first,other]});await h.db.meta.put({key:"lastSyncAt",value:"P2 cursor"})
  await h.db.meta.put({key:"scheduleLastSyncAt",value:"P4 cursor"});await h.db.tags.put({id:OTHER_ID,name:"not related"})
  const r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,KEEP,true,h.preserve)).applied,true)
  assert.equal(JSON.stringify(await queue(h)),JSON.stringify([other]));assert.equal((await h.db.meta.get("lastSyncAt")).value,"P2 cursor")
  assert.equal((await h.db.meta.get("scheduleLastSyncAt")).value,"P4 cursor");assert.equal(h.stores.tags.rows.size,1)
})
test("two resolver instances and repeated apply cannot remove/archive the same intention twice",async()=>{
  const h=await harness(),second=h.load("db/scheduleTerminalConflictRepo.ts").createInternalScheduleTerminalConflictResolver(h.transport)
  const a=await h.resolver.review(ID),b=await second.review(ID)
  assert.equal((await h.resolver.resolve(a.reviewId,CLOUD,true,h.preserve)).applied,true)
  assert.equal((await h.resolver.resolve(a.reviewId,CLOUD,true,h.preserve)).applied,false)
  assert.equal((await second.resolve(b.reviewId,KEEP,true,h.preserve)).applied,false);assert.equal((await h.db.meta.get(ARCHIVE)).value.length,1)
})
test("known newer source or diary watermarks cannot be overwritten by stale evidence",async()=>{
  for(const resource of ["source","entry"]){const h=await harness()
    if(resource==="source")await h.db.schedules.put({...h.source,serverUpdatedAt:"2026-10-08T10:00:03.000Z"})
    else await h.db.entries.put({...h.local,serverUpdatedAt:"2026-10-08T10:00:02.000001Z"})
    const r=await h.resolver.review(ID),before=all(h);assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false);assert.equal(all(h),before)}
})
test("protected P2 candidates preserve distinct older entries and deduplicate exact repeats",async()=>{
  const h=await harness(),state=h.load("db/scheduleStateRepo.ts"),before=await conflicts(h)
  await state.holdConversionServerEntry({...h.remoteEntry,title:"new incoming"})
  await state.holdConversionServerEntry({...h.remoteEntry,title:"new incoming"})
  const after=await conflicts(h);assert.equal(after.length,before.length+1)
  assert.equal(after[0].serverEntry.title,h.remoteEntry.title);assert.equal(after.at(-1).serverEntry.title,"new incoming")
  await h.db.meta.put({key:"scheduleConflicts",value:"keep malformed"})
  await assert.rejects(state.holdConversionServerEntry(h.remoteEntry));assert.equal((await h.db.meta.get("scheduleConflicts")).value,"keep malformed")
})
test("resolver is internal; review/resolve never invokes conversion or ordinary sync",()=>{
  for(const file of ["repo/index.ts","api/sync.ts","router/index.ts","db/scheduleSyncRepo.ts"]){const text=fs.readFileSync(path.join(__dirname,"../src",file),"utf8");assert.equal(text.includes("createInternalScheduleTerminalConflictResolver"),false)}
})
test("already confirmed source without a queue can explicitly resolve a protected diary candidate",async()=>{
  const h=await harness();await h.db.meta.put({key:"scheduleConversions",value:[]})
  const r=await h.resolver.review(ID),out=await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)
  assert.equal(out.applied,true);assert.equal(out.localIntentStatus,"no_local_intent")
  assert.equal(h.exports[0].intentions.length,0)
})
test("matching deleted sources remain deleted while their chosen active diary is independent",async()=>{
  const h=await harness();await h.db.schedules.put({...h.source,isDeleted:1,deletedAt:AT})
  h.reply.schedule.deleted_at=AT;const r=await h.resolver.review(ID)
  assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,true)
  assert.equal((await h.db.schedules.get(ID)).isDeleted,1);assert.equal((await h.db.entries.get(ID)).isDeleted,0)
})
for(const key of ["scheduleConflictArchive","scheduleConflicts","pendingPurges","conflicts"]){
  test(`malformed ${key} prevents remote requests and remains untouched`,async()=>{
    const h=await harness();await h.db.meta.put({key,value:"keep malformed"});const before=all(h)
    assert.equal((await h.resolver.review(ID)).ready,false);assert.equal(h.calls.length,0);assert.equal(all(h),before)
  })
}
test("foreign intention owner is not silently adopted or removed",async()=>{
  const h=await harness(),rows=await queue(h);rows[0].ownerUserId="other-owner";await h.db.meta.put({key:"scheduleConversions",value:rows})
  const before=all(h);assert.equal((await h.resolver.review(ID)).ready,false);assert.equal(h.calls.length,0);assert.equal(all(h),before)
})
test("single-flight and exported object mutation cannot alter the reviewed choice",async()=>{
  let release;const gate=new Promise(r=>release=r),h=await harness(),r=await h.resolver.review(ID)
  const first=h.resolver.resolve(r.reviewId,CLOUD,true,async evidence=>{evidence.localEntry.title="tampered";evidence.cloudReview.entry.title="tampered";await gate})
  await new Promise(r=>setTimeout(r,20));assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).reason,"busy")
  assert.equal((await h.resolver.review(ID)).reason,"busy");release();assert.equal((await first).applied,true)
  assert.equal((await h.db.entries.get(ID)).title,"云端后来编辑")
  assert.equal((await h.db.meta.get(ARCHIVE)).value[0].evidence.localEntry.title,"本机后来编辑")
})
test("real pinned read-only adapter composes with resolution but issues only three GET reviews",async()=>{
  const {networkHarness}=require("./schedules-network-harness.cjs"),h=await harness()
  const net=networkHarness((url)=>{assert.equal(url,`/schedules/${ID}/review`);return {status:200,data:{code:0,data:h.reply}}})
  h.mocks["./request"]=net.api;h.mocks["./tokenStore"]=net.tokens;h.mocks["@/api/tokenStore"]=net.tokens
  const transport=h.load("api/scheduleTerminalReviewTransport.ts").createScheduleTerminalReviewTransport()
  const resolver=h.load("db/scheduleTerminalConflictRepo.ts").createInternalScheduleTerminalConflictResolver(transport),r=await resolver.review(ID)
  assert.equal((await resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,true)
  assert.equal(net.calls.length,3);assert.ok(net.calls.every(row=>row._syncOwner==="account-a" && row._tokenGeneration===0))
})
test("known empty schedule draft journal does not block resolution or get deleted",async()=>{
  const h=await harness(),slot={formatVersion:1,revision:4,draft:null};await h.db.meta.put({key:"scheduleDraft",value:slot})
  const r=await h.resolver.review(ID);assert.equal(r.choices.length,2)
  assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,true)
  assert.equal(JSON.stringify((await h.db.meta.get("scheduleDraft")).value),JSON.stringify(slot))
})
test("even an empty-to-empty journal revision change invalidates the old review",async()=>{
  const h=await harness({duringExport:async h=>h.db.meta.put({key:"scheduleDraft",value:{formatVersion:1,revision:5,draft:null}})})
  await h.db.meta.put({key:"scheduleDraft",value:{formatVersion:1,revision:4,draft:null}})
  const r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false)
  assert.equal((await queue(h)).length,1);assert.equal((await h.db.meta.get("scheduleDraft")).value.revision,5)
})
