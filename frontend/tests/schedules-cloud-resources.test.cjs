const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto")
const {ID,OTHER_ID,AT,schedule,terminal,entry,intent,setup}=require("./schedules-data-harness.cjs")
const {networkHarness}=require("./schedules-network-harness.cjs")
const TAG="019a0300-1234-7000-8000-000000000003",SERVER="2026-10-08T10:00:02.000Z"
const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from("local and cloud bytes")]),SHA=crypto.createHash("sha256").update(bytes).digest("hex")
const image={schemaVersion:1,doc:{type:"doc",content:[{type:"image",attrs:{src:`local://media/${OTHER_ID}`}}]}}
function sourceWire(r){return {id:r.id,remind_date:r.remindDate,title:r.title,content:r.content,content_text:r.contentText,status:r.status,
 converted_entry_id:r.convertedEntryId,converted_at:r.convertedAt,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
function entryWire(r){return {id:r.id,from_schedule_id:r.fromScheduleId,entry_date:r.entryDate,sort_order:r.sortOrder,title:r.title,content:r.content,
 content_text:r.contentText,mood:r.mood,weather:r.weather,tag_ids:r.tagIds,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
function reply(){const current=entry({content:structuredClone(image),tagIds:[TAG]});return {
 read_only:true,resolution_enabled:false,proof_scope:"current_entry_resources",resource_state:"verified",resources_complete:true,
 review:{read_only:true,reviewable:true,reason:"terminal_review",receipt_known:true,first_entry_date:"2026-10-07",first_entry_deleted:false,
 schedule:sourceWire(terminal()),entry:entryWire(current),entry_state:"active"},media_ids:[OTHER_ID],tag_ids:[TAG],
 media:[{id:OTHER_ID,entry_id:ID,sort_order:0,width:2,height:1,size:bytes.length,created_at:AT.slice(0,-1),
 original:{state:"verified",size:bytes.length,sha256:SHA,mime:"image/png"},thumbnail:{state:"not_present",size:null,sha256:null,mime:null}}],
 tags:[{id:TAG,name:"云端标签",color:"green",created_at:AT}],missing_media_ids:[],missing_tag_ids:[]}}
async function fixture(options={}){
 const h=setup();h.mocks["@/api/tokenStore"]=h.tokens;let calls=0;h.reply=reply()
 await h.db.meta.put({key:"ownerUserId",value:"account-a"});await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
 await h.db.schedules.put(terminal());const current=entry({content:structuredClone(image),tagIds:[TAG]});await h.db.entries.put(current)
 await h.db.meta.put({key:"scheduleConversions",value:[intent({ownerUserId:"account-a"})]});await h.db.meta.put({key:"scheduleConflicts",value:[{scheduleId:ID,kind:"conversion-entry",localEntry:current,serverEntry:current}]})
 await h.db.tags.put({id:TAG,name:"本机标签",color:"blue",createdAt:AT,dirty:1})
 await h.db.media.put({id:OTHER_ID,entryId:ID,blob:new Blob([bytes],{type:"image/png"}),thumbBlob:null,mime:"image/png",width:2,height:1,size:bytes.length,sortOrder:0,remoteUrl:"",createdAt:AT,dirty:1})
 const transport={async review(id,lease){calls++;if(options.duringGet)await options.duringGet(h);if(options.fail)throw new Error("private server");return h.reply}}
 return {...h,reviewer:h.load("db/scheduleCloudResourceReviewRepo.ts").createInternalScheduleCloudResourceReviewer(transport),parser:h.load("shared/scheduleCloudResources.ts").parseScheduleCloudResourceReview,calls:()=>calls,transport}
}
const all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
test("current hashes and changed cloud tag definitions are read-only evidence, never adopted or confirmed",async()=>{
 const h=await fixture(),before=all(h),r=await h.reviewer.review(ID)
 assert.equal(r.ready,true);assert.equal(r.server.media[0].original.sha256,SHA);assert.equal(r.server.tags[0].name,"云端标签")
 assert.equal(r.local.tags[0].name,"本机标签");assert.equal(r.resolutionEnabled,false);assert.equal(all(h),before);assert.equal(h.calls(),1)
})
for(const mode of ["source-id","media-id","media-owner","tag-id","url","private-root","private-review","private-tag","proof-scope","resolution","bad-hash","uppercase-hash","fake-unavailable-hash","original-not-present","wrong-size","bad-time","missing-id","duplicate","wrong-refs","false-complete","tag-name","tag-color","byte-limit"]){
 test(`protocol ${mode} fails closed without writing local resources or queue`,async()=>{
  const h=await fixture(),r=h.reply
  if(mode==="source-id")r.review.schedule.id=OTHER_ID;if(mode==="media-id")r.media[0].id=ID;if(mode==="media-owner")r.media[0].entry_id=OTHER_ID;if(mode==="tag-id")r.tags[0].id=OTHER_ID
  if(mode==="url")r.media[0].url="https://private?token=secret";if(mode==="private-root")r.user_id="private";if(mode==="private-review")r.review.confirmed=true;if(mode==="private-tag")r.tags[0].user_id="private"
  if(mode==="proof-scope")r.proof_scope="first_intent_confirmed";if(mode==="resolution")r.resolution_enabled=true
  if(mode==="bad-hash")r.media[0].original.sha256="wrong";if(mode==="uppercase-hash")r.media[0].original.sha256=SHA.toUpperCase()
  if(mode==="fake-unavailable-hash")r.media[0].original.state="unavailable";if(mode==="original-not-present")r.media[0].original.state="not_present"
  if(mode==="wrong-size")r.media[0].size++;if(mode==="bad-time")r.tags[0].created_at="2026-02-30T00:00:00Z"
  if(mode==="missing-id")r.missing_media_ids=[OTHER_ID];if(mode==="duplicate")r.media.push(r.media[0])
  if(mode==="wrong-refs")r.media_ids=[];if(mode==="false-complete")r.resources_complete=false
  if(mode==="tag-name")r.tags[0].name="x".repeat(33);if(mode==="tag-color")r.tags[0].color="x".repeat(17)
  if(mode==="byte-limit"){r.media[0].size=r.media[0].original.size=10*1024*1024;r.media[0].thumbnail={state:"verified",size:10*1024*1024,sha256:SHA,mime:"image/png"}}
  const before=all(h);assert.throws(()=>h.parser(r,ID));assert.equal((await h.reviewer.review(ID)).ready,false);assert.equal(all(h),before)
 })
}
for(const mode of ["missing-media","missing-tag","unavailable-bytes","missing-thumbnail","purged","unsupported","unknown-receipt"]){
 test(`${mode} remains a diagnostic read, never unlocks conversion`,async()=>{
  const h=await fixture(),r=h.reply
  if(mode==="missing-media"){r.media=[];r.missing_media_ids=[OTHER_ID]}
  if(mode==="missing-tag"){r.tags=[];r.missing_tag_ids=[TAG]}
  if(mode==="unavailable-bytes")r.media[0].original={state:"unavailable",size:null,sha256:null,mime:null}
  if(mode==="missing-thumbnail")r.media[0].thumbnail={state:"missing",size:null,sha256:null,mime:null}
  if(["purged","unsupported"].includes(mode)){r.media_ids=[];r.tag_ids=[];r.media=[];r.tags=[];r.resource_state=mode==="purged"?"no_entry":"unsupported";r.resources_complete=false
   if(mode==="purged"){r.review.entry=null;r.review.entry_state="purged"}else r.review.entry.content.schemaVersion=999
  }else if(mode!=="unknown-receipt"){r.resource_state="incomplete";r.resources_complete=false}
  if(mode==="unknown-receipt"){r.review.reason="receipt_unknown";r.review.reviewable=false;r.review.receipt_known=false;r.review.first_entry_date=null;r.review.first_entry_deleted=null}
  const before=all(h),result=await h.reviewer.review(ID);assert.equal(result.ready,true);assert.equal(result.resolutionEnabled,false);assert.equal(all(h),before)
 })
}
for(const mode of ["account","relogin","epoch","source","entry","tag","candidate","media-bytes","purge"]){
 test(`cloud read boundary ${mode} invalidates old local resource proof`,async()=>{
  const h=await fixture({duringGet:async h=>{
   if(mode==="account")h.user("account-b");if(mode==="relogin"){h.user("account-b");h.user("account-a")}
   if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"changed"})
   if(mode==="source")await h.db.schedules.put(terminal({title:"changed"}));if(mode==="entry")await h.db.entries.put(entry({title:"changed"}))
   if(mode==="tag")await h.db.tags.put({id:TAG,name:"changed",color:null,createdAt:AT,dirty:1})
   if(mode==="candidate"){const rows=(await h.db.meta.get("scheduleConflicts")).value;rows[0].localEntry.title="changed";await h.db.meta.put({key:"scheduleConflicts",value:rows})}
   if(mode==="media-bytes"){const row=await h.db.media.get(OTHER_ID);row.blob=new Blob([Buffer.alloc(bytes.length,1)],{type:"image/png"});await h.db.media.put(row)}
   if(mode==="purge")await h.db.meta.put({key:"pendingPurges",value:[ID]})
  }})
  assert.equal((await h.reviewer.review(ID)).ready,false);assert.equal((await h.db.meta.get("scheduleConversions")).value.length,1)
 })
}
test("actual pinned resource transport issues only a fixed-account GET",async()=>{
 const net=networkHarness(async()=>({status:200,data:{code:0,message:"ok",data:reply()}}))
 const result=await net.api.getPinnedScheduleResourceReview(ID,{ownerUserId:"account-a",tokenGeneration:0})
 assert.equal(result.resolution_enabled,false);assert.equal(net.calls[0].url,`/schedules/${ID}/review/resources`);assert.equal(net.calls[0]._tokenGeneration,0)
 await assert.rejects(net.api.getPinnedScheduleResourceReview(ID+"?other",{ownerUserId:"account-a",tokenGeneration:0}));assert.equal(net.calls.length,1)
})
test("late resource response is rejected after account switching",async()=>{
 let net;net=networkHarness(async()=>{net.switch("account-b");return {status:200,data:{code:0,message:"ok",data:reply()}}})
 await assert.rejects(net.api.getPinnedScheduleResourceReview(ID,{ownerUserId:"account-a",tokenGeneration:0}));assert.equal(net.calls.length,1)
})
test("resources preserve genuine microsecond creation times as read-only evidence",async()=>{
 const h=await fixture();h.reply.tags[0].created_at="2026-10-08T10:00:00.123456"
 assert.equal(h.parser(h.reply,ID).tags[0].createdAt,"2026-10-08T10:00:00.123456Z")
})
test("busy, malformed source, failures and unmounted factory never start writes or background sync",{timeout:3000},async()=>{
 let release,started;const gate=new Promise(r=>{release=r}),began=new Promise(r=>{started=r})
 const h=await fixture({duringGet:async()=>{started();await gate}}),r=h.reviewer.review(ID);await began
 assert.equal((await h.reviewer.review(ID)).reason,"busy");release();assert.equal((await r).ready,true)
 assert.equal((await h.reviewer.review("bad")).ready,false)
 const failed=await fixture({fail:true});assert.equal((await failed.reviewer.review(ID)).ready,false)
 const fs=require("node:fs"),path=require("node:path")
 for(const file of ["repo/index.ts","router/index.ts","api/sync.ts"]){assert.equal(fs.readFileSync(path.join(__dirname,"../src",file),"utf8").includes("createInternalScheduleCloudResourceReviewer"),false)}
})
test("deleted current diary resources do not change the first deleted summary or restore anything",async()=>{
 const h=await fixture();h.reply.review.entry.deleted_at=AT;h.reply.review.entry_state="deleted"
 const before=all(h),r=await h.reviewer.review(ID)
 assert.equal(r.ready,true);assert.equal(r.server.review.entryState,"deleted");assert.equal(r.server.review.firstEntryDeleted,false);assert.equal(r.resolutionEnabled,false);assert.equal(all(h),before)
})
test("real resource transport factory is lazy and uses the pinned helper without converting",async()=>{
 const net=networkHarness(async()=>({status:200,data:{code:0,message:"ok",data:reply()}}))
 const {loadTS}=require("./schedules-harness.cjs"),factory=loadTS("api/scheduleCloudResourceTransport.ts",{"./request":net.api}).createScheduleCloudResourceTransport()
 assert.equal(net.calls.length,0)
 await factory.review(ID,{ownerUserId:"account-a",tokenGeneration:0,generation:"epoch"})
 assert.equal(net.calls.length,1);assert.equal(net.calls[0].url,`/schedules/${ID}/review/resources`)
})
