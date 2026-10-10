const { test } = require("node:test")
const assert = require("node:assert/strict")
const { ID, OTHER_ID, AT, content, schedule, entry, terminal, intent, setup } = require("./schedules-data-harness.cjs")
const { networkHarness } = require("./schedules-network-harness.cjs")
const FIRST = "2026-10-08T10:00:00.001Z", SERVER = "2026-10-08T10:00:02.000Z"
const prefix = "scheduleServerState:"
const resource = i => `019a0300-1234-7000-8000-${String(i + 1).padStart(12,"0")}`
function wire(row) { return { id: row.id, remind_date: row.remindDate, title: row.title, content: row.content, content_text: row.contentText,
  status: row.status, converted_entry_id: row.convertedEntryId, converted_at: row.convertedAt,
  client_updated_at: row.clientUpdatedAt, deleted_at: row.deletedAt, created_at: row.createdAt, updated_at: SERVER } }
function reply(h, body) {
  return { interrupted: false, schedules: body.schedules.map((sent,index) => {
    const old = h.stores.schedules.rows.get(sent.id)
    const current = sent.status === "converted" ? { ...old, clientUpdatedAt: sent.client_updated_at,
      deletedAt: sent.deleted_at, isDeleted: sent.deleted_at === null ? 0 : 1 } : schedule({ id: sent.id,
      remindDate: sent.remind_date, title: sent.title, content: sent.content, contentText: sent.content_text,
      clientUpdatedAt: sent.client_updated_at, deletedAt: sent.deleted_at, isDeleted: sent.deleted_at === null ? 0 : 1 })
    return { index, id: sent.id, status: "applied", reason: "applied", submitted_client_updated_at: sent.client_updated_at, current: wire(current) }
  }) }
}
async function harness(options = {}) {
  const h = setup(), calls = []
  h.mocks["@/api/tokenStore"] = h.tokens
  await h.db.meta.put({ key: "ownerUserId", value: "account-a" })
  await h.db.meta.put({ key: "ownerGeneration", value: "epoch" })
  const transport = { async push(body,lease) {
    calls.push({ body: structuredClone(body), lease })
    const result = reply(h,body)
    if (options.during) await options.during(h,body)
    if (options.failure) throw new Error("private SQL/Bearer")
    return options.response ? options.response(result,h,body) : result
  } }
  const coordinator = h.load("db/schedulePushRepo.ts").createInternalSchedulePushCoordinator(transport)
  async function baseline(row, extra = {}) {
    await h.db.meta.put({ key: prefix + row.id, value: { ownerUserId: "account-a", generation: "epoch",
      source: { ...row, dirty: 0, updatedAt: AT, serverUpdatedAt: AT }, ...extra } })
  }
  return { ...h, calls, coordinator, baseline }
}
async function log(h,key = "scheduleSyncErrors") { return (await h.db.meta.get(key))?.value ?? [] }
const state = h => JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v]) => [k,[...v.rows.values()]])))

test("one explicit batch sends pending business snapshots and acknowledges only matching dirty rows", async () => {
  const h = await harness(); await h.db.schedules.put(schedule({ contentText: "坏索引" }))
  const result = await h.coordinator.runOnce()
  assert.equal(result.sent,1); assert.equal(result.items[0].kind,"confirmed")
  const local = await h.db.schedules.get(ID)
  assert.equal(local.dirty,0); assert.equal(local.contentText,"计划"); assert.equal(local.serverUpdatedAt,SERVER)
  assert.equal(h.calls[0].body.schedules[0].content_text,"计划")
  assert.equal(Object.hasOwn(h.calls[0].body.schedules[0],"ownerUserId"),false)
  assert.equal((await h.db.meta.get(prefix+ID)).value.source.clientUpdatedAt,AT)
})
test("pending deletion and restore keep UTC revision and natural date, without server-today changes", async () => {
  const h = await harness(); await h.db.schedules.put(schedule({ remindDate:"2020-01-01", isDeleted:1, deletedAt:AT }))
  await h.coordinator.runOnce()
  await h.db.schedules.put({ ...await h.db.schedules.get(ID), isDeleted:0, deletedAt:null, clientUpdatedAt:FIRST, dirty:1 })
  await h.coordinator.runOnce()
  assert.equal(h.calls[0].body.schedules[0].deleted_at,AT); assert.equal(h.calls[1].body.schedules[0].deleted_at,null)
  assert.equal((await h.db.schedules.get(ID)).remindDate,"2020-01-01")
})
test("terminal deletion is sparse and uses the observed cloud revision rather than guessing from local convertedAt", async () => {
  const h = await harness(), original = terminal({ convertedAt:"2026-10-08T09:00:00.000Z" })
  await h.baseline(original)
  await h.db.schedules.put({ ...original, isDeleted:1, deletedAt:FIRST, clientUpdatedAt:FIRST })
  await h.db.entries.put(entry())
  const before = await h.db.entries.get(ID)
  assert.equal((await h.coordinator.runOnce()).items[0].kind,"confirmed")
  const body = h.calls[0].body.schedules[0]
  assert.deepEqual(Object.keys(body).sort(),["client_updated_at","deleted_at","expected_schedule_client_updated_at","id","status"].sort())
  assert.equal(body.expected_schedule_client_updated_at,AT)
  assert.equal((await h.db.schedules.get(ID)).status,"converted"); assert.deepEqual(await h.db.entries.get(ID),before)
})
test("terminal restore never edits or recreates its physically missing diary", async () => {
  const h = await harness(), base = terminal({ isDeleted:1, deletedAt:AT })
  await h.baseline(base); await h.db.schedules.put(terminal({ clientUpdatedAt:FIRST }))
  assert.equal((await h.coordinator.runOnce()).items[0].kind,"confirmed")
  assert.equal(h.calls[0].body.schedules[0].deleted_at,null); assert.equal(await h.db.entries.get(ID),undefined)
})
for (const mode of ["missing","epoch","owner","old_clock","body_conflict"]) {
  test(`terminal ${mode} baseline holds the record without fetching or rebasing cloud state`, async () => {
    const h = await harness(), base = terminal()
    if (mode !== "missing") await h.baseline(base, mode === "epoch" ? { generation:"old-epoch" } : mode === "owner" ? { ownerUserId:"other" } : {})
    await h.db.schedules.put(terminal({ clientUpdatedAt: mode === "old_clock" ? AT : FIRST, title: mode === "body_conflict" ? "不同源内容" : "预简" }))
    const before = state(h), result = await h.coordinator.runOnce()
    assert.equal(result.sent,0); assert.equal(result.items[0].kind,"held"); assert.equal(h.calls.length,0); assert.equal(state(h),before)
  })
}
test("unconfirmed conversion and conflict targets are isolated while an unrelated pending row progresses", async () => {
  const h = await harness()
  await h.db.schedules.put(terminal()); await h.db.schedules.put(schedule({ id:OTHER_ID }))
  await h.db.meta.put({ key:"scheduleConversions", value:[intent({ ownerUserId:"account-a" })] })
  const result = await h.coordinator.runOnce()
  assert.equal(result.sent,1); assert.equal(h.calls[0].body.schedules[0].id,OTHER_ID)
  assert.equal(result.items.find(r=>r.id===ID).reason,"conversion_pending")
  assert.equal((await h.db.meta.get("scheduleConversions")).value.length,1)
  assert.equal((await h.db.schedules.get(ID)).dirty,1)
})
test("existing conflict target remains blocked and its older candidate is never discarded", async () => {
  const h = await harness(); await h.db.schedules.put(schedule())
  await h.db.meta.put({ key:"scheduleConflicts", value:[{ scheduleId:ID, kind:"old-candidate", body:"keep" }] })
  const before = state(h), result = await h.coordinator.runOnce()
  assert.equal(result.sent,0); assert.equal(result.items[0].reason,"conflict_pending"); assert.equal(state(h),before)
})
test("late ACK for a newer local edit records the cloud proof but never clears its new dirty or text", async () => {
  const h = await harness({ during: async h => { const row = await h.db.schedules.get(ID)
    await h.db.schedules.put({ ...row, title:"后来编辑", clientUpdatedAt:FIRST, dirty:1 }) } })
  await h.db.schedules.put(schedule()); const result = await h.coordinator.runOnce()
  assert.equal(result.items[0].reason,"changed_locally")
  const row = await h.db.schedules.get(ID); assert.equal(row.title,"后来编辑"); assert.equal(row.dirty,1)
  assert.equal((await h.db.meta.get(prefix+ID)).value.source.clientUpdatedAt,AT)
})
test("conversion occurring during pending upload keeps its intention, diary and converted source protected", async () => {
  const h = await harness({ during: async h => {
    await h.db.schedules.put(terminal({ clientUpdatedAt:FIRST })); await h.db.entries.put(entry({ clientUpdatedAt:FIRST }))
    await h.db.meta.put({ key:"scheduleConversions", value:[intent({ ownerUserId:"account-a" })] })
  } })
  await h.db.schedules.put(schedule()); const result = await h.coordinator.runOnce()
  assert.equal(result.items[0].kind,"held"); assert.equal((await h.db.schedules.get(ID)).status,"converted")
  assert.equal((await h.db.schedules.get(ID)).dirty,1); assert.equal((await h.db.meta.get("scheduleConversions")).value.length,1)
})
for (const mode of ["account","relogin","epoch"]) {
  test(`old batch after ${mode} change cannot clear dirty or write cloud proof`, async () => {
    const h = await harness({ during: async h => {
      if (mode === "account") h.user("account-b")
      if (mode === "relogin") { h.user("account-b"); h.user("account-a") }
      if (mode === "epoch") await h.db.meta.put({ key:"ownerGeneration",value:"restored" })
    } })
    await h.db.schedules.put(schedule()); assert.equal((await h.coordinator.runOnce()).stopped,true)
    assert.equal((await h.db.schedules.get(ID)).dirty,1); assert.equal(await h.db.meta.get(prefix+ID),undefined)
    assert.equal((await log(h)).length,0)
  })
}
test("mixed applied, stale, retry and rollback interruption keep per-item truth without adopting conflict baselines", async () => {
  const h = await harness({ response: result => { result.interrupted=true
    Object.assign(result.schedules[1],{status:"stale",reason:"stale"})
    Object.assign(result.schedules[2],{status:"error",reason:"storage",current:null})
    Object.assign(result.schedules[3],{status:"error",reason:"aborted",current:null,submitted_client_updated_at:null})
    return result } })
  for (let i=0;i<4;i++) await h.db.schedules.put(schedule({id:resource(i)}))
  const result = await h.coordinator.runOnce()
  assert.deepEqual(Array.from(result.items,r=>r.kind),["confirmed","conflict","error","error"])
  assert.equal((await h.db.schedules.get(resource(0))).dirty,0)
  assert.equal((await h.db.schedules.get(resource(1))).dirty,1)
  assert.equal(await h.db.meta.get(prefix+resource(1)),undefined)
  assert.equal((await log(h,"scheduleConflicts"))[0].serverSchedule.id,resource(1))
})
for (const mode of ["truncated","wrong_id","wrong_index","unknown_reason","false_abort"]) {
  test(`malformed whole batch ${mode} never clears any dirty flag`, async () => {
    const h = await harness({ response: result => {
      if (mode === "truncated") result.schedules.pop()
      if (mode === "wrong_id") result.schedules[0].id=OTHER_ID
      if (mode === "wrong_index") result.schedules[0].index=9
      if (mode === "unknown_reason") result.schedules[0].reason="private SQL"
      if (mode === "false_abort") Object.assign(result.schedules[0],{status:"error",reason:"aborted",current:null})
      return result
    } })
    await h.db.schedules.put(schedule()); await h.coordinator.runOnce()
    assert.equal((await h.db.schedules.get(ID)).dirty,1); assert.equal(await h.db.meta.get(prefix+ID),undefined)
    assert.equal((await log(h))[0].reason,"invalid_response")
    assert.equal(JSON.stringify(await log(h)).includes("private SQL"),false)
  })
}
test("same-revision wrong content success is retained as conflict rather than acknowledged", async () => {
  const h = await harness({ response:r=>{r.schedules[0].current.title="不同内容";return r} })
  await h.db.schedules.put(schedule()); const result=await h.coordinator.runOnce()
  assert.equal(result.items[0].reason,"echo_mismatch"); assert.equal((await h.db.schedules.get(ID)).dirty,1)
  assert.equal(await h.db.meta.get(prefix+ID),undefined)
})
test("newer remembered cloud watermarks cannot be rolled back by an old push response", async () => {
  const h=await harness({during:async h=>{await h.db.meta.put({key:prefix+ID,value:{ownerUserId:"account-a",generation:"epoch",
    source:schedule({dirty:0,updatedAt:"2026-10-08T10:00:03.000Z",serverUpdatedAt:"2026-10-08T10:00:03.000Z"})}})} })
  await h.db.schedules.put(schedule()); const result=await h.coordinator.runOnce()
  assert.equal(result.items[0].reason,"older_server_state"); assert.equal((await h.db.schedules.get(ID)).dirty,1)
})
test("failed ACK storage rolls back only that item and valid neighbors still commit", async () => {
  const h=await harness(); for (let i=0;i<3;i++) await h.db.schedules.put(schedule({id:resource(i)}))
  const put=h.db.schedules.put; let calls=0
  h.db.schedules.put=async row=>{calls++;if(calls===2)throw new Error("quota");return put(row)}
  const result=await h.coordinator.runOnce()
  assert.deepEqual(Array.from(result.items,r=>r.kind),["confirmed","error","confirmed"])
  assert.equal((await h.db.schedules.get(resource(1))).dirty,1)
  assert.equal(await h.db.meta.get(prefix+resource(1)),undefined)
  assert.equal((await h.db.schedules.get(resource(0))).dirty,0);assert.equal((await h.db.schedules.get(resource(2))).dirty,0)
})
test("network timeout keeps all local data and proof absent while recording only safe classification",async()=>{
  const h=await harness({failure:true});await h.db.schedules.put(schedule())
  await h.coordinator.runOnce();assert.equal((await h.db.schedules.get(ID)).dirty,1)
  assert.equal(await h.db.meta.get(prefix+ID),undefined);assert.equal((await log(h))[0].reason,"network")
  assert.equal(JSON.stringify(await log(h)).includes("Bearer"),false)
})
test("one batch is capped at 50 with deterministic IDs and never claims entire synchronization complete",async()=>{
  const h=await harness();for(let i=50;i>=0;i--)await h.db.schedules.put(schedule({id:resource(i)}))
  const result=await h.coordinator.runOnce();assert.equal(result.sent,50);assert.equal(result.more,true)
  assert.deepEqual(h.calls[0].body.schedules.map(r=>r.id),Array.from({length:50},(_,i)=>resource(i)))
  assert.equal((await h.db.schedules.get(resource(50))).dirty,1)
  assert.equal(Object.hasOwn(result,"complete"),false)
})
for(const mode of ["malformed_queue","foreign_queue","malformed_conflicts"]){
  test(`${mode} fails closed before any request`,async()=>{
    const h=await harness();await h.db.schedules.put(schedule())
    await h.db.meta.put(mode==="malformed_conflicts"?{key:"scheduleConflicts",value:"bad"}:{key:"scheduleConversions",value:mode==="foreign_queue"?[intent({ownerUserId:"other"})]:"bad"})
    const before=state(h);assert.equal((await h.coordinator.runOnce()).stopped,true);assert.equal(h.calls.length,0);assert.equal(state(h),before)
  })
}
test("successful conversion ACK remembers a scoped terminal baseline for later source deletion",async()=>{
  const h=await harness(),first=entry({title:"预简",content:content("计划"),contentText:"计划",clientUpdatedAt:FIRST})
  await h.db.schedules.put(terminal({clientUpdatedAt:FIRST}));await h.db.entries.put(first)
  await h.db.meta.put({key:"scheduleConversions",value:[intent({entry:first,ownerUserId:"account-a"})]})
  const c=h.load("db/scheduleConversionSyncRepo.ts").createInternalScheduleConversionConsumer({
    pushSource:async()=>({interrupted:false,schedules:[{index:0,id:ID,status:"applied",reason:"replayed",submitted_client_updated_at:AT,current:wire(schedule())}]}),
    convert:async()=>({confirmed:true,created:true,reason:"applied",first_entry_date:first.entryDate,first_entry_deleted:false,
      schedule:wire(terminal({clientUpdatedAt:FIRST})),entry:{id:ID,from_schedule_id:ID,entry_date:first.entryDate,sort_order:0,title:first.title,
        content:first.content,content_text:first.contentText,mood:null,weather:null,tag_ids:[],client_updated_at:FIRST,deleted_at:null,created_at:AT,updated_at:SERVER},entry_state:"active"}),
  })
  assert.equal((await c.consumeOne(ID)).kind,"confirmed")
  assert.equal((await h.db.meta.get(prefix+ID)).value.source.status,"converted")
  const row=await h.db.schedules.get(ID)
  await h.db.schedules.put({...row,isDeleted:1,deletedAt:SERVER,clientUpdatedAt:SERVER,dirty:1})
  assert.equal((await h.coordinator.runOnce()).items[0].kind,"confirmed")
  assert.equal(h.calls[0].body.schedules[0].expected_schedule_client_updated_at,FIRST)
})
test("real push protocol factory uses pinned generation but stays outside ordinary runSync",async()=>{
  const h=await harness(),net=networkHarness(async(_u,body)=>({status:200,data:{code:0,data:reply(h,body)}}))
  h.mocks["@/api/tokenStore"]=net.tokens;h.mocks["./tokenStore"]=net.tokens;h.mocks["./request"]=net.api
  const push=h.load("shared/schedulePush.ts");h.mocks["@/shared/schedulePush"]=push
  const transport=h.load("api/schedulePushTransport.ts").createSchedulePushTransport()
  const coordinator=h.load("db/schedulePushRepo.ts").createInternalSchedulePushCoordinator(transport)
  await h.db.schedules.put(schedule());assert.equal(net.calls.length,0)
  assert.equal((await coordinator.runOnce()).items[0].kind,"confirmed")
  assert.equal(net.calls[0]._syncOwner,"account-a");assert.equal(net.calls[0]._tokenGeneration,0)
  const fs=require("node:fs"),path=require("node:path")
  for(const f of ["repo/index.ts","api/sync.ts"]){assert.equal(fs.readFileSync(path.join(__dirname,"../src",f),"utf8").includes("schedulePushRepo"),false)}
})

test("a restored local server stamp cannot be rolled back even without a current epoch cache",async()=>{
  const h=await harness();await h.db.schedules.put(schedule({serverUpdatedAt:"2026-10-08T10:00:03.000Z"}))
  const result=await h.coordinator.runOnce()
  assert.equal(result.items[0].reason,"older_server_state");assert.equal(await h.db.meta.get(prefix+ID),undefined)
  assert.equal((await h.db.schedules.get(ID)).serverUpdatedAt,"2026-10-08T10:00:03.000Z")
})
test("a terminal success echo that changes immutable conversion time is quarantined",async()=>{
  const h=await harness({response:r=>{r.schedules[0].current.converted_at=SERVER;return r}})
  await h.baseline(terminal());await h.db.schedules.put(terminal({clientUpdatedAt:FIRST,isDeleted:1,deletedAt:FIRST}))
  const result=await h.coordinator.runOnce()
  assert.equal(result.items[0].kind,"conflict");assert.equal((await h.db.schedules.get(ID)).dirty,1)
  assert.equal((await h.db.meta.get(prefix+ID)).value.source.clientUpdatedAt,AT)
})
test("unsupported pending body is held while unknown terminal body can be deleted without stripping it",async()=>{
  const unknown={schemaVersion:99,doc:{type:"doc",content:[{type:"futureNode",attrs:{value:"keep"}}]}}
  const h=await harness();await h.db.schedules.put(schedule({content:unknown}))
  assert.equal((await h.coordinator.runOnce()).items[0].kind,"held");assert.equal(h.calls.length,0)
  await h.db.schedules.put(terminal({content:unknown,clientUpdatedAt:FIRST,isDeleted:1,deletedAt:FIRST}))
  await h.baseline(terminal({content:unknown}))
  assert.equal((await h.coordinator.runOnce()).items[0].kind,"confirmed")
  assert.deepEqual((await h.db.schedules.get(ID)).content,unknown)
})
test("stale previous-epoch server cache stays unusable after restore",async()=>{
  const h=await harness();await h.baseline(terminal())
  await h.db.meta.put({key:"ownerGeneration",value:"new-epoch"})
  await h.db.schedules.put(terminal({clientUpdatedAt:FIRST}))
  const result=await h.coordinator.runOnce()
  assert.equal(result.items[0].reason,"missing_server_base");assert.equal(h.calls.length,0)
  assert.equal((await h.db.meta.get(prefix+ID)).value.generation,"epoch")
})
