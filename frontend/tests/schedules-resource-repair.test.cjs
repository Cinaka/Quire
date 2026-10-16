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
 const h=setup({}, {crypto:crypto.webcrypto});h.mocks["@/api/tokenStore"]=h.tokens;h.options=options;h.calls=[];h.waits=0;h.reads=0
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
 h.repairer=h.load("db/scheduleResourceRepairRepo.ts").createInternalScheduleResourceRepairer(h.transport)
 h.conflict=h.load("db/scheduleResourceConflictRepo.ts").createInternalScheduleResourceConflictResolver(h.transport)
 h.prepare=()=>h.repairer.prepare(ID,options.multi?[OTHER_ID,SECOND]:[OTHER_ID],h.file)
 return h
}
for(const missing of ["row","original","thumbnail","both","original-with-thumb"])test(`missing ${missing} is explicitly filled without importing diary state or clearing protection`,async()=>{
 const h=await fixture({missing}),before=all(h),original=await h.db.media.get(OTHER_ID),entryBefore=await h.db.entries.get(ID),sourceBefore=await h.db.schedules.get(ID)
 const queue=await meta(h,"scheduleConversions"),conflicts=await meta(h,"scheduleConflicts"),r=await h.prepare()
 assert.equal(r.ready,true);assert.equal(r.steps.length,1);assert.equal(all(h),before);assert.equal(h.calls.length,1)
 const result=await h.repairer.repair(r.reviewId,true);assert.equal(result.repaired,true);assert.equal(result.resolutionEnabled,false);assert.equal(result.intentStatus,"unchanged_protected")
 const saved=await h.db.media.get(OTHER_ID);assert.deepEqual(Buffer.from(await saved.blob.arrayBuffer()),bytes);assert.deepEqual(Buffer.from(await saved.thumbBlob.arrayBuffer()),thumb)
 if(original){for(const key of ["id","entryId","mime","width","height","size","sortOrder","createdAt","dirty","remoteUrl","thumbRemoteUrl"])assert.deepEqual(saved[key],original[key])}
 else{assert.equal(saved.dirty,1);assert.equal(saved.createdAt,SERVER);assert.equal(saved.remoteUrl,"");assert.equal(saved.thumbRemoteUrl,"")}
 assert.deepEqual(await h.db.entries.get(ID),entryBefore);assert.deepEqual(await h.db.schedules.get(ID),sourceBefore)
 assert.deepEqual(await meta(h,"scheduleConversions"),queue);assert.deepEqual(await meta(h,"scheduleConflicts"),conflicts);assert.equal(h.waits,1);assert.equal(h.calls.length,3)
 const archive=await meta(h,ARCHIVE);assert.equal(archive[0].kind,"missing-resource-from-evidence");assert.equal(archive[0].meaning,"bytes_repaired_protection_unchanged")
 assert.equal((await h.load("db/scheduleStateRepo.ts").protectedConversions()).entryIds.has(ID),true)
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,false)
})
test("no cloud thumbnail means no thumbnail is invented",async()=>{
 const h=await fixture({noThumb:true}),r=await h.prepare();assert.equal(r.ready,true);assert.equal(r.steps[0].fillThumbnail,false)
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,true);assert.equal((await h.db.media.get(OTHER_ID)).thumbBlob,null)
})
test("after repair the conflict still requires a new review and explicit separately saved choice",async()=>{
 const h=await fixture(),old=await h.conflict.review(ID);assert.equal(old.choices.length,0)
 const r=await h.prepare();assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,true)
 assert.equal((await h.conflict.resolve(old.reviewId,"cloud-source-use-diary",true,async()=>{})).applied,false)
 const fresh=await h.conflict.review(ID);assert.equal(fresh.choices.length,2)
 assert.equal((await meta(h,"scheduleConversions")).length,1)
})
for(const mode of ["confirmed","review-id"])test(`missing ${mode} never imports resource bytes`,async()=>{
 const h=await fixture(),r=await h.prepare(),before=all(h)
 assert.equal((await h.repairer.repair(mode==="review-id"?r.reviewId+1:r.reviewId,mode!=="confirmed")).repaired,false);assert.equal(all(h),before);assert.equal(h.calls.length,1)
})
for(const mode of ["already-complete","foreign-media","orphan","metadata","existing-original-diff","existing-thumbnail-diff","evidence-original-diff","evidence-thumbnail-diff","evidence-mime","evidence-meta","missing-file-row","unknown-file","wrong-format","wrong-source","purged-file","bad-base64","duplicate-selection","empty-selection","unproved-selection","foreign-intent","unknown-candidate","p2","purge","draft","diary-draft","duplicate-link","unknown-receipt","source-deleted","missing-entry","source-watermark","entry-watermark","broken-archive"]){test(`unsafe ${mode} is rejected without changing any state`,async()=>{
 const h=await fixture({missing:mode==="already-complete"?"neither":mode==="existing-original-diff"?"thumbnail":mode==="existing-thumbnail-diff"?"original-with-thumb":"row"})
 if(["foreign-media","orphan","metadata"].includes(mode)){const row={id:OTHER_ID,entryId:mode==="foreign-media"?EXTRA:mode==="orphan"?"":ID,blob:blob([]),thumbBlob:null,mime:"image/png",width:mode==="metadata"?99:2,height:1,size:bytes.length,sortOrder:0,createdAt:AT,dirty:0,remoteUrl:""};await h.db.media.put(row)}
 if(mode==="existing-original-diff"||mode==="existing-thumbnail-diff"){const row=await h.db.media.get(OTHER_ID);row[mode==="existing-original-diff"?"blob":"thumbBlob"]=blob(Buffer.alloc(mode==="existing-original-diff"?bytes.length:thumb.length,8));await h.db.media.put(row)}
 if(mode==="evidence-original-diff")h.evidence.media[0].blobBase64=Buffer.alloc(bytes.length,8).toString("base64")
 if(mode==="evidence-thumbnail-diff")h.evidence.media[0].thumbBase64=Buffer.alloc(thumb.length,8).toString("base64")
 if(mode==="evidence-mime")h.evidence.media[0].mime="image/jpeg"
 if(mode==="evidence-meta")h.evidence.media[0].width=99
 if(mode==="missing-file-row"){h.evidence.media=[];h.evidence.missingMediaIds=[OTHER_ID];h.evidence.completeLocalResources=false}
 if(mode==="unknown-file")h.evidence.token="private";if(mode==="wrong-format")h.evidence.format="backup"
 if(mode==="wrong-source")h.evidence.scheduleId=EXTRA;if(mode==="purged-file")h.evidence.entryPendingPurge=true
 if(mode==="bad-base64")h.evidence.media[0].blobBase64="%%%"
 h.fileText=JSON.stringify(h.evidence)
 if(mode==="foreign-intent"){const rows=await meta(h,"scheduleConversions");rows[0].ownerUserId="account-b";await h.db.meta.put({key:"scheduleConversions",value:rows})}
 if(mode==="unknown-candidate"){const rows=await meta(h,"scheduleConflicts");rows[0].future="keep";await h.db.meta.put({key:"scheduleConflicts",value:rows})}
 if(mode==="p2")await h.db.meta.put({key:"conflicts",value:[{entryId:ID,at:AT,local:await h.db.entries.get(ID)}]})
 if(mode==="purge")await h.db.meta.put({key:"pendingPurges",value:[ID]})
 if(mode==="draft"||mode==="diary-draft")await h.db.meta.put({key:mode==="draft"?"scheduleDraft":"draft",value:{unknown:"keep"}})
 if(mode==="duplicate-link")await h.db.entries.put(entry({id:EXTRA,fromScheduleId:ID}))
 if(mode==="unknown-receipt")Object.assign(h.reply.review,{receipt_known:false,reviewable:false,reason:"receipt_unknown",first_entry_date:null,first_entry_deleted:null})
 if(mode==="source-deleted"){const row=await h.db.schedules.get(ID);row.isDeleted=1;row.deletedAt=AT;await h.db.schedules.put(row)}
 if(mode==="missing-entry")await h.db.entries.delete(ID)
 if(mode==="source-watermark"||mode==="entry-watermark"){const table=mode==="source-watermark"?h.db.schedules:h.db.entries,row=await table.get(ID);row.serverUpdatedAt="2026-10-08T10:00:03.000Z";await table.put(row)}
 if(mode==="broken-archive")await h.db.meta.put({key:ARCHIVE,value:{unknown:true}})
 const selected=mode==="duplicate-selection"?[OTHER_ID,OTHER_ID]:mode==="empty-selection"?[]:mode==="unproved-selection"?[EXTRA]:[OTHER_ID],before=all(h)
 const r=await h.repairer.prepare(ID,selected,h.file);assert.equal(r.ready,false);assert.equal(all(h),before)
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,false)
})}
for(const mode of ["account","relogin","epoch","entry","source","candidate","tag","purge","draft","new-row","file","file-unknown","baseline"]){test(`confirmation file boundary ${mode} retains all guards and rejects the old ticket`,async()=>{
 let after;const h=await fixture({duringRead:async(h,n)=>{if(n!==2)return
  if(mode==="account")h.user("account-b");if(mode==="relogin"){h.user("account-b");h.user("account-a")}
  if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"new epoch"})
  if(mode==="entry"||mode==="source"){const table=mode==="entry"?h.db.entries:h.db.schedules,row=await table.get(ID);row.title="changed";await table.put(row)}
  if(mode==="candidate"){const rows=await meta(h,"scheduleConflicts");rows[0].localEntry.title="changed";await h.db.meta.put({key:"scheduleConflicts",value:rows})}
  if(mode==="tag"){const row=await h.db.entries.get(ID);row.tagIds=[EXTRA];await h.db.entries.put(row)}
  if(mode==="purge")await h.db.meta.put({key:"pendingPurges",value:[ID]})
  if(mode==="draft")await h.db.meta.put({key:"draft",value:{dirty:true}})
  if(mode==="new-row")await h.db.media.put({id:OTHER_ID,entryId:ID,blob:blob(bytes),thumbBlob:blob(thumb),mime:"image/png",width:2,height:1,size:bytes.length,sortOrder:0,createdAt:AT,dirty:1,remoteUrl:""})
  if(mode==="file")h.evidence.state.entry.title="changed file"
  if(mode==="file-unknown")h.evidence.future="unknown"
  if(mode==="file"||mode==="file-unknown")h.fileText=JSON.stringify(h.evidence)
  if(mode==="baseline")await h.db.meta.put({key:"scheduleServerState:"+ID,value:{ownerUserId:"account-a",generation:"epoch",source:terminal({dirty:0,serverUpdatedAt:"2026-10-08T10:00:03.000Z",updatedAt:"2026-10-08T10:00:03.000Z"})}})
  after=all(h)
 }})
 const r=await h.prepare();assert.equal(r.ready,true);assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,false);assert.equal(all(h),after);assert.equal(await meta(h,ARCHIVE),undefined)
})}
for(const when of [1,2,3])test(`account switch at fixed-account GET ${when} never fills media under another account`,async()=>{
 const h=await fixture({duringGet:async(h,n)=>{if(n===when)h.user("account-b")}}),before=all(h),r=await h.prepare()
 if(when===1)assert.equal(r.ready,false);else assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,false)
 assert.equal(all(h),before)
})
for(const when of [2,3])test(`cloud proof changed at GET ${when} requires reopening without writes`,async()=>{
 const h=await fixture({duringGet:async(h,n)=>{if(n===when)h.reply.media[0].original.sha256="0".repeat(64)}}),r=await h.prepare(),before=all(h)
 assert.equal((await h.repairer.repair(r.reviewId,true)).reason,"server_changed_reopen");assert.equal(all(h),before)
})
for(const mode of ["media-add","media-put","archive","timeout"])test(`${mode} failure rolls back imported bytes and archive together`,async()=>{
 const h=await fixture({missing:mode==="media-put"?"both":"row",waitFail:mode==="timeout"}),r=await h.prepare(),before=all(h)
 if(mode==="media-add")h.failNext("media");if(mode==="media-put")h.failNext("media");if(mode==="archive")h.failNext("meta")
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,false);assert.equal(all(h),before);assert.equal(h.waits,1)
})
test("final transaction reads same-size thumbnail bytes even when the original is an empty placeholder",async()=>{
 const h=await fixture({missing:"original-with-thumb"}),r=await h.prepare(),transaction=h.db.transaction;let after
 h.db.transaction=async function(...args){if(args[0]==="rw"){const row=await h.db.media.get(OTHER_ID);row.thumbBlob=blob(Buffer.alloc(thumb.length,9));await h.db.media.put(row);after=all(h)}return transaction.apply(this,args)}
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,false);assert.equal(all(h),after);assert.equal(h.waits,1)
})
test("preserved bytes in a zero-original placeholder are never silently replaced",async()=>{
 const h=await fixture({missing:"original-with-thumb"}),original=await h.db.media.get(OTHER_ID),r=await h.prepare()
 assert.equal(r.steps[0].fillThumbnail,false);assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,true)
 const saved=await h.db.media.get(OTHER_ID);assert.deepEqual(saved.thumbBlob,original.thumbBlob)
})
test("unrelated queues, sync cursors, tags and P2 candidates are never imported or rewritten",async()=>{
 const h=await fixture(),values={pendingPurges:[EXTRA],conflicts:[{entryId:EXTRA,private:"keep"}],syncSince:"opaque",scheduleConflictArchive:[{keep:"archive"}]}
 for(const[key,value]of Object.entries(values))await h.db.meta.put({key,value})
 await h.db.tags.put({id:EXTRA,name:"shared local",color:"blue",createdAt:AT,dirty:1});const tag=await h.db.tags.get(EXTRA)
 const r=await h.prepare();assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,true)
 for(const[key,value]of Object.entries(values))assert.deepEqual(await meta(h,key),value)
 assert.deepEqual(await h.db.tags.get(EXTRA),tag);assert.equal(await meta(h,"scheduleServerState:"+ID),undefined)
})
for(const fail of ["read","network"])test(`${fail} failure never writes a partial repair`,async()=>{
 const h=await fixture({readFail:fail==="read",networkFail:fail==="network"}),before=all(h);assert.equal((await h.prepare()).ready,false);assert.equal(all(h),before)
})
test("busy, stale review, malformed identity and unmounted factory are safe",{timeout:3000},async()=>{
 let start,release;const began=new Promise(r=>start=r),gate=new Promise(r=>release=r)
 const h=await fixture({duringGet:async()=>{start();await gate}}),pending=h.prepare();await began
 assert.equal((await h.prepare()).reason,"busy");release();await pending
 assert.equal((await h.repairer.prepare("bad",[OTHER_ID],h.file)).ready,false)
 const fs=require("node:fs"),path=require("node:path")
 for(const file of ["repo/index.ts","router/index.ts","api/sync.ts"])assert.equal(fs.readFileSync(path.join(__dirname,"../src",file),"utf8").includes("createInternalScheduleResourceRepairer"),false)
})
test("two explicitly selected missing media are imported in a single transaction",async()=>{
 const h=await fixture({multi:true}),r=await h.prepare();assert.equal(r.ready,true);assert.equal(r.steps.length,2)
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,true)
 for(const id of [OTHER_ID,SECOND])assert.deepEqual(Buffer.from(await (await h.db.media.get(id)).blob.arrayBuffer()),bytes)
 assert.equal((await meta(h,"scheduleConversions")).length,1);assert.equal((await meta(h,ARCHIVE)).length,1)
})
test("failure on the second media addition rolls back the first addition and the archive",async()=>{
 const h=await fixture({multi:true}),r=await h.prepare(),before=all(h),add=h.db.media.add;let calls=0
 h.db.media.add=async row=>{if(++calls===2)throw Error("second image failed");return add(row)}
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,false);assert.equal(calls,2);assert.equal(all(h),before)
})
test("unselected file images are listed, not silently imported or treated as repaired",async()=>{
 const h=await fixture({multi:true}),r=await h.repairer.prepare(ID,[OTHER_ID],h.file)
 assert.equal(r.ready,true);assert.deepEqual(Array.from(r.unusedFileMediaIds),[SECOND])
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,true);assert.equal(await h.db.media.get(SECOND),undefined)
 assert.equal((await h.conflict.review(ID)).choices.length,0)
})
test("an empty thumbnail Blob is a missing slot, not permission to overwrite any nonempty bytes",async()=>{
 const h=await fixture({missing:"thumbnail"}),row=await h.db.media.get(OTHER_ID);row.thumbBlob=blob([]);await h.db.media.put(row)
 const r=await h.prepare();assert.equal(r.ready,true);assert.equal(r.steps[0].fillThumbnail,true)
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,true);assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).thumbBlob.arrayBuffer()),thumb)
})
test("a zero-original placeholder's thumbnail changing during the last GET is detected",async()=>{
 let changed;const h=await fixture({missing:"original-with-thumb",duringGet:async(h,n)=>{if(n===3){const row=await h.db.media.get(OTHER_ID);row.thumbBlob=blob(Buffer.alloc(thumb.length,7));await h.db.media.put(row);changed=all(h)}}}),r=await h.prepare()
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,false);assert.equal(all(h),changed)
})

test("a truthy nonboolean is not explicit confirmation",async()=>{
 const h=await fixture(),r=await h.prepare(),before=all(h)
 assert.equal((await h.repairer.repair(r.reviewId,"true")).repaired,false);assert.equal(all(h),before)
})
test("without a protected first intention a candidate cannot authorize importing dirty media",async()=>{
 const h=await fixture();await h.db.meta.put({key:"scheduleConversions",value:[]});const before=all(h)
 assert.equal((await h.prepare()).ready,false);assert.equal(all(h),before)
})

function compoundDocument(h,choice="cloud-source-use-diary"){
 return {app:"quire",format:"terminal-matched-resource-conflict-evidence",formatVersion:1,exportedAt:AT,scheduleId:ID,choice,
  local:structuredClone(h.evidence),cloud:structuredClone(h.reply),meaning:"explicit_choice_not_first_intent_confirmation"}
}
for(const choice of ["cloud-source-use-diary","cloud-source-keep-diary"])for(const missing of ["row","original","thumbnail","both"]){
 test(`compound file ${choice}, missing ${missing}: only bytes are repaired, never replay the archived choice`,async()=>{
  const h=await fixture({missing}),document=compoundDocument(h,choice),entryBefore=await h.db.entries.get(ID),sourceBefore=await h.db.schedules.get(ID)
  document.cloud.review.entry.title="文件里历史云端的标题，不能恢复";h.fileText=JSON.stringify(document)
  const before=all(h),r=await h.prepare();assert.equal(r.ready,true);assert.equal(all(h),before);assert.equal(r.fileFormat,document.format)
  assert.equal(r.fileStatePolicy,"bytes_only_never_replay_archived_choice_or_business_state")
  assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,true)
  assert.deepEqual(await h.db.entries.get(ID),entryBefore);assert.deepEqual(await h.db.schedules.get(ID),sourceBefore)
  assert.equal((await meta(h,"scheduleConversions")).length,1);assert.equal((await meta(h,"scheduleConflicts")).length,2)
  const archive=await meta(h,ARCHIVE);assert.equal(archive[0].fileFormat,document.format);assert.equal(archive[0].fileEvidence.choice,choice)
  assert.equal(archive[0].fileEvidence.cloud.review.entry.title,document.cloud.review.entry.title);assert.match(archive[0].fileFingerprint,/^[0-9a-f]{64}$/)
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()),bytes);assert.equal(h.reads,2)
 })
}
for(const mode of ["version","root-private","cloud-private","choice","meaning","cloud-hash","wrong-id","unknown-format","downgrade-wrapper"]){
 test(`compound ${mode} is rejected as a whole, not downgraded to its valid local bytes`,async()=>{
  const h=await fixture(),document=compoundDocument(h)
  if(mode==="version")document.formatVersion=2
  if(mode==="root-private")document.ownerUserId="foreign"
  if(mode==="cloud-private")document.cloud.user_id="foreign"
  if(mode==="choice")document.choice="keep-local"
  if(mode==="meaning")document.meaning="restore_everything"
  if(mode==="cloud-hash")document.cloud.media[0].original.sha256="0".repeat(64)
  if(mode==="wrong-id")document.scheduleId=EXTRA
  if(mode==="unknown-format")document.format="future-compound-package"
  if(mode==="downgrade-wrapper"){delete document.cloud;delete document.choice}
  h.fileText=JSON.stringify(document);const before=all(h),r=await h.prepare();assert.equal(r.ready,false);assert.equal(all(h),before)
 })
}
for(const mode of ["archived-choice","archived-cloud","export-time","format-swap"]){
 test(`only compound ${mode} changing after preview invalidates the complete document fingerprint`,async()=>{
  let after;const h=await fixture({duringRead:async(h,n)=>{if(n!==2)return;const document=JSON.parse(h.fileText)
   if(mode==="archived-choice")document.choice="cloud-source-keep-diary"
   if(mode==="archived-cloud")document.cloud.review.entry.title="另一份有效历史核对"
   if(mode==="export-time")document.exportedAt="2026-10-08T10:00:01.000Z"
   h.fileText=JSON.stringify(mode==="format-swap"?document.local:document);after=all(h)
  }})
  h.fileText=JSON.stringify(compoundDocument(h));const r=await h.prepare();assert.equal(r.ready,true)
  assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,false);assert.equal(all(h),after);assert.equal(await meta(h,ARCHIVE),undefined)
 })
}
test("an unselected image with corrupt compound SHA fails full-package verification before preview",async()=>{
 const h=await fixture({multi:true}),document=compoundDocument(h)
 document.local.media.find(row=>row.id===SECOND).blobBase64=Buffer.alloc(bytes.length,6).toString("base64")
 h.fileText=JSON.stringify(document);const before=all(h)
 assert.equal((await h.repairer.prepare(ID,[OTHER_ID],h.file)).ready,false);assert.equal(all(h),before)
})
test("an intact old compound proof never replaces the required current cloud byte proof",async()=>{
 const h=await fixture();h.fileText=JSON.stringify(compoundDocument(h));h.reply.media[0].original.sha256="0".repeat(64)
 const before=all(h);assert.equal((await h.prepare()).ready,false);assert.equal(all(h),before)
})
test("compound no-thumbnail material does not invent a thumbnail or release an intention",async()=>{
 const h=await fixture({noThumb:true});h.fileText=JSON.stringify(compoundDocument(h));const r=await h.prepare()
 assert.equal(r.ready,true);assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,true)
 assert.equal((await h.db.media.get(OTHER_ID)).thumbBlob,null);assert.equal((await meta(h,"scheduleConversions")).length,1)
})
test("compound material is a single physical read and a read-only compatibility view",async()=>{
 const h=await fixture(),document=compoundDocument(h);h.fileText=JSON.stringify(document);const before=all(h)
 const io=h.load("io/scheduleResourceRepairFile.ts"),parsed=await io.readResourceRepairDocument(h.file,ID)
 assert.equal(h.reads,1);assert.equal(parsed.local.format,"terminal-local-resource-evidence");assert.equal(parsed.document.format,document.format)
 assert.equal(parsed.document.choice,document.choice);assert.match(parsed.fingerprint,/^[0-9a-f]{64}$/)
 const local=await io.readResourceRepairMaterial(h.file,ID);assert.equal(local.scheduleId,ID);assert.equal(h.reads,2);assert.equal(all(h),before)
})
test("local-format evidence remains fully archived with an explicit format and complete fingerprint",async()=>{
 const h=await fixture(),r=await h.prepare();assert.equal(r.fileFormat,"terminal-local-resource-evidence")
 assert.equal((await h.repairer.repair(r.reviewId,true)).repaired,true)
 const archive=await meta(h,ARCHIVE);assert.equal(archive[0].fileEvidence.format,"terminal-local-resource-evidence");assert.match(archive[0].fileFingerprint,/^[0-9a-f]{64}$/)
})
