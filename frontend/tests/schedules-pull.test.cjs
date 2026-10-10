const { test } = require("node:test")
const assert = require("node:assert/strict")
const { ID, OTHER_ID, AT, content, schedule, entry, terminal, intent, setup } = require("./schedules-data-harness.cjs")
const { networkHarness } = require("./schedules-network-harness.cjs")
const SERVER = "2026-10-08T10:00:02.000Z", NEXT = "2026-10-08T10:00:03.000Z"
const FLOOR = "1000-01-01T00:00:00.000Z", PREFIX = "scheduleServerState:"
function wire(row, time = SERVER) { return { id:row.id,remind_date:row.remindDate,title:row.title,content:row.content,content_text:row.contentText,
  status:row.status,converted_entry_id:row.convertedEntryId,converted_at:row.convertedAt,client_updated_at:row.clientUpdatedAt,
  deleted_at:row.deletedAt,created_at:row.createdAt,updated_at:time } }
const response = (rows = [], extra = {}) => ({ schedules:rows,server_time:SERVER,sync_until:SERVER,cursor_id:null,has_more:false,...extra })
const clean = extra => schedule({ dirty:0,serverUpdatedAt:AT,...extra })
const saved = h => JSON.stringify([...h.stores.schedules.rows.values()])
const cursor = async h => (await h.db.meta.get("scheduleLastSyncAt"))?.value
const logs = async (h,key="scheduleConflicts") => (await h.db.meta.get(key))?.value ?? []
async function harness(options = {}) {
  const h=setup(),calls=[];h.mocks["@/api/tokenStore"]=h.tokens
  await h.db.meta.put({key:"ownerUserId",value:"account-a"});await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
  const core=h.load("shared/schedulePull.ts");h.mocks["@/shared/schedulePull"]=core
  const transport={async pull(params,lease){calls.push({params:structuredClone(params),lease:structuredClone(lease)})
    if(options.during)await options.during(h)
    if(options.fail)throw new core.SchedulePullTransportError(options.fail)
    return typeof options.reply==="function" ? options.reply(calls.length) : options.reply ?? response()
  }}
  const coordinator=h.load("db/schedulePullRepo.ts").createInternalSchedulePullCoordinator(transport)
  return {...h,core,calls,transport,coordinator}
}
test("empty page uses owner floor and commits a dedicated epoch cursor without touching P2",async()=>{
  const h=await harness();await h.db.meta.put({key:"lastSyncAt",value:"P2-kept"})
  const r=await h.coordinator.runPage();assert.equal(r.applied,true);assert.equal(h.calls[0].params.since,FLOOR)
  assert.equal((await cursor(h)).since,SERVER);assert.equal((await cursor(h)).until,null)
  assert.equal((await h.db.meta.get("lastSyncAt")).value,"P2-kept")
})
test("same-millisecond pagination pins until and starts the next round inclusively",async()=>{
  const h=await harness({reply:n=>n===1?response([wire(schedule()),wire(schedule({id:OTHER_ID}))],{has_more:true,cursor_id:OTHER_ID}):response()})
  assert.equal((await h.coordinator.runPage(2)).hasMore,true)
  assert.equal((await h.coordinator.runPage(2)).applied,true)
  assert.equal(h.calls[1].params.after_id,OTHER_ID);assert.equal(h.calls[1].params.until,SERVER)
  await h.coordinator.runPage(2);assert.equal(h.calls[2].params.since,SERVER);assert.equal(Object.hasOwn(h.calls[2].params,"until"),false)
})
test("clean sources and deletion tombstones merge with derived text and validated cloud proof only",async()=>{
  const h=await harness({reply:response([wire(schedule({contentText:"bad",isDeleted:1,deletedAt:AT}))])})
  await h.db.entries.put(entry());const before=JSON.stringify(await h.db.entries.toArray())
  const r=await h.coordinator.runPage();assert.equal(r.items[0].kind,"merged")
  const row=await h.db.schedules.get(ID);assert.equal(row.dirty,0);assert.equal(row.contentText,"计划");assert.equal(row.isDeleted,1)
  assert.equal((await h.db.meta.get(PREFIX+ID)).value.source.serverUpdatedAt,SERVER)
  assert.equal(JSON.stringify(await h.db.entries.toArray()),before);assert.equal(h.stores.media.rows.size,0)
})
test("remote terminal source does not create a missing diary",async()=>{
  const h=await harness({reply:response([wire(terminal())])});await h.coordinator.runPage()
  assert.equal((await h.db.schedules.get(ID)).status,"converted");assert.equal(await h.db.entries.get(ID),undefined)
})
test("a newer clean pending version is adopted without changing its natural day",async()=>{
  const h=await harness({reply:response([wire(schedule({title:"new",clientUpdatedAt:NEXT,remindDate:"2020-01-01"}),NEXT)],{server_time:NEXT,sync_until:NEXT})})
  await h.db.schedules.put(clean());assert.equal((await h.coordinator.runPage()).items[0].kind,"merged")
  assert.equal((await h.db.schedules.get(ID)).remindDate,"2020-01-01")
})
for(const mode of ["dirty","queue","blocked","unknown","invalid","too_new","terminal_regression","terminal_body","terminal_time","client_regression","same_revision","identity"]){
  test(`${mode} retains local source and cloud candidate before advancing its page`,async()=>{
    let local=clean(),remote=schedule(),expected="conflict"
    if(mode==="dirty"){local=schedule({title:"local"});remote.title="cloud"}
    if(mode==="queue"){local=terminal();expected="held"}
    if(mode==="blocked")expected="held"
    if(mode==="unknown")local.futureField={keep:true}
    if(mode==="invalid")local.remindDate="invalid"
    if(mode==="too_new")remote.content={schemaVersion:999,doc:{type:"doc",content:[]}}
    if(mode.startsWith("terminal_")){local=terminal({dirty:0,serverUpdatedAt:AT});remote=terminal()
      if(mode==="terminal_regression")remote=schedule()
      if(mode==="terminal_body")remote.title="changed"
      if(mode==="terminal_time")remote.convertedAt=NEXT
    }
    if(mode==="client_regression")local.clientUpdatedAt=NEXT
    if(mode==="same_revision")remote.title="different"
    if(mode==="identity")remote=terminal()
    const h=await harness({reply:response([wire(remote)])});await h.db.schedules.put(local)
    if(mode==="queue")await h.db.meta.put({key:"scheduleConversions",value:[intent({ownerUserId:"account-a"})]})
    if(mode==="blocked")await h.db.meta.put({key:"scheduleConflicts",value:[{scheduleId:ID,kind:"existing"}]})
    if(mode==="identity")await h.db.entries.put(entry({fromScheduleId:undefined}))
    const before=saved(h),r=await h.coordinator.runPage();assert.equal(r.applied,true);assert.equal(r.items[0].kind,expected)
    assert.equal(saved(h),before);assert.equal((await cursor(h)).since,SERVER)
    assert.ok((await logs(h,expected==="held"?"scheduleSyncErrors":"scheduleConflicts")).length)
    assert.equal(await h.db.meta.get(PREFIX+ID),undefined)
  })
}
for(const mode of ["local_echo","base_echo","older_server"]){
  test(`${mode} is held without blocking legitimate local push`,async()=>{
    const local=mode==="local_echo"?schedule():schedule({title:"edited",clientUpdatedAt:NEXT,serverUpdatedAt:mode==="older_server"?NEXT:AT})
    const h=await harness({reply:response([wire(schedule())])});await h.db.schedules.put(local)
    if(mode==="base_echo")await h.db.meta.put({key:PREFIX+ID,value:{ownerUserId:"account-a",generation:"epoch",source:clean()}})
    const before=saved(h),r=await h.coordinator.runPage();assert.equal(r.items[0].kind,"held");assert.equal(saved(h),before)
    assert.equal((await logs(h)).length,0);assert.equal((await logs(h,"scheduleSyncErrors")).length,1)
  })
}
for(const mode of ["duplicate","reverse","outside","bad_date","bad_id","more_count","more_cursor","final_cursor","window_change"]){
  test(`invalid page ${mode} never partially merges or advances`,async()=>{
    let page=response([wire(schedule())]);const h=await harness({reply:()=>page})
    if(mode==="duplicate")page.schedules.push(wire(schedule()))
    if(mode==="reverse")page.schedules=[wire(schedule({id:OTHER_ID})),wire(schedule())]
    if(mode==="outside")page.schedules[0].updated_at=NEXT
    if(mode==="bad_date")page.schedules[0].remind_date="2026-02-30"
    if(mode==="bad_id")page.schedules[0].id="invalid"
    if(mode==="more_count")page.has_more=true
    if(mode==="more_cursor"){page.has_more=true;page.cursor_id=OTHER_ID}
    if(mode==="final_cursor")page.cursor_id=ID
    if(mode==="window_change")await h.db.meta.put({key:"scheduleLastSyncAt",value:{ownerUserId:"account-a",generation:"epoch",since:AT,afterId:ID,until:NEXT}})
    const before=JSON.stringify(await cursor(h));const r=await h.coordinator.runPage(mode==="more_cursor"?1:200)
    assert.equal(r.applied,false);assert.equal(h.stores.schedules.rows.size,0);assert.equal(JSON.stringify(await cursor(h)),before)
    assert.equal((await logs(h,"scheduleSyncErrors"))[0].reason,"invalid_response")
  })
}
test("malformed legacy cursor fails before requesting and expired scope restarts without clearing content",async()=>{
  const h=await harness();await h.db.meta.put({key:"scheduleLastSyncAt",value:AT});assert.equal((await h.coordinator.runPage()).applied,false)
  assert.equal(h.calls.length,0);assert.equal(await cursor(h),AT)
  await h.db.schedules.put(schedule());await h.db.meta.put({key:"scheduleLastSyncAt",value:{ownerUserId:"account-a",generation:"old"}})
  assert.equal((await h.coordinator.runPage()).applied,true);assert.equal(h.calls[0].params.since,FLOOR);assert.equal(h.stores.schedules.rows.size,1)
})
for(const mode of ["switch","relogin","restore"]){
  test(`in-flight ${mode} cannot commit source, candidate, or cursor`,async()=>{
    const h=await harness({reply:response([wire(schedule())]),during:async h=>{
      if(mode==="restore")await h.db.meta.put({key:"ownerGeneration",value:"new"})
      else {h.user("account-b");if(mode==="relogin")h.user("account-a")}
    }})
    assert.equal((await h.coordinator.runPage()).applied,false);assert.equal(h.stores.schedules.rows.size,0)
    assert.equal(await cursor(h),undefined);assert.equal((await logs(h,"scheduleSyncErrors")).length,0)
  })
}
for(const table of ["schedules","meta"]){
  test(`${table} transaction failure rolls back the entire page and cloud proof`,async()=>{
    const h=await harness({reply:response([wire(schedule()),wire(schedule({id:OTHER_ID}))]),during:async h=>h.failNext(table)})
    assert.equal((await h.coordinator.runPage()).applied,false);assert.equal(h.stores.schedules.rows.size,0)
    assert.equal(await cursor(h),undefined);assert.equal(await h.db.meta.get(PREFIX+ID),undefined)
  })
}
test("candidate persistence failure cannot skip a dirty cloud conflict",async()=>{
  const h=await harness({reply:response([wire(schedule({title:"cloud"}))]),during:async h=>h.failNext("meta")})
  await h.db.schedules.put(schedule({title:"local"}));const before=saved(h)
  assert.equal((await h.coordinator.runPage()).applied,false);assert.equal(saved(h),before);assert.equal(await cursor(h),undefined)
})
test("local conversion created during GET is protected by the fresh transaction queue",async()=>{
  const h=await harness({reply:response([wire(schedule())]),during:async h=>{
    await h.db.schedules.put(terminal());await h.db.entries.put(entry())
    await h.db.meta.put({key:"scheduleConversions",value:[intent({ownerUserId:"account-a"})]})
  }})
  const r=await h.coordinator.runPage();assert.equal(r.items[0].reason,"conversion_pending")
  assert.equal((await h.db.schedules.get(ID)).status,"converted");assert.equal((await h.db.entries.get(ID)).title,"日记")
})
test("two instances cannot both apply a page captured from the same cursor",async()=>{
  const h=await harness();let ready=0,release;const gate=new Promise(r=>release=r)
  const transport={async pull(){if(++ready===2)release();await gate;return response()}}
  const factory=h.load("db/schedulePullRepo.ts").createInternalSchedulePullCoordinator
  const results=await Promise.all([factory(transport).runPage(),factory(transport).runPage()])
  assert.equal(results.filter(r=>r.applied).length,1);assert.equal(results.find(r=>!r.applied).reason,"cursor_changed")
})
test("same instance busy and bad limits never start extra requests",async()=>{
  let release;const gate=new Promise(r=>release=r);const h=await harness({during:()=>gate})
  for(const n of [0,501,1.5])assert.equal((await h.coordinator.runPage(n)).reason,"invalid_limit")
  const pending=h.coordinator.runPage();await new Promise(r=>setTimeout(r,20))
  assert.equal((await h.coordinator.runPage()).reason,"busy");release();await pending;assert.equal(h.calls.length,1)
})
test("HTTP cursor conflict preserves cursor and logs only a safe reason",async()=>{
  const h=await harness({fail:"cursor_or_lock_conflict"});await h.db.meta.put({key:"scheduleLastSyncAt",value:{ownerUserId:"account-a",generation:"epoch",since:AT,afterId:null,until:null}})
  const before=JSON.stringify(await cursor(h));assert.equal((await h.coordinator.runPage()).applied,false)
  assert.equal(JSON.stringify(await cursor(h)),before);assert.equal((await logs(h,"scheduleSyncErrors"))[0].reason,"cursor_or_lock_conflict")
})
test("actual GET request helper pins params, account and token generation",async()=>{
  const net=networkHarness(()=>({status:200,data:{code:0,message:"ok",data:response()}})),h=await harness()
  h.mocks["./request"]=net.api;h.mocks["./tokenStore"]=net.tokens;h.mocks["@/api/tokenStore"]=net.tokens
  const transport=h.load("api/schedulePullTransport.ts").createSchedulePullTransport()
  const r=await h.load("db/schedulePullRepo.ts").createInternalSchedulePullCoordinator(transport).runPage()
  assert.equal(r.applied,true);assert.equal(net.calls[0].url,"/schedules/sync/changes")
  assert.equal(net.calls[0]._syncOwner,"account-a");assert.equal(net.calls[0]._tokenGeneration,0);assert.equal(net.calls[0].params.since,FLOOR)
})
for(const mode of ["refresh","409","stale"]){
  test(`actual pinned GET ${mode} does not silently reset or switch accounts`,async()=>{
    let net;net=networkHarness(async(_url,_body,_config,n)=>{
      if(mode==="refresh"&&n===1)return {status:401,data:{code:401,message:"expired",data:null}}
      if(mode==="409")return {status:409,data:{code:409,message:"private raw SQL",data:null}}
      if(mode==="stale")net.switch("account-b")
      return {status:200,data:{code:0,data:response()}}
    })
    const h=await harness();h.mocks["./request"]=net.api;h.mocks["./tokenStore"]=net.tokens;h.mocks["@/api/tokenStore"]=net.tokens
    const transport=h.load("api/schedulePullTransport.ts").createSchedulePullTransport()
    const r=await h.load("db/schedulePullRepo.ts").createInternalSchedulePullCoordinator(transport).runPage()
    assert.equal(r.applied,mode==="refresh")
    if(mode==="refresh"){assert.equal(net.refreshes(),1);assert.equal(net.calls.length,2);assert.equal((await cursor(h)).since,SERVER)}
    else assert.equal(await cursor(h),undefined)
    if(mode==="409")assert.equal((await logs(h,"scheduleSyncErrors"))[0].reason,"cursor_or_lock_conflict")
    assert.equal(JSON.stringify(await logs(h,"scheduleSyncErrors")).includes("private raw SQL"),false)
  })
}
test("failure saving the last cursor rolls back already merged rows and remembered proofs",async()=>{
  const h=await harness({reply:response([wire(schedule()),wire(schedule({id:OTHER_ID}))])})
  const put=h.db.meta.put;h.db.meta.put=async row=>{if(row.key==="scheduleLastSyncAt")throw new Error("cursor storage failed");return put(row)}
  assert.equal((await h.coordinator.runPage()).applied,false);assert.equal(h.stores.schedules.rows.size,0)
  assert.equal(await h.db.meta.get(PREFIX+ID),undefined);assert.equal(await cursor(h),undefined)
})
test("local too-new content and duplicate linked diary identities are quarantined",async()=>{
  for(const mode of ["new_local","duplicate_link"]){
    const h=await harness({reply:response([wire(terminal())])})
    if(mode==="new_local")await h.db.schedules.put(clean({content:{schemaVersion:999,doc:{type:"doc",content:[]}}}))
    else {await h.db.entries.put(entry());await h.db.entries.put(entry({id:OTHER_ID}))}
    const r=await h.coordinator.runPage();assert.equal(r.items[0].kind,"conflict")
    assert.equal(r.items[0].reason,mode==="new_local"?"unsupported_content":"entry_identity_conflict")
  }
})
test("equal server watermark with different business content cannot overwrite a clean source",async()=>{
  const h=await harness({reply:response([wire(schedule({title:"contradiction",clientUpdatedAt:NEXT}))])})
  await h.db.schedules.put(clean({serverUpdatedAt:SERVER}));const before=saved(h)
  const r=await h.coordinator.runPage();assert.equal(r.items[0].reason,"server_revision_conflict");assert.equal(saved(h),before)
})
