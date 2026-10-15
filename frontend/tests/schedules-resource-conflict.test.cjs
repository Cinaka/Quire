const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto")
const {ID,OTHER_ID,AT,content,terminal,entry,intent,setup}=require("./schedules-data-harness.cjs")
const KEEP="cloud-source-keep-diary",CLOUD="cloud-source-use-diary",TAG="019a0300-1234-7000-8000-000000000003",EXTRA="019a0300-1234-7000-8000-000000000004"
const SERVER="2026-10-08T10:00:02.000Z",LATER="2026-10-08T10:00:01.123456Z",ARCHIVE="scheduleConflictArchive"
const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),thumb=Buffer.from([137,80,78,71,13,10,26,10,4,5,6])
const sha=b=>crypto.createHash("sha256").update(b).digest("hex"),blob=b=>new Blob([b],{type:"image/png"})
const image=()=>({schemaVersion:1,doc:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"带图片的正文"}]},{type:"image",attrs:{src:`local://media/${OTHER_ID}`}}]}})
function sourceWire(r){return {id:r.id,remind_date:r.remindDate,title:r.title,content:r.content,content_text:r.contentText,status:r.status,converted_entry_id:r.convertedEntryId,converted_at:r.convertedAt,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
function entryWire(r){return {id:r.id,from_schedule_id:r.fromScheduleId,entry_date:r.entryDate,sort_order:r.sortOrder,title:r.title,content:r.content,content_text:r.contentText,mood:r.mood,weather:r.weather,tag_ids:r.tagIds,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
const all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
const meta=async(h,key)=>(await h.db.meta.get(key))?.value
function fileHandle(options={}){
 let text="",closed=0,aborted=0
 return {get text(){return text},get closed(){return closed},get aborted(){return aborted},async getFile(){return {size:new Blob([text]).size,async text(){return options.corrupt?text+"x":text}}},async createWritable(config){assert.equal(config.mode,"exclusive");assert.equal(config.keepExistingData,false);return {async write(value){if(options.fail)throw Error("disk");text=value},async close(){closed++},async abort(){aborted++}}}}
}
async function fixture(options={}){
 const h=setup({}, {crypto:crypto.webcrypto});h.mocks["@/api/tokenStore"]=h.tokens;h.options=options;h.calls=[];h.exports=[];h.waits=0
 const wait=async promise=>{h.waits++;if(options.waitFail){await promise;throw Error("timeout")}return promise}
 h.mocks["./schema"].waitForScheduleResourceBytes=wait;h.mocks["@/db/schema"].waitForScheduleResourceBytes=wait
 await h.db.meta.put({key:"ownerUserId",value:"account-a"});await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
 const source=terminal({title:"本机首次"}),local=entry({title:"本机后来",content:image(),tagIds:[TAG]}),remote=entry({title:"云端后来",content:image(),tagIds:[TAG],clientUpdatedAt:LATER})
 await h.db.schedules.put(source);await h.db.entries.put(local)
 await h.db.tags.put({id:TAG,name:"共同标签",color:"green",createdAt:AT,dirty:1})
 await h.db.media.put({id:OTHER_ID,entryId:ID,blob:blob(bytes),thumbBlob:options.thumb?blob(thumb):null,mime:"image/png",width:2,height:1,size:bytes.length,sortOrder:0,remoteUrl:"https://private/original",thumbRemoteUrl:options.thumb?"https://private/thumb":"",createdAt:AT,dirty:1})
 const first=intent({ownerUserId:"account-a",entry:entry({title:"不可改写首次文本",content:content("首次正文")})})
 await h.db.meta.put({key:"scheduleConversions",value:[first]})
 await h.db.meta.put({key:"scheduleConflicts",value:[{scheduleId:ID,kind:"conversion-entry",localEntry:local,serverEntry:remote},{scheduleId:ID,kind:"conversion-ack",reason:"server_entry_changed",firstIntent:first,serverSchedule:terminal(),serverEntry:remote},{scheduleId:EXTRA,kind:"other-protected"}]})
 h.reply={read_only:true,resolution_enabled:false,proof_scope:"current_entry_resources",resource_state:"verified",resources_complete:true,
 review:{read_only:true,reviewable:true,reason:"terminal_review",receipt_known:true,first_entry_date:"2026-10-07",first_entry_deleted:false,schedule:sourceWire(terminal({title:"云端首次"})),entry:entryWire(remote),entry_state:"active"},media_ids:[OTHER_ID],tag_ids:[TAG],
 media:[{id:OTHER_ID,entry_id:ID,sort_order:0,width:2,height:1,size:bytes.length,created_at:SERVER,original:{state:"verified",size:bytes.length,sha256:sha(bytes),mime:"image/png"},thumbnail:options.thumb?{state:"verified",size:thumb.length,sha256:sha(thumb),mime:"image/png"}:{state:"not_present",size:null,sha256:null,mime:null}}],
 tags:[{id:TAG,name:"共同标签",color:"green",created_at:SERVER}],missing_media_ids:[],missing_tag_ids:[]}
 h.transport={async review(id,lease){h.calls.push({id,lease});if(options.duringGet)await options.duringGet(h,h.calls.length);if(options.networkFail)throw Error("private token");return h.reply}}
 h.resolver=h.load("db/scheduleResourceConflictRepo.ts").createInternalScheduleResourceConflictResolver(h.transport)
 h.preserve=async evidence=>{h.exports.push(structuredClone(evidence));if(options.duringExport)await options.duringExport(h);if(options.exportFail)throw Error("disk full")}
 h.fileIO=h.load("io/scheduleResourceConflictFile.ts");h.codec=h.load("shared/scheduleResourceConflict.ts")
 return h
}
for(const choice of [KEEP,CLOUD])for(const thumbnail of [false,true])test(`${choice} with thumbnail=${thumbnail} archives both versions and atomically hands off without touching resources`,async()=>{
 const h=await fixture({thumb:thumbnail}),before=all(h),media=await h.db.media.get(OTHER_ID),tag=await h.db.tags.get(TAG),first=structuredClone(await meta(h,"scheduleConversions"))
 const r=await h.resolver.review(ID);assert.equal(r.ready,true);assert.equal(r.choices.length,2);assert.equal(all(h),before)
 h.options.duringExport=async h=>{assert.equal((await meta(h,"scheduleConversions")).length,1);assert.equal(await meta(h,ARCHIVE),undefined)}
 const result=await h.resolver.resolve(r.reviewId,choice,true,h.preserve);assert.equal(result.applied,true);assert.equal(result.localIntentStatus,"superseded_by_explicit_choice")
 assert.equal(h.waits,1);assert.equal(h.calls.length,3);assert.equal(h.stores.entries.rows.size,1)
 const saved=await h.db.entries.get(ID);assert.equal(saved.id,ID);assert.equal(saved.title,choice===KEEP?"本机后来":"云端后来");assert.equal(saved.dirty,choice===KEEP?1:0)
 if(choice===KEEP){assert.ok(Date.parse(saved.clientUpdatedAt)>Date.parse(LATER));assert.equal(saved.serverUpdatedAt,SERVER)}else assert.equal(saved.clientUpdatedAt,LATER)
 assert.deepEqual(await h.db.media.get(OTHER_ID),media);assert.deepEqual(await h.db.tags.get(TAG),tag)
 assert.equal((await h.db.schedules.get(ID)).title,"云端首次");assert.equal((await meta(h,"scheduleConversions")).length,0)
 assert.equal((await meta(h,"scheduleConflicts")).length,1);assert.equal((await meta(h,"scheduleConflicts"))[0].scheduleId,EXTRA)
 const archive=await meta(h,ARCHIVE);assert.equal(archive[0].kind,"terminal-matched-resource-resolution");assert.equal(archive[0].evidence.local.state.intentions[0].entry.title,first[0].entry.title)
 const evidence=h.exports[0];assert.equal(evidence.local.media[0].blobBase64,bytes.toString("base64"));assert.equal(evidence.cloud.review.entry.title,"云端后来")
 for(const forbidden of ["ownerUserId","tokenGeneration","generation","https://private"])assert.equal(JSON.stringify(evidence).includes(forbidden),false)
 assert.equal(evidence.cloud.resolution_enabled,false);assert.equal(evidence.meaning,"explicit_choice_not_first_intent_confirmation")
 const protection=await h.load("db/scheduleStateRepo.ts").protectedConversions();assert.equal(protection.entryIds.has(ID),false)
 assert.equal((await h.resolver.resolve(r.reviewId,choice,true,h.preserve)).applied,false)
})
for(const mode of ["original-bytes","thumbnail-bytes","thumbnail-missing","thumbnail-unproved","tag-name","tag-color","metadata","media-owner","orphan","historical-id","protected-id","missing-bytes","missing-tag","unknown-receipt","source-deleted","purge","p2","duplicate-link","draft","diary-draft","unknown-entry","unknown-candidate"]){test(`unverified ${mode} cannot enable a choice or discard protection`,async()=>{
 const h=await fixture({thumb:true})
 if(mode==="original-bytes"||mode==="thumbnail-bytes"){const row=await h.db.media.get(OTHER_ID);row[mode==="original-bytes"?"blob":"thumbBlob"]=blob(Buffer.alloc(bytes.length,7));await h.db.media.put(row)}
 if(mode==="thumbnail-missing"){const row=await h.db.media.get(OTHER_ID);row.thumbBlob=null;await h.db.media.put(row)}
 if(mode==="thumbnail-unproved")h.reply.media[0].thumbnail={state:"not_present",size:null,sha256:null,mime:null}
 if(mode==="tag-name"||mode==="tag-color"){const row=await h.db.tags.get(TAG);row[mode==="tag-name"?"name":"color"]="different";await h.db.tags.put(row)}
 if(mode==="metadata")h.reply.media[0].width=99
 if(mode==="media-owner"||mode==="orphan"){const row=await h.db.media.get(OTHER_ID);row.entryId=mode==="orphan"?"":EXTRA;await h.db.media.put(row)}
 if(mode==="historical-id"||mode==="protected-id"){const rows=await meta(h,"scheduleConversions");rows[0].protectedMediaIds=[EXTRA];await h.db.meta.put({key:"scheduleConversions",value:rows})}
 if(mode==="missing-bytes")await h.db.media.delete(OTHER_ID)
 if(mode==="missing-tag")await h.db.tags.delete(TAG)
 if(mode==="unknown-receipt")Object.assign(h.reply.review,{receipt_known:false,reviewable:false,reason:"receipt_unknown",first_entry_date:null,first_entry_deleted:null})
 if(mode==="source-deleted"){const row=await h.db.schedules.get(ID);row.isDeleted=1;row.deletedAt=AT;await h.db.schedules.put(row)}
 if(mode==="purge")await h.db.meta.put({key:"pendingPurges",value:[ID]})
 if(mode==="p2")await h.db.meta.put({key:"conflicts",value:[{entryId:ID,at:AT,local:await h.db.entries.get(ID)}]})
 if(mode==="duplicate-link")await h.db.entries.put(entry({id:EXTRA,fromScheduleId:ID}))
 if(mode==="draft"||mode==="diary-draft")await h.db.meta.put({key:mode==="draft"?"scheduleDraft":"draft",value:{unknown:"keep"}})
 if(mode==="unknown-entry"){const row=await h.db.entries.get(ID);row.future="keep";await h.db.entries.put(row)}
 if(mode==="unknown-candidate"){const rows=await meta(h,"scheduleConflicts");rows[0].future="keep";await h.db.meta.put({key:"scheduleConflicts",value:rows})}
 const before=all(h),r=await h.resolver.review(ID);assert.equal(r.choices.length,0)
 assert.equal((await h.resolver.resolve(r.reviewId,KEEP,true,h.preserve)).applied,false);assert.equal(h.exports.length,0);assert.equal(all(h),before)
})}
for(const mode of ["confirm","preserve","review-id","choice"])test(`explicit ${mode} is mandatory`,async()=>{
 const h=await fixture(),r=await h.resolver.review(ID),before=all(h)
 assert.equal((await h.resolver.resolve(mode==="review-id"?r.reviewId+1:r.reviewId,mode==="choice"?"keep-local":KEEP,mode!=="confirm",mode==="preserve"?undefined:h.preserve)).applied,false)
 assert.equal(all(h),before);assert.equal(h.calls.length,1)
})
for(const mode of ["account","relogin","epoch","entry","source","tag","bytes","queue","candidate","draft","purge","p2","export-failure"]){test(`preservation boundary ${mode} never applies a stale choice`,async()=>{
 let changed;const h=await fixture({exportFail:mode==="export-failure",duringExport:async h=>{
  if(mode==="account")h.user("account-b");if(mode==="relogin"){h.user("account-b");h.user("account-a")}
  if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"changed"})
  if(mode==="entry"){const row=await h.db.entries.get(ID);row.title="changed";await h.db.entries.put(row)}
  if(mode==="source"){const row=await h.db.schedules.get(ID);row.title="changed";await h.db.schedules.put(row)}
  if(mode==="tag"){const row=await h.db.tags.get(TAG);row.name="changed";await h.db.tags.put(row)}
  if(mode==="bytes"){const row=await h.db.media.get(OTHER_ID);row.blob=blob(Buffer.alloc(bytes.length,9));await h.db.media.put(row)}
  if(mode==="queue"||mode==="candidate"){const key=mode==="queue"?"scheduleConversions":"scheduleConflicts",rows=await meta(h,key);rows[0][mode==="queue"?"queuedAt":"reason"]="changed";await h.db.meta.put({key,value:rows})}
  if(mode==="draft")await h.db.meta.put({key:"draft",value:{dirty:true}})
  if(mode==="purge")await h.db.meta.put({key:"pendingPurges",value:[ID]})
  if(mode==="p2")await h.db.meta.put({key:"conflicts",value:[{entryId:ID,at:AT,local:await h.db.entries.get(ID)}]})
  changed=all(h)
 }})
 const r=await h.resolver.review(ID);assert.equal(r.choices.length,2)
 assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false);assert.equal(all(h),changed);assert.equal(await meta(h,ARCHIVE),undefined)
})}
for(const when of [2,3])test(`cloud change at GET ${when} requires reopening and leaves the queue intact`,async()=>{
 const h=await fixture({duringGet:async(h,n)=>{if(n===when)h.reply.review.entry.title="changed"}}),r=await h.resolver.review(ID),before=all(h)
 const result=await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve);assert.equal(result.reason,"server_changed_reopen");assert.equal(all(h),before);assert.equal(h.exports.length,when===3?1:0)
})
for(const table of ["entries","schedules","meta"])test(`${table} failure rolls back source, diary, baseline, archive and protection`,async()=>{
 const h=await fixture(),r=await h.resolver.review(ID),before=all(h);h.failNext(table)
 assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false);assert.equal(all(h),before);assert.equal(h.exports.length,1)
})
test("foreign Blob wait failure rolls back without clearing protection",async()=>{
 const h=await fixture({waitFail:true}),r=await h.resolver.review(ID),before=all(h)
 assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false);assert.equal(h.waits,1);assert.equal(all(h),before)
})
test("final transaction rechecks actual same-size Blob bytes, not JSON Blob objects",async()=>{
 const h=await fixture(),r=await h.resolver.review(ID),transaction=h.db.transaction;let changed
 h.db.transaction=async function(...args){if(args[0]==="rw"){const row=await h.db.media.get(OTHER_ID);row.blob=blob(Buffer.alloc(bytes.length,8));await h.db.media.put(row);changed=all(h)}return transaction.apply(this,args)}
 assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false);assert.equal(h.waits,1);assert.equal(all(h),changed)
})
for(const deleted of ["local","cloud","both"])test(`deleted ${deleted} diary is never implicitly resurrected`,async()=>{
 const h=await fixture()
 if(deleted!=="cloud"){const row=await h.db.entries.get(ID);row.isDeleted=1;row.deletedAt=AT;await h.db.entries.put(row)}
 if(deleted!=="local"){h.reply.review.entry.deleted_at=AT;h.reply.review.entry_state="deleted"}
 const r=await h.resolver.review(ID);assert.equal(r.choices.length,deleted==="both"?2:1)
 assert.equal(r.choices.includes(deleted==="local"?CLOUD:KEEP),deleted==="both")
 const choice=deleted==="local"?KEEP:CLOUD;assert.equal((await h.resolver.resolve(r.reviewId,choice,true,h.preserve)).applied,true);assert.equal((await h.db.entries.get(ID)).isDeleted,1)
})
test("actual resource evidence file closes and round-trips before resolving",async()=>{
 const h=await fixture({thumb:true}),r=await h.resolver.review(ID),file=fileHandle(),save=h.fileIO.createScheduleResourceConflictFilePreserver(file)
 assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,save)).applied,true);assert.equal(file.closed,1)
 const evidence=await h.fileIO.readScheduleResourceConflictFile(await file.getFile());assert.equal(evidence.local.media[0].thumbBase64,thumb.toString("base64"));assert.equal(evidence.choice,CLOUD)
 await assert.rejects(save(evidence));assert.equal(file.closed,1)
})
for(const mode of ["write-failure","readback-corrupt"])test(`actual file ${mode} cannot release any resources`,async()=>{
 const h=await fixture(),r=await h.resolver.review(ID),before=all(h),file=fileHandle({fail:mode==="write-failure",corrupt:mode==="readback-corrupt"})
 const save=h.fileIO.createScheduleResourceConflictFilePreserver(file)
 assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,save)).applied,false);assert.equal(all(h),before)
})
for(const mode of ["unknown","intent-owner","wrong-format","wrong-choice","cloud-private","cloud-id","hash-tamper","bytes-tamper"])test(`evidence ${mode} is rejected without importing or changing any rows`,async()=>{
 const h=await fixture(),r=await h.resolver.review(ID);let evidence
 await h.resolver.resolve(r.reviewId,KEEP,true,async value=>{evidence=value;throw Error("capture only")})
 if(mode==="unknown")evidence.future=true;if(mode==="intent-owner")evidence.local.state.intentions[0].ownerUserId="private"
 if(mode==="wrong-format")evidence.format="backup";if(mode==="wrong-choice")evidence.choice="keep-local"
 if(mode==="cloud-private")evidence.cloud.user_id="private";if(mode==="cloud-id")evidence.cloud.review.entry.id=EXTRA
 if(mode==="hash-tamper")evidence.cloud.media[0].original.sha256="0".repeat(64)
 if(mode==="bytes-tamper")evidence.local.media[0].blobBase64=Buffer.alloc(bytes.length,8).toString("base64")
 const text=JSON.stringify(evidence),before=all(h)
 await assert.rejects(h.fileIO.readScheduleResourceConflictFile({size:new Blob([text]).size,async text(){return text}}));assert.equal(all(h),before)
})
test("newer known cloud baseline and malformed archive block all writes",async()=>{
 for(const mode of ["baseline","archive"]){const h=await fixture()
 if(mode==="archive")await h.db.meta.put({key:ARCHIVE,value:{unknown:true}})
 else{const lease={ownerUserId:"account-a",generation:"epoch",tokenGeneration:0},source=terminal({serverUpdatedAt:"2026-10-08T10:00:03.000Z",updatedAt:"2026-10-08T10:00:03.000Z",dirty:0});await h.load("db/scheduleSyncStateRepo.ts").rememberScheduleServerState(lease,source)}
 const r=await h.resolver.review(ID),before=all(h);assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false);assert.equal(all(h),before)
 }
})
test("unrelated queues, cursors, shared resources and dirty metadata are preserved",async()=>{
 const h=await fixture(),other=intent({scheduleId:EXTRA,source:{...intent().source,id:EXTRA},entry:entry({id:EXTRA,fromScheduleId:EXTRA}),ownerUserId:"account-a"})
 await h.db.meta.put({key:"scheduleConversions",value:[...(await meta(h,"scheduleConversions")),other]})
 for(const [key,value]of [["pendingPurges",[EXTRA]],["syncSince","opaque"],["scheduleSyncCursor","opaque2"],["conflicts",[{entryId:EXTRA,unknown:true}]]])await h.db.meta.put({key,value})
 const kept=Object.fromEntries(await Promise.all(["pendingPurges","syncSince","scheduleSyncCursor","conflicts"].map(async key=>[key,await meta(h,key)])))
 const r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,KEEP,true,h.preserve)).applied,true)
 for(const[key,value]of Object.entries(kept))assert.deepEqual(await meta(h,key),value)
 assert.deepEqual(await meta(h,"scheduleConversions"),[other])
})
test("busy/repeated invalid identity and lazy factory never start background writes",{timeout:3000},async()=>{
 let release,started;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r)
 const h=await fixture({duringGet:async()=>{started();await gate}}),pending=h.resolver.review(ID);await began
 assert.equal((await h.resolver.review(ID)).reason,"busy");release();await pending
 assert.equal((await h.resolver.review("invalid")).ready,false)
 const fs=require("node:fs"),path=require("node:path")
 for(const file of ["repo/index.ts","router/index.ts","api/sync.ts"])assert.equal(fs.readFileSync(path.join(__dirname,"../src",file),"utf8").includes("createInternalScheduleResourceConflictResolver"),false)
 const source=fs.readFileSync(path.join(__dirname,"../src/db/schema.ts"),"utf8");assert.match(source,/Dexie\.waitFor\(promise, 10000\)/)
})
for(const mode of ["tag-only","image-only"])test(`${mode} uses the same verified evidence path without inventing missing resources`,async()=>{
 const h=await fixture()
 if(mode==="tag-only"){
  await h.db.media.delete(OTHER_ID);const row=await h.db.entries.get(ID);row.content=content("只有标签");await h.db.entries.put(row)
  h.reply.review.entry.content=content("云端只有标签");h.reply.media=[];h.reply.media_ids=[]
 }else{
  const row=await h.db.entries.get(ID);row.tagIds=[];await h.db.entries.put(row);h.reply.review.entry.tag_ids=[];h.reply.tags=[];h.reply.tag_ids=[]
 }
 const candidates=await meta(h,"scheduleConflicts");for(const candidate of candidates.filter(c=>c.scheduleId===ID)){
  if(candidate.localEntry)candidate.localEntry=await h.db.entries.get(ID)
  if(candidate.serverEntry){if(mode==="tag-only")candidate.serverEntry.content=content("云端只有标签");else candidate.serverEntry.tagIds=[]}
 }
 await h.db.meta.put({key:"scheduleConflicts",value:candidates})
 const r=await h.resolver.review(ID);assert.equal(r.choices.length,2);assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,true)
 assert.equal((await h.db.entries.get(ID)).tagIds.length,mode==="tag-only"?1:0)
})
for(const when of [1,2,3])test(`pinned account switch at GET ${when} invalidates resource choices`,async()=>{
 const h=await fixture({duringGet:async(h,n)=>{if(n===when)h.user("account-b")}}),r=await h.resolver.review(ID),before=all(h)
 if(when===1)assert.equal(r.ready,false)
 else assert.equal((await h.resolver.resolve(r.reviewId,CLOUD,true,h.preserve)).applied,false)
 assert.equal(all(h),before);assert.equal(await meta(h,ARCHIVE),undefined)
})
