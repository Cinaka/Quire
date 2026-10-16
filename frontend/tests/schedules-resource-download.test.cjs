const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto")
const {ID,OTHER_ID,AT,terminal,entry,intent,setup}=require("./schedules-data-harness.cjs")
const SECOND="019a0300-1234-7000-8000-000000000004",EXTRA="019a0300-1234-7000-8000-000000000003",SERVER="2026-10-08T10:00:02.000Z",ARCHIVE="scheduleResourceRepairs"
const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),thumb=Buffer.from([137,80,78,71,13,10,26,10,4,5])
const blob=value=>new Blob([value],{type:"image/png"}),sha=value=>crypto.createHash("sha256").update(value).digest("hex")
const image=()=>({schemaVersion:1,doc:{type:"doc",content:[{type:"image",attrs:{src:`local://media/${OTHER_ID}`}}]}})
function sourceWire(r){return {id:r.id,remind_date:r.remindDate,title:r.title,content:r.content,content_text:r.contentText,status:r.status,converted_entry_id:r.convertedEntryId,converted_at:r.convertedAt,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
function entryWire(r){return {id:r.id,from_schedule_id:r.fromScheduleId,entry_date:r.entryDate,sort_order:r.sortOrder,title:r.title,content:r.content,content_text:r.contentText,mood:r.mood,weather:r.weather,tag_ids:r.tagIds,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
const all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
const meta=async(h,key)=>(await h.db.meta.get(key))?.value
async function fixture(options={}){
 const h=setup({}, {crypto:crypto.webcrypto,AbortController});h.mocks["@/api/tokenStore"]=h.tokens;h.options=options;h.calls=[];h.waits=0;h.reads=0
 const wait=async promise=>{h.waits++;if(options.waitFail){await promise;throw Error("wait timeout")}return promise}
 h.mocks["./schema"].waitForScheduleResourceBytes=wait;h.mocks["@/db/schema"].waitForScheduleResourceBytes=wait
 await h.db.meta.put({key:"ownerUserId",value:"account-a"});await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
 const current=entry({title:"当前受保护日记",content:image()})
 if(options.multi)current.content.doc.content.push({type:"image",attrs:{src:`local://media/${SECOND}`}})
 await h.db.schedules.put(terminal());await h.db.entries.put(current)
 await h.db.meta.put({key:"scheduleConversions",value:[intent({ownerUserId:"account-a"})]})
 await h.db.meta.put({key:"scheduleConflicts",value:[{scheduleId:ID,kind:"conversion-entry",localEntry:current,serverEntry:current},{scheduleId:EXTRA,kind:"keep-other"}]})
 const media={id:OTHER_ID,entryId:ID,blob:blob(bytes),thumbBlob:options.noThumb?null:blob(thumb),mime:"image/png",width:2,height:1,size:bytes.length,sortOrder:0,createdAt:AT,dirty:0,remoteUrl:"https://private/original",thumbRemoteUrl:options.noThumb?"":"https://private/thumb"}
 await h.db.media.put(media)
 if(options.multi)await h.db.media.put({...media,id:SECOND})
 const exported=await h.load("db/scheduleResourceEvidenceRepo.ts").createInternalScheduleResourceEvidenceExporter().export(ID);assert.equal(exported.ready,true)
 h.evidence=exported.evidence;h.fileText=h.load("shared/scheduleResourceEvidence.ts").serializeScheduleResourceEvidence(h.evidence)
 h.file={get size(){return new Blob([h.fileText]).size},async text(){h.reads++;if(options.duringRead)await options.duringRead(h,h.reads);if(options.readFail)throw Error("file read");return h.fileText}}
 const missing=options.missing??"row"
 if(missing==="row"){await h.db.media.delete(OTHER_ID);if(options.multi)await h.db.media.delete(SECOND)}
 else if(missing!=="neither"){const row=await h.db.media.get(OTHER_ID);if(["original","both","original-with-thumb"].includes(missing))row.blob=blob([]);if(["thumbnail","both"].includes(missing))row.thumbBlob=null;await h.db.media.put(row)}
 h.reply={read_only:true,resolution_enabled:false,proof_scope:"current_entry_resources",resource_state:"verified",resources_complete:true,
 review:{read_only:true,reviewable:true,reason:"terminal_review",receipt_known:true,first_entry_date:"2026-10-07",first_entry_deleted:false,schedule:sourceWire(terminal()),entry:entryWire(current),entry_state:"active"},media_ids:[OTHER_ID],tag_ids:[],
 media:[{id:OTHER_ID,entry_id:ID,sort_order:0,width:2,height:1,size:bytes.length,created_at:SERVER,original:{state:"verified",size:bytes.length,sha256:sha(bytes),mime:"image/png"},thumbnail:options.noThumb?{state:"not_present",size:null,sha256:null,mime:null}:{state:"verified",size:thumb.length,sha256:sha(thumb),mime:"image/png"}}],tags:[],missing_media_ids:[],missing_tag_ids:[]}
 if(options.multi){h.reply.media_ids.push(SECOND);h.reply.media.push({...structuredClone(h.reply.media[0]),id:SECOND})}
 h.transport={async review(id,lease){h.calls.push({id,lease});if(options.duringGet)await options.duringGet(h,h.calls.length);if(options.networkFail)throw Error("network");return h.reply}}
 h.imageCalls=[]
 h.transport.image=async(id,mediaId,variant,proof,lease,signal)=>{
  h.imageCalls.push({id,mediaId,variant,proof,lease,signal})
  if(options.duringImage)await options.duringImage(h,h.imageCalls.length)
  if(options.imageFail)throw Error("image network")
  const body=variant==="original"?bytes:thumb
  const wire={read_only:true,resolution_enabled:false,proof_scope:"current_entry_image_bytes",schedule_id:id,media_id:mediaId,
   variant,size:body.length,mime:"image/png",sha256:sha(body),data_base64:body.toString("base64")}
  if(options.mutateImage)options.mutateImage(wire)
  return wire
 }
 h.repairer=h.load("db/scheduleResourceRepairRepo.ts").createInternalScheduleCloudResourceRepairer(h.transport)
 h.conflict=h.load("db/scheduleResourceConflictRepo.ts").createInternalScheduleResourceConflictResolver(h.transport)
 h.prepare=()=>h.repairer.prepare(ID,options.multi?[OTHER_ID,SECOND]:[OTHER_ID])
 return h
}

for(const missing of ["row","original","thumbnail","both","original-with-thumb"])test(`cloud download ${missing} fills only missing slots after a separate confirmation`,async()=>{
 const h=await fixture({missing}),before=all(h),old=await h.db.media.get(OTHER_ID),entryBefore=await h.db.entries.get(ID),sourceBefore=await h.db.schedules.get(ID)
 const queue=await meta(h,"scheduleConversions"),conflicts=await meta(h,"scheduleConflicts"),r=await h.prepare()
 assert.equal(r.ready,true);assert.equal(all(h),before);assert.equal(h.reads,0);assert.equal(h.calls.length,2)
 assert.deepEqual(h.imageCalls.map(c=>c.variant),missing==="thumbnail"?["thumbnail"]:["original","thumbnail"].filter(v=>v==="original"||missing!=="original-with-thumb"&&missing!=="original"))
 assert.equal((await h.repairer.repair(r.reviewId,false)).repaired,false);assert.equal(all(h),before)
 const done=await h.repairer.repair(r.reviewId,true);assert.equal(done.repaired,true)
 const saved=await h.db.media.get(OTHER_ID);assert.deepEqual(Buffer.from(await saved.blob.arrayBuffer()),bytes);assert.deepEqual(Buffer.from(await saved.thumbBlob.arrayBuffer()),thumb)
 if(old){for(const key of Object.keys(old).filter(k=>!["blob","thumbBlob"].includes(k)))assert.deepEqual(saved[key],old[key]);if(missing==="thumbnail")assert.deepEqual(saved.blob,old.blob);if(["original","original-with-thumb"].includes(missing))assert.deepEqual(saved.thumbBlob,old.thumbBlob)}
 assert.deepEqual(await h.db.entries.get(ID),entryBefore);assert.deepEqual(await h.db.schedules.get(ID),sourceBefore)
 assert.deepEqual(await meta(h,"scheduleConversions"),queue);assert.deepEqual(await meta(h,"scheduleConflicts"),conflicts)
 assert.equal(h.calls.length,4);assert.equal((await meta(h,ARCHIVE))[0].kind,"missing-resource-from-cloud")
 assert.equal((await meta(h,ARCHIVE))[0].fileEvidence,undefined);assert.equal(h.reads,0)
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,false)
})
test("no thumbnail is requested or invented when current cloud proof says not_present",async()=>{
 const h=await fixture({noThumb:true}),r=await h.prepare();assert.equal(r.ready,true);assert.deepEqual(h.imageCalls.map(c=>c.variant),["original"])
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,true);assert.equal((await h.db.media.get(OTHER_ID)).thumbBlob,null)
})
for(const field of ["schedule_id","media_id","variant","proof_scope","read_only","resolution_enabled","size","mime","sha256","data_base64","extra","missing"])test(`download rejects malformed ${field} without any write`,async()=>{
 const h=await fixture({mutateImage:r=>{if(field==="missing")delete r.size;else r[field]=field==="data_base64"?Buffer.alloc(bytes.length,7).toString("base64"):"wrong"}}),before=all(h)
 assert.equal((await h.prepare()).ready,false);assert.equal(all(h),before);assert.equal(await meta(h,ARCHIVE),undefined)
})
for(const mode of ["account","relogin","epoch","entry","source","candidate","local-bytes","cloud-proof","cloud-title","tag","image-failure"])test(`download boundary ${mode} invalidates entire in-memory plan`,async()=>{
 const h=await fixture({imageFail:mode==="image-failure",duringImage:async(h,n)=>{if(n!==1)return
  if(mode==="account")h.user("account-b");if(mode==="relogin"){h.user("account-b");h.user("account-a")}
  if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"new epoch"})
  if(["entry","source"].includes(mode)){const table=mode==="entry"?h.db.entries:h.db.schedules,row=await table.get(ID);row.title="changed";await table.put(row)}
  if(mode==="candidate"){const rows=await meta(h,"scheduleConflicts");rows[0].localEntry.title="changed";await h.db.meta.put({key:"scheduleConflicts",value:rows})}
  if(mode==="local-bytes")await h.db.media.put({id:OTHER_ID,entryId:ID,blob:blob(bytes),thumbBlob:blob(thumb),mime:"image/png",width:2,height:1,size:bytes.length,sortOrder:0,createdAt:AT,dirty:1,remoteUrl:""})
  if(mode==="cloud-proof")h.reply.media[0].original.sha256="0".repeat(64)
  if(mode==="cloud-title")h.reply.review.entry.title="changed remote"
  if(mode==="tag")h.reply.tags.push({unknown:"changed"})
 }}),r=await h.prepare();assert.equal(r.ready,false);assert.equal(await meta(h,ARCHIVE),undefined);assert.equal((await meta(h,"scheduleConversions")).length,1)
 if(!["local-bytes"].includes(mode))assert.equal(await h.db.media.get(OTHER_ID),undefined)
})
for(const mode of ["empty","duplicate","unprotected","complete","existing-different","owner"])test(`unsafe ${mode} selection cannot start a byte download`,async()=>{
 const h=await fixture({missing:mode==="complete"?"neither":mode==="existing-different"?"thumbnail":"row"})
 if(mode==="existing-different"){const row=await h.db.media.get(OTHER_ID);row.blob=blob(Buffer.alloc(bytes.length,8));await h.db.media.put(row)}
 if(mode==="owner")h.user("account-b")
 const before=all(h),selected=mode==="empty"?[]:mode==="duplicate"?[OTHER_ID,OTHER_ID]:mode==="unprotected"?[EXTRA]:[OTHER_ID]
 assert.equal((await h.repairer.prepare(ID,selected)).ready,false);assert.equal(h.imageCalls.length,0);assert.equal(all(h),before)
})
for(const failure of ["media","meta"])test(`cloud batch ${failure} failure rolls back every new byte and audit`,async()=>{
 const h=await fixture({multi:true}),r=await h.prepare();assert.equal(r.ready,true);const before=all(h);h.failNext(failure)
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,false);assert.equal(all(h),before)
})
test("cancel aborts image request, keeps busy until it settles, and discards the downloaded prefix",async()=>{
 let start,release;const began=new Promise(r=>start=r),gate=new Promise(r=>release=r)
 const h=await fixture({duringImage:async(h,n)=>{if(n===2){start();await gate}}}),before=all(h),pending=h.prepare();await began
 h.repairer.cancel();assert.equal(h.imageCalls[1].signal.aborted,true);assert.equal((await h.prepare()).reason,"busy")
 release();assert.equal((await pending).reason,"cancelled_recheck");assert.equal(all(h),before);assert.equal(await meta(h,ARCHIVE),undefined)
})
for(const when of [3,4])test(`cloud changes at confirmation review ${when} cannot write cached downloaded bytes`,async()=>{
 const h=await fixture({duringGet:async(h,n)=>{if(n===when)h.reply.review.entry.title="new server"}}),r=await h.prepare(),before=all(h)
 assert.equal((await h.repairer.repair(r.reviewId,true)).reason,"server_changed_reopen");assert.equal(all(h),before)
})
test("final transaction cancellation rolls back cloud bytes and audit",async()=>{
 const h=await fixture(),r=await h.prepare(),before=all(h),put=h.db.media.add.bind(h.db.media)
 h.db.media.add=async row=>{await put(row);h.repairer.cancel()}
 assert.equal((await h.repairer.repair(r.reviewId,true)).reason,"cancelled_recheck");assert.equal(all(h),before)
})
test("download preparation is not registered in formal routes, repo or the isolated demo",()=>{
 const fs=require("node:fs"),path=require("node:path")
 for(const file of ["repo/index.ts","router/index.ts","api/sync.ts","resource-acceptance/ResourceAcceptancePage.vue"])
  assert.equal(fs.readFileSync(path.join(__dirname,"../src",file),"utf8").includes("createInternalScheduleCloudResourceRepairer"),false)
})
for(const mode of ["bad-signature","noncanonical","different-bytes","upper-hash"])test(`image validator rejects ${mode} independently of transport`,async()=>{
 const h=await fixture(),body=mode==="bad-signature"?Buffer.alloc(bytes.length,6):bytes
 const proof={state:"verified",size:body.length,mime:"image/png",sha256:sha(body)}
 const r={read_only:true,resolution_enabled:false,proof_scope:"current_entry_image_bytes",schedule_id:ID,media_id:OTHER_ID,variant:"original",size:body.length,mime:"image/png",sha256:proof.sha256,data_base64:body.toString("base64")}
 if(mode==="noncanonical")r.data_base64=r.data_base64.slice(0,-2)+"N="
 if(mode==="different-bytes")r.data_base64=Buffer.alloc(bytes.length,8).toString("base64")
 if(mode==="upper-hash")r.sha256=r.sha256.toUpperCase()
 await assert.rejects(h.load("io/scheduleResourceImageDownload.ts").validateScheduleResourceImage(r,ID,OTHER_ID,"original",proof))
})
test("whole-batch 16MiB budget is checked before any image request",async()=>{
 const h=await fixture({multi:true}),cloud=h.load("shared/scheduleCloudResources.ts").parseScheduleCloudResourceReview(h.reply,ID)
 for(const row of cloud.media){row.original.size=9*1024*1024;row.size=row.original.size}
 await assert.rejects(h.load("io/scheduleResourceImageDownload.ts").downloadScheduleResourceImages(ID,cloud,[OTHER_ID,SECOND].map(mediaId=>({mediaId,createRow:true,fillOriginal:true,fillThumbnail:true})),[],h.transport,{ownerUserId:"account-a",generation:"epoch",tokenGeneration:0},new AbortController().signal,async()=>{}),/16MiB/)
 assert.equal(h.imageCalls.length,0)
})
test("explicit selection is copied before captureSyncContext can yield",async()=>{
 const h=await fixture(),selected=[OTHER_ID],transaction=h.db.transaction;let changed=false
 h.db.transaction=async function(...args){if(!changed&&args[0]==="r"){changed=true;selected.splice(0,1,EXTRA)}return transaction.apply(this,args)}
 const r=await h.repairer.prepare(ID,selected);assert.equal(r.ready,true);assert.equal(selected[0],EXTRA)
 assert.deepEqual(h.imageCalls.map(call=>call.mediaId),[OTHER_ID,OTHER_ID]);assert.equal(r.steps[0].mediaId,OTHER_ID)
})
