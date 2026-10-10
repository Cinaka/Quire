const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs"), path = require("node:path")
const { ID, OTHER_ID, AT, content, schedule, entry, terminal, intent, setup } = require("./schedules-data-harness.cjs")
const FIRST = "2026-10-08T10:00:00.001Z", LATER = "2026-10-08T10:00:00.010Z", RESTORED = "2026-10-08T10:00:00.020Z"
const SERVER = "2026-10-08T10:00:02.000Z"
function wire(row) {return {id:row.id,remind_date:row.remindDate,title:row.title,content:row.content,content_text:row.contentText,
  status:row.status,converted_entry_id:row.convertedEntryId,converted_at:row.convertedAt,client_updated_at:row.clientUpdatedAt,
  deleted_at:row.deletedAt,created_at:row.createdAt,updated_at:row.serverUpdatedAt}}
function wireEntry(row) {return {id:row.id,from_schedule_id:row.fromScheduleId,entry_date:row.entryDate,sort_order:row.sortOrder,
  title:row.title,content:row.content,content_text:row.contentText,mood:row.mood,weather:row.weather,tag_ids:row.tagIds,
  client_updated_at:row.clientUpdatedAt,deleted_at:row.deletedAt,created_at:row.createdAt,updated_at:SERVER}}
const queue = async h => (await h.db.meta.get("scheduleConversions"))?.value ?? []
async function harness(options = {}) {
  const h=setup(),calls=[],cloud=new Map(),receipts=new Map();h.mocks["@/api/tokenStore"]=h.tokens
  await h.db.meta.put({key:"ownerUserId",value:"account-a"});await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
  let sequence=0,head="1000-01-01T00:00:00.000Z"
  function stamp(){head=new Date(Date.parse(SERVER)+sequence++).toISOString();return head}
  function pending(sent){return schedule({id:sent.id,title:sent.title,content:sent.content,contentText:sent.content_text,
    remindDate:sent.remind_date,clientUpdatedAt:sent.client_updated_at,deletedAt:sent.deleted_at,isDeleted:sent.deleted_at===null?0:1,
    dirty:0,createdAt:SERVER,serverUpdatedAt:stamp()})}
  const conversion={async pushSource(body){calls.push({stage:"source",body:structuredClone(body)})
    if(options.sourceFail)throw new Error("private timeout")
    const sent=body.schedules[0];let current=cloud.get(sent.id),status="applied",reason="applied"
    if(current?.status==="converted"){status="error";reason="terminal"}else{current=pending(sent);cloud.set(sent.id,current)}
    return {interrupted:false,schedules:[{index:0,id:sent.id,status,reason,submitted_client_updated_at:sent.client_updated_at,current:wire(current)}]}
  },async convert(id,body){calls.push({stage:"convert",id,body:structuredClone(body)})
    let receipt=receipts.get(id),created=!receipt
    if(!receipt){const first=body.entry,at=stamp(),source={...cloud.get(id),status:"converted",convertedEntryId:id,convertedAt:at,
      clientUpdatedAt:first.client_updated_at,serverUpdatedAt:at};cloud.set(id,source)
      receipt={first:entry({id,fromScheduleId:id,title:first.title,content:first.content,contentText:first.content_text,
        entryDate:first.entry_date,clientUpdatedAt:first.client_updated_at,deletedAt:first.deleted_at,isDeleted:first.deleted_at===null?0:1}),day:first.entry_date,deleted:first.deleted_at!==null};receipts.set(id,receipt)}
    if(options.duringConvert)await options.duringConvert(h,id)
    if(options.convertFail)throw new Error("private timeout after remote commit")
    const ack={confirmed:true,created,reason:created?"applied":"replayed",first_entry_date:receipt.day,first_entry_deleted:receipt.deleted,
      schedule:wire(cloud.get(id)),entry:wireEntry(receipt.first),entry_state:receipt.deleted?"deleted":"active"}
    return options.ack ? options.ack(ack,h) : ack
  }}
  const push={async push(body){calls.push({stage:"push",body:structuredClone(body)})
    if(options.pushFail)throw new Error("private timeout")
    const rows=body.schedules.map((sent,index)=>{let row
      if(sent.status==="converted"){const old=cloud.get(sent.id);assert.equal(sent.expected_schedule_client_updated_at,old.clientUpdatedAt)
        row={...old,clientUpdatedAt:sent.client_updated_at,deletedAt:sent.deleted_at,isDeleted:sent.deleted_at===null?0:1,serverUpdatedAt:stamp()}
      }else row=pending(sent)
      cloud.set(sent.id,row);return {index,id:sent.id,status:"applied",reason:"applied",submitted_client_updated_at:sent.client_updated_at,current:wire(row)}
    })
    if(options.duringPush)await options.duringPush(h)
    return {interrupted:false,schedules:rows}
  }}
  const pull={async pull(params){calls.push({stage:"pull",params:structuredClone(params)})
    if(options.duringPull)await options.duringPull(h)
    if(options.pullFail)throw new Error("private network error")
    if(options.page)return options.page(params,calls.filter(c=>c.stage==="pull").length)
    const until=params.until??head
    const rows=[...cloud.values()].filter(row=>row.serverUpdatedAt>=params.since&&row.serverUpdatedAt<=until&&
      (!params.after_id||row.serverUpdatedAt>params.since||row.id>params.after_id)).sort((a,b)=>a.serverUpdatedAt.localeCompare(b.serverUpdatedAt)||a.id.localeCompare(b.id))
    const more=rows.length>params.limit,selected=rows.slice(0,params.limit),last=selected.at(-1)
    return {schedules:selected.map(wire),has_more:more,server_time:more?last.serverUpdatedAt:until,sync_until:until,cursor_id:more?last.id:null}
  }}
  async function seed(id=ID){const first=entry({id,fromScheduleId:id,title:"预简",content:content("计划"),contentText:"计划",clientUpdatedAt:FIRST})
    const source=terminal({id,convertedEntryId:id,clientUpdatedAt:FIRST,convertedAt:FIRST})
    const rows=await queue(h);rows.push(intent({scheduleId:id,source:schedule({id}),entry:first,queuedAt:FIRST,ownerUserId:"account-a"}))
    await h.db.meta.put({key:"scheduleConversions",value:rows});await h.db.schedules.put(source);await h.db.entries.put(first);return {first,source}
  }
  const transports={conversion,push,pull}
  const coordinator=h.load("db/scheduleSyncRepo.ts").createInternalScheduleSyncCoordinator(transports)
  return {...h,calls,cloud,receipts,seed,transports,coordinator}
}
test("factory is inert; explicit cycle consumes, pushes and pulls in order without P2 or diary writes",async()=>{
  const h=await harness();assert.equal(h.calls.length,0);await h.seed();await h.db.schedules.put(schedule({id:OTHER_ID}))
  await h.db.meta.put({key:"lastSyncAt",value:"P2-kept"});const before=JSON.stringify(await h.db.entries.toArray())
  const r=await h.coordinator.runOnce();assert.equal(r.reason,"cycle_processed");assert.equal(r.stopped,false)
  assert.deepEqual(h.calls.map(c=>c.stage),["source","convert","push","pull"])
  assert.equal((await queue(h)).length,0);assert.equal(r.pending.dirty,0);assert.equal(r.needsAnotherRun,false)
  assert.equal(JSON.stringify(await h.db.entries.toArray()),before);assert.equal((await h.db.meta.get("lastSyncAt")).value,"P2-kept")
})
for(const mode of ["delete_before","delete_during","restore_before","restore_during"]){
  test(`first proof bridges ${mode} to sparse CAS without modifying the diary or original snapshot`,async()=>{
    const change=async h=>{const source=await h.db.schedules.get(ID);await h.db.schedules.put({...source,isDeleted:mode.startsWith("delete")?1:0,
      deletedAt:mode.startsWith("delete")?LATER:null,clientUpdatedAt:mode.startsWith("delete")?LATER:RESTORED,dirty:1})}
    const h=await harness({duringConvert:mode.endsWith("during")?change:undefined});await h.seed()
    if(mode.endsWith("before"))await change(h)
    const before=JSON.stringify(await h.db.entries.toArray()),snapshot=JSON.stringify((await queue(h))[0].entry)
    const r=await h.coordinator.runOnce();assert.equal(r.conversions[0].kind,"confirmed");assert.equal(r.conversions[0].reason,"source_revision_held")
    assert.equal((await queue(h)).length,0);assert.equal(r.push.items[0].kind,"confirmed")
    const sent=h.calls.find(c=>c.stage==="push").body.schedules[0]
    assert.deepEqual(Object.keys(sent).sort(),["id","status","client_updated_at","deleted_at","expected_schedule_client_updated_at"].sort())
    assert.equal(sent.expected_schedule_client_updated_at,FIRST);assert.equal(sent.deleted_at,mode.startsWith("delete")?LATER:null)
    assert.equal((await h.db.schedules.get(ID)).dirty,0);assert.equal((await h.db.schedules.get(ID)).isDeleted,mode.startsWith("delete")?1:0)
    assert.equal(JSON.stringify(await h.db.entries.toArray()),before)
    assert.equal(JSON.stringify(h.receipts.get(ID).first),snapshot);assert.equal(r.pending.conflicts,0)
  })
}
test("standalone ACK keeps newer deletion dirty and commits baseline plus queue removal atomically",async()=>{
  const h=await harness();await h.seed();const original=await h.db.schedules.get(ID)
  await h.db.schedules.put({...original,isDeleted:1,deletedAt:LATER,clientUpdatedAt:LATER})
  const consumer=h.load("db/scheduleConversionSyncRepo.ts").createInternalScheduleConversionConsumer(h.transports.conversion)
  assert.equal((await consumer.consumeOne(ID)).kind,"confirmed")
  const source=await h.db.schedules.get(ID);assert.equal(source.dirty,1);assert.equal(source.deletedAt,LATER);assert.equal((await queue(h)).length,0)
  assert.equal((await h.db.meta.get("scheduleServerState:"+ID)).value.source.clientUpdatedAt,FIRST)
})
test("failed first-confirm storage keeps the queue and prevents sparse source upload",async()=>{
  const h=await harness({duringConvert:async h=>h.failNext("schedules")});await h.seed()
  const r=await h.coordinator.runOnce();assert.equal(r.conversions[0].kind,"held");assert.equal((await queue(h)).length,1)
  assert.equal(h.calls.some(c=>c.stage==="push"),false);assert.equal((await h.db.schedules.get(ID)).dirty,1)
})
test("timeout after remote convert retains intent; next explicit cycle uses read-only receipt then bridges",async()=>{
  const opts={convertFail:true},h=await harness(opts);await h.seed()
  const source=await h.db.schedules.get(ID);await h.db.schedules.put({...source,isDeleted:1,deletedAt:LATER,clientUpdatedAt:LATER})
  let r=await h.coordinator.runOnce();assert.equal(r.conversions[0].kind,"held");assert.equal((await queue(h)).length,1)
  opts.convertFail=false;r=await h.coordinator.runOnce();assert.equal(r.conversions[0].kind,"confirmed");assert.equal((await queue(h)).length,0)
  assert.equal(h.receipts.size,1);assert.equal((await h.db.schedules.get(ID)).isDeleted,1)
})
for(const mode of ["revision_behind","equal_wrong_delete","changed_body","remote_new_delete"]){
  test(`unproved source ${mode} cannot release first intent`,async()=>{
    const h=await harness({ack:ack=>{if(mode==="remote_new_delete"){ack.schedule.client_updated_at=RESTORED;ack.schedule.deleted_at=RESTORED}return ack}});await h.seed()
    const s=await h.db.schedules.get(ID)
    if(mode==="revision_behind")await h.db.schedules.put({...s,clientUpdatedAt:AT})
    if(mode==="equal_wrong_delete")await h.db.schedules.put({...s,isDeleted:1,deletedAt:FIRST})
    if(mode==="changed_body")await h.db.schedules.put({...s,title:"not immutable"})
    const r=await h.coordinator.runOnce();assert.equal(r.conversions[0].kind,"held");assert.equal((await queue(h)).length,1)
    assert.equal(h.calls.some(c=>c.stage==="push"),false)
  })
}
test("conflicting intention is not replayed and unrelated pending source still progresses",async()=>{
  const h=await harness();await h.seed();await h.db.schedules.put(schedule({id:OTHER_ID}))
  await h.db.meta.put({key:"scheduleConflicts",value:[{scheduleId:ID,kind:"keep-old"}]})
  const r=await h.coordinator.runOnce();assert.equal(r.conversions.length,0);assert.equal(h.calls.some(c=>c.stage==="convert"),false)
  assert.equal(h.cloud.has(OTHER_ID),true);assert.equal((await queue(h)).length,1);assert.equal(r.needsAnotherRun,true)
  const consumer=h.load("db/scheduleConversionSyncRepo.ts").createInternalScheduleConversionConsumer(h.transports.conversion)
  const n=h.calls.length;assert.equal((await consumer.consumeOne(ID)).kind,"held");assert.equal(h.calls.length,n)
})
test("new conflict during source request prevents convert and preserves old candidate",async()=>{
  const h=await harness();await h.seed();const push=h.transports.conversion.pushSource
  h.transports.conversion.pushSource=async(...args)=>{const r=await push(...args);await h.db.meta.put({key:"scheduleConflicts",value:[{scheduleId:ID,kind:"concurrent"}]});return r}
  await h.coordinator.runOnce();assert.equal(h.calls.some(c=>c.stage==="convert"),false);assert.equal((await queue(h)).length,1)
  assert.equal((await h.db.meta.get("scheduleConflicts")).value[0].kind,"concurrent")
})
test("conversion budget processes a fixed snapshot and leaves later intentions protected",async()=>{
  const h=await harness();await h.seed();await h.seed(OTHER_ID)
  const r=await h.coordinator.runOnce({maxConversions:1});assert.equal(r.conversions.length,1);assert.equal(r.pending.conversions,1)
  assert.equal(h.calls.filter(c=>c.stage==="convert").length,1);assert.equal(r.needsAnotherRun,true)
})
test("bounded pulls preserve continuation for the next explicit cycle",async()=>{
  const h=await harness();for(let n=1;n<=4;n++){const id=`019a0300-1234-7000-8000-${String(n).padStart(12,"0")}`;await h.db.schedules.put(schedule({id}))}
  let r=await h.coordinator.runOnce({maxPullPages:1,pageLimit:1});assert.equal(r.pull.length,1);assert.equal(r.pending.pullContinuation,true)
  const first=(await h.db.meta.get("scheduleLastSyncAt")).value
  r=await h.coordinator.runOnce({maxPullPages:5,pageLimit:1});assert.equal(r.pull.length,3);assert.equal(r.pending.pullContinuation,false)
  assert.equal(h.calls.filter(c=>c.stage==="pull")[1].params.until,first.until)
})
for(const mode of ["switch_convert","relogin_push","restore_pull"]){
  test(`cycle ${mode} stops without recapturing a new lease or erasing earlier proof`,async()=>{
    const h=await harness({duringConvert:mode==="switch_convert"?async h=>h.user("account-b"):undefined,
      duringPush:mode==="relogin_push"?async h=>{h.user("account-b");h.user("account-a")}:undefined,
      duringPull:mode==="restore_pull"?async h=>h.db.meta.put({key:"ownerGeneration",value:"restored"}):undefined})
    await h.seed();await h.db.schedules.put(schedule({id:OTHER_ID}));const r=await h.coordinator.runOnce()
    assert.equal(r.stopped,true);assert.equal(r.needsAnotherRun,true)
    if(mode==="switch_convert"){assert.equal((await queue(h)).length,1);assert.equal(h.calls.some(c=>c.stage==="push"),false)}
    else {assert.equal((await queue(h)).length,0);assert.equal(r.conversions[0].kind,"confirmed")}
    assert.equal(await h.db.meta.get("scheduleLastSyncAt"),undefined)
  })
}
for(const mode of ["push","pull"]){
  test(`${mode} failure stops cycle without a hidden retry or successful-looking completion`,async()=>{
    const h=await harness({pushFail:mode==="push",pullFail:mode==="pull"});await h.db.schedules.put(schedule())
    const r=await h.coordinator.runOnce();assert.equal(r.stopped,true);assert.equal(r.needsAnotherRun,true)
    assert.equal(h.calls.filter(c=>c.stage===mode).length,1)
    if(mode==="push"){assert.equal(h.calls.some(c=>c.stage==="pull"),false);assert.equal((await h.db.schedules.get(ID)).dirty,1)}
    else assert.equal((await h.db.schedules.get(ID)).dirty,0)
  })
}
test("new local diary edits survive full source coordination",async()=>{
  const h=await harness({duringConvert:async h=>{const e=await h.db.entries.get(ID);await h.db.entries.put({...e,title:"new diary",clientUpdatedAt:LATER,dirty:1})}})
  await h.seed();const r=await h.coordinator.runOnce();assert.equal(r.conversions[0].kind,"confirmed")
  const e=await h.db.entries.get(ID);assert.equal(e.title,"new diary");assert.equal(e.clientUpdatedAt,LATER);assert.equal(e.dirty,1)
})
test("same instance is single flight and invalid budgets never issue requests",async()=>{
  let release;const gate=new Promise(r=>release=r);const h=await harness({duringPull:()=>gate})
  for(const options of [{maxConversions:0},{maxConversions:51},{maxPullPages:0},{maxPullPages:21},{pageLimit:501},{pageLimit:1.5}])assert.equal((await h.coordinator.runOnce(options)).reason,"invalid_options")
  const first=h.coordinator.runOnce();await new Promise(r=>setTimeout(r,30))
  assert.equal((await h.coordinator.runOnce()).reason,"busy");release();await first;assert.equal(h.calls.length,1)
})
for(const mode of ["queue","cursor","conflicts","errors"]){
  test(`malformed ${mode} prevents the entire cycle before first outbound work`,async()=>{
    const h=await harness();await h.seed()
    await h.db.meta.put({key:mode==="queue"?"scheduleConversions":mode==="cursor"?"scheduleLastSyncAt":mode==="errors"?"scheduleSyncErrors":"scheduleConflicts",value:"keep malformed"})
    const r=await h.coordinator.runOnce();assert.equal(r.stopped,true);assert.equal(h.calls.length,0)
  })
}
test("coordinator is not exported, routed or installed into P2 sync",()=>{
  for(const file of ["repo/index.ts","api/sync.ts","router/index.ts"]){const text=fs.readFileSync(path.join(__dirname,"../src",file),"utf8");assert.equal(text.includes("createInternalScheduleSyncCoordinator"),false)}
})
test("remote deleted terminal receipt bridges a later local restore using its actual CAS revision",async()=>{
  const opts={convertFail:true},h=await harness(opts);await h.seed();await h.coordinator.runOnce()
  const remote=h.cloud.get(ID);h.cloud.set(ID,{...remote,isDeleted:1,deletedAt:LATER,clientUpdatedAt:LATER})
  const local=await h.db.schedules.get(ID);await h.db.schedules.put({...local,isDeleted:0,deletedAt:null,clientUpdatedAt:RESTORED,dirty:1})
  opts.convertFail=false;const r=await h.coordinator.runOnce();assert.equal(r.conversions[0].kind,"confirmed")
  const sent=h.calls.find(c=>c.stage==="push").body.schedules[0];assert.equal(sent.expected_schedule_client_updated_at,LATER)
  assert.equal(sent.deleted_at,null);assert.equal((await h.db.schedules.get(ID)).isDeleted,0);assert.equal((await queue(h)).length,0)
})
test("cursor failure after confirmed upstream preserves upstream evidence and does not roll it back",async()=>{
  const h=await harness();await h.db.schedules.put(schedule());const put=h.db.meta.put
  h.db.meta.put=async row=>{if(row.key==="scheduleLastSyncAt")throw new Error("cursor write failure");return put(row)}
  const r=await h.coordinator.runOnce();assert.equal(r.stopped,true);assert.equal(r.push.items[0].kind,"confirmed")
  assert.equal((await h.db.schedules.get(ID)).dirty,0);assert.equal(await h.db.meta.get("scheduleLastSyncAt"),undefined)
  assert.ok(await h.db.meta.get("scheduleServerState:"+ID))
})
test("a new conversion outside the captured intention set is left for the next cycle",async()=>{
  let seeded=false,h;h=await harness({duringConvert:async()=>{if(!seeded){seeded=true;await h.seed(OTHER_ID)}}});await h.seed()
  const r=await h.coordinator.runOnce();assert.equal(r.conversions.length,1);assert.equal(r.pending.conversions,1)
  assert.equal(h.calls.filter(c=>c.stage==="convert").length,1);assert.equal((await queue(h))[0].scheduleId,OTHER_ID)
})
test("source clock mismatch remains dirty/held instead of silently rebasing a local revision",async()=>{
  const h=await harness({ack:ack=>{ack.schedule.client_updated_at=RESTORED;return ack}});await h.seed()
  const r=await h.coordinator.runOnce();assert.equal(r.conversions[0].reason,"source_revision_held")
  assert.equal(r.push.items[0].reason,"revision_not_ahead");assert.equal((await h.db.schedules.get(ID)).dirty,1)
  assert.equal(r.needsAnotherRun,true)
})
