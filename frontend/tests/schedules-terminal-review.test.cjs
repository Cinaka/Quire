const {test}=require("node:test"),assert=require("node:assert/strict")
const fs=require("node:fs"),path=require("node:path")
const {ID,OTHER_ID,AT,schedule,terminal,entry,intent,setup}=require("./schedules-data-harness.cjs")
const {networkHarness}=require("./schedules-network-harness.cjs")
const SERVER="2026-10-08T10:00:02.000Z"
function sourceWire(row){return {id:row.id,remind_date:row.remindDate,title:row.title,content:row.content,content_text:row.contentText,status:row.status,
  converted_entry_id:row.convertedEntryId,converted_at:row.convertedAt,client_updated_at:row.clientUpdatedAt,deleted_at:row.deletedAt,created_at:row.createdAt,updated_at:SERVER}}
function entryWire(row){return {id:row.id,from_schedule_id:row.fromScheduleId,entry_date:row.entryDate,sort_order:row.sortOrder,title:row.title,
  content:row.content,content_text:row.contentText,mood:row.mood,weather:row.weather,tag_ids:row.tagIds,client_updated_at:row.clientUpdatedAt,
  deleted_at:row.deletedAt,created_at:row.createdAt,updated_at:SERVER}}
function response(extra={}){return {read_only:true,reviewable:true,reason:"terminal_review",receipt_known:true,first_entry_date:"2026-10-09",first_entry_deleted:false,
  schedule:sourceWire(terminal()),entry:entryWire(entry()),entry_state:"active",...extra}}
const all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
async function harness(options={}){
  const h=setup(),calls=[];h.mocks["@/api/tokenStore"]=h.tokens
  await h.db.meta.put({key:"ownerUserId",value:"account-a"});await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
  await h.db.schedules.put(terminal());await h.db.entries.put(entry())
  await h.db.meta.put({key:"scheduleConversions",value:[intent({ownerUserId:"account-a"})]})
  await h.db.meta.put({key:"scheduleConflicts",value:[{scheduleId:ID,kind:"conversion-entry",localEntry:entry(),serverEntry:entry({title:"different"})}]})
  const transport={async review(id,lease){calls.push({id,lease:structuredClone(lease)})
    if(options.during)await options.during(h)
    if(options.failure)throw new Error("private token/SQL")
    return options.response??response()
  }}
  const reviewer=h.load("db/scheduleTerminalReviewRepo.ts").createInternalScheduleTerminalReviewer(transport)
  return {...h,calls,reviewer,transport}
}
test("terminal reviewer reads current evidence without ACK, conversion, merge or protection release",async()=>{
  const h=await harness(),before=all(h),r=await h.reviewer.review(ID)
  assert.equal(r.ready,true);assert.equal(r.resolutionEnabled,false);assert.equal(r.localIntentStatus,"not_checked")
  assert.equal(r.server.reviewable,true);assert.equal(r.local.intentions.length,1);assert.equal(r.local.candidates.length,1)
  assert.equal(all(h),before);assert.equal(h.calls.length,1)
  assert.equal((await h.db.meta.get("scheduleConversions")).value.length,1)
  assert.equal(await h.db.meta.get("scheduleServerState:"+ID),undefined)
})
for(const mode of ["deleted","purged","receipt_unknown","pending","invalid_state","identity_conflict"]){
  test(`${mode} is separately described without constructing or repairing diary content`,async()=>{
    const value=response()
    if(mode==="deleted"){value.entry.deleted_at=AT;value.entry_state="deleted"}
    if(mode==="purged"){value.entry=null;value.entry_state="purged"}
    if(mode==="receipt_unknown"){value.reviewable=false;value.receipt_known=false;value.reason="receipt_unknown";value.first_entry_date=null;value.first_entry_deleted=null}
    if(mode==="pending"){value.reviewable=false;value.reason="not_terminal";value.schedule=sourceWire(schedule());value.entry=null;value.entry_state="unknown";value.receipt_known=false;value.first_entry_date=null;value.first_entry_deleted=null}
    if(["invalid_state","identity_conflict"].includes(mode)){value.reviewable=false;value.reason=mode;value.schedule=null;value.entry=null;value.entry_state="unknown";value.receipt_known=false;value.first_entry_date=null;value.first_entry_deleted=null}
    const h=await harness({response:value});if(mode==="purged")await h.db.entries.delete(ID)
    const before=all(h),r=await h.reviewer.review(ID);assert.equal(r.ready,true);assert.equal(r.resolutionEnabled,false);assert.equal(all(h),before)
    if(mode==="purged"){assert.equal(r.server.entry,null);assert.equal(await h.db.entries.get(ID),undefined)}
    if(mode==="receipt_unknown")assert.equal(r.server.receiptKnown,false)
  })
}
for(const mode of ["write_flag","confirmed","private_receipt","wrong_id","wrong_link","missing_summary","guessed_summary","wrong_active","wrong_purged","wrong_reviewable","pending_proof","bad_day","bad_revision"]){
  test(`invalid proof ${mode} cannot become actionable or write a local row`,async()=>{
    const value=response()
    if(mode==="write_flag")value.read_only=false
    if(mode==="confirmed")value.confirmed=true
    if(mode==="private_receipt")value.fingerprint="must not expose"
    if(mode==="wrong_id")value.schedule.id=OTHER_ID
    if(mode==="wrong_link")value.entry.from_schedule_id=OTHER_ID
    if(mode==="missing_summary")delete value.first_entry_date
    if(mode==="guessed_summary"){value.receipt_known=false;value.reviewable=false;value.reason="receipt_unknown"}
    if(mode==="wrong_active")value.entry.deleted_at=AT
    if(mode==="wrong_purged")value.entry_state="purged"
    if(mode==="wrong_reviewable")value.reviewable=false
    if(mode==="pending_proof")value.schedule=sourceWire(schedule())
    if(mode==="bad_day")value.first_entry_date="2026-02-30"
    if(mode==="bad_revision")value.entry.updated_at="2026-02-30T10:00:00Z"
    const h=await harness({response:value}),before=all(h);assert.equal((await h.reviewer.review(ID)).ready,false);assert.equal(all(h),before)
  })
}
for(const mode of ["account","relogin","epoch","source","entry","intention","candidate","purge","draft"]){
  test(`during-read ${mode} change invalidates the old review instead of recapturing a new lease`,async()=>{
    let after;const h=await harness({during:async h=>{
      if(mode==="account")h.user("account-b")
      if(mode==="relogin"){h.user("account-b");h.user("account-a")}
      if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restored"})
      if(mode==="source")await h.db.schedules.put(terminal({title:"new source"}))
      if(mode==="entry")await h.db.entries.put(entry({title:"new local diary"}))
      if(mode==="intention")await h.db.meta.put({key:"scheduleConversions",value:[]})
      if(mode==="candidate")await h.db.meta.put({key:"scheduleConflicts",value:[]})
      if(mode==="purge")await h.db.meta.put({key:"pendingPurges",value:[ID]})
      if(mode==="draft")await h.db.meta.put({key:"scheduleDraft",value:{unsaved:"keep"}})
      after=all(h)
    }})
    assert.equal((await h.reviewer.review(ID)).ready,false);assert.equal(all(h),after);assert.equal(h.calls.length,1)
  })
}
test("unknown future body is retained as read-only evidence, not downgraded for editing",async()=>{
  const value=response();value.entry.content={schemaVersion:999,doc:{type:"doc",content:[]}}
  const h=await harness({response:value}),r=await h.reviewer.review(ID);assert.equal(r.ready,true)
  assert.equal(r.server.entry.content.schemaVersion,999);assert.equal(r.resolutionEnabled,false)
})
test("a pending purge and locally missing diary stay untouched by an active cloud preview",async()=>{
  const h=await harness();await h.db.entries.delete(ID);await h.db.meta.put({key:"pendingPurges",value:[ID]})
  const before=all(h),r=await h.reviewer.review(ID);assert.equal(r.ready,true);assert.equal(all(h),before)
  assert.equal(r.local.entry,null);assert.equal(r.server.entry.id,ID);assert.equal(r.resolutionEnabled,false)
})
for(const key of ["scheduleConversions","scheduleConflicts","pendingPurges"]){
  test(`malformed ${key} stops before any remote read and is preserved`,async()=>{
    const h=await harness();await h.db.meta.put({key,value:"keep malformed"});const before=all(h)
    assert.equal((await h.reviewer.review(ID)).ready,false);assert.equal(h.calls.length,0);assert.equal(all(h),before)
  })
}
test("busy or bad IDs do not start duplicate requests",async()=>{
  let release;const gate=new Promise(r=>release=r);const h=await harness({during:()=>gate})
  assert.equal((await h.reviewer.review("invalid")).ready,false);assert.equal(h.calls.length,0)
  const first=h.reviewer.review(ID);await new Promise(r=>setTimeout(r,20))
  assert.equal((await h.reviewer.review(ID)).reason,"busy");release();assert.equal((await first).ready,true);assert.equal(h.calls.length,1)
})
test("a failed remote read leaves all queue/candidate/diary state and returns a safe reason",async()=>{
  const h=await harness({failure:true}),before=all(h),r=await h.reviewer.review(ID)
  assert.equal(r.ready,false);assert.equal(r.reason,"review_unconfirmed");assert.equal(JSON.stringify(r).includes("private"),false);assert.equal(all(h),before)
})
for(const mode of ["success","refresh","late-account","lock"]){
  test(`actual pinned review GET ${mode} never calls convert or adopts evidence`,async()=>{
    const h=await harness();let net;net=networkHarness(async(url,_body,_config,n)=>{
      assert.equal(url,`/schedules/${ID}/review`)
      if(mode==="refresh"&&n===1)return {status:401,data:{code:401,data:null}}
      if(mode==="late-account")net.switch("account-b")
      if(mode==="lock")return {status:409,data:{code:409,message:"private SQL",data:null}}
      return {status:200,data:{code:0,data:response()}}
    })
    h.mocks["./request"]=net.api;h.mocks["./tokenStore"]=net.tokens;h.mocks["@/api/tokenStore"]=net.tokens
    const transport=h.load("api/scheduleTerminalReviewTransport.ts").createScheduleTerminalReviewTransport()
    const reviewer=h.load("db/scheduleTerminalReviewRepo.ts").createInternalScheduleTerminalReviewer(transport),before=all(h),r=await reviewer.review(ID)
    assert.equal(r.ready,["success","refresh"].includes(mode));assert.equal(all(h),before)
    assert.equal(net.calls[0]._syncOwner,"account-a");assert.equal(net.calls[0]._tokenGeneration,0)
    if(mode==="refresh")assert.equal(net.refreshes(),1)
    await assert.rejects(net.api.getPinnedScheduleReview(`${ID}/convert`,{ownerUserId:"account-a",tokenGeneration:0}))
  })
}
test("review remains internal, read-only and outside ordinary or schedule sync",()=>{
  for(const file of ["repo/index.ts","api/sync.ts","router/index.ts","db/scheduleSyncRepo.ts"]){const text=fs.readFileSync(path.join(__dirname,"../src",file),"utf8");assert.equal(text.includes("createInternalScheduleTerminalReviewer"),false)}
})
test("Python naive six-digit timestamps and P2 microseconds are preserved as read-only UTC evidence",async()=>{
  const value=response();value.schedule.updated_at="2026-10-08T10:00:02.123000"
  value.entry.updated_at="2026-10-08T18:00:02.123456+08:00";value.entry.client_updated_at="2026-10-08T10:00:00.123456"
  const h=await harness({response:value}),before=all(h),r=await h.reviewer.review(ID)
  assert.equal(r.ready,true);assert.equal(r.server.schedule.serverUpdatedAt,"2026-10-08T10:00:02.123Z")
  assert.equal(r.server.entry.serverUpdatedAt,"2026-10-08T10:00:02.123456Z")
  assert.equal(r.server.entry.clientUpdatedAt,"2026-10-08T10:00:00.123456Z")
  assert.equal(r.resolutionEnabled,false);assert.equal(all(h),before)
})
