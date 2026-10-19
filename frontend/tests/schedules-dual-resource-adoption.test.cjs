const { test } = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto")
const { ID, OTHER_ID, AT, terminal, entry, intent, setup } = require("./schedules-data-harness.cjs")
const TAG = "019a0300-1234-7000-8000-000000000003", SECOND = "019a0300-1234-7000-8000-000000000004", OTHER_ENTRY = "019a0300-1234-7000-8000-000000000005"
const SERVER = "2026-10-08T10:00:02.000Z", ARCHIVE = "scheduleConflictArchive", CHOICE = "cloud-source-use-diary"
const png = n => Buffer.from([137,80,78,71,13,10,26,10,n]), localBytes = png(1), cloudBytes = png(2), localThumb = png(3), cloudThumb = png(4)
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), blob = bytes => new Blob([bytes], { type: "image/png" })
const image = id => ({ schemaVersion:1,doc:{type:"doc",content:[{type:"image",attrs:{src:`local://media/${id}`}}]} })
function sourceWire(r) { return {id:r.id,remind_date:r.remindDate,title:r.title,content:r.content,content_text:r.contentText,status:r.status,converted_entry_id:r.convertedEntryId,converted_at:r.convertedAt,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER} }
function entryWire(r) { return {id:r.id,from_schedule_id:r.fromScheduleId,entry_date:r.entryDate,sort_order:r.sortOrder,title:r.title,content:r.content,content_text:r.contentText,mood:r.mood,weather:r.weather,tag_ids:r.tagIds,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER} }
const all = h => JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([key,value])=>[key,[...value.rows.values()]])))
const meta = async (h,key) => (await h.db.meta.get(key))?.value
async function fixture(options={}) {
  const h = setup({}, {crypto:crypto.webcrypto,AbortController}); h.mocks["@/api/tokenStore"] = h.tokens
  h.calls=[]; h.reads=0; h.waits=0; h.phase="capture"
  const wait = async pending => { h.waits++; const result = await pending; await options.onWait?.(h); if(options.waitFail)throw Error("wait"); return result }
  h.mocks["./schema"].waitForScheduleResourceBytes=wait; h.mocks["@/db/schema"].waitForScheduleResourceBytes=wait
  await h.db.meta.put({key:"ownerUserId",value:"account-a"}); await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
  const current = entry({title:"本机版本",content:image(OTHER_ID),tagIds:[TAG]}), remote = entry({title:"云端版本",content:image(OTHER_ID),tagIds:[TAG]})
  await h.db.schedules.put(terminal()); await h.db.entries.put(current)
  await h.db.tags.put({id:TAG,name:"共同标签",color:"green",createdAt:AT,dirty:1})
  await h.db.media.put({id:OTHER_ID,entryId:ID,blob:blob(localBytes),thumbBlob:blob(localThumb),mime:"image/png",size:localBytes.length,width:2,height:1,sortOrder:0,createdAt:AT,dirty:1,orphanedAt:null,remoteUrl:"https://private/original",thumbRemoteUrl:"https://private/thumb"})
  await h.db.meta.put({key:"scheduleConversions",value:[intent({ownerUserId:"account-a"})]})
  await h.db.meta.put({key:"scheduleConflicts",value:[{scheduleId:ID,kind:"conversion-entry",localEntry:current,serverEntry:remote},{scheduleId:OTHER_ENTRY,kind:"unrelated"}]})
  h.reply={read_only:true,resolution_enabled:false,proof_scope:"current_entry_resources",resource_state:"verified",resources_complete:true,
    review:{read_only:true,reviewable:true,reason:"terminal_review",receipt_known:true,first_entry_date:"2026-10-07",first_entry_deleted:false,schedule:sourceWire(terminal()),entry:entryWire(remote),entry_state:"active"},media_ids:[OTHER_ID],tag_ids:[TAG],
    media:[{id:OTHER_ID,entry_id:ID,sort_order:0,width:options.width??2,height:1,size:cloudBytes.length,created_at:SERVER,original:{state:"verified",size:cloudBytes.length,sha256:sha(cloudBytes),mime:"image/png"},thumbnail:options.noCloudThumb?{state:"not_present",size:null,mime:null,sha256:null}:{state:"verified",size:cloudThumb.length,sha256:sha(cloudThumb),mime:"image/png"}}],tags:[{id:TAG,name:options.tagDifference?"其他标签":"共同标签",color:"green",created_at:SERVER}],missing_media_ids:[],missing_tag_ids:[]}
  if(options.differentIds){h.reply.media_ids=[SECOND];h.reply.media[0].id=SECOND;h.reply.review.entry.content=image(SECOND)}
  h.transport={async review(id,lease){if(h.phase==="adoption"){h.calls.push({id,lease});await options.onGet?.(h,h.calls.length)}return h.reply},
    async image(id,mediaId,variant){const bytes=variant==="original"?cloudBytes:cloudThumb;return {read_only:true,resolution_enabled:false,proof_scope:"current_entry_image_bytes",schedule_id:id,media_id:mediaId,variant,size:bytes.length,mime:"image/png",sha256:sha(bytes),data_base64:bytes.toString("base64")}}}
  let text=""
  const handle={async getFile(){return {size:new Blob([text]).size,text:async()=>text}},async createWritable(){return {async write(value){text=value},async close(){},async abort(){}}}}
  const exporter=h.load("db/scheduleDualResourceEvidenceRepo.ts").createInternalDualResourceEvidenceExporter(h.transport)
  const prepared=await exporter.prepare(ID,true);assert.equal(prepared.ready,true)
  assert.equal((await exporter.save(prepared.reviewId,true,handle)).saved,true)
  h.fileText=text;h.phase="adoption"
  h.file={get size(){return new Blob([h.fileText]).size},async text(){h.reads++;await options.onRead?.(h,h.reads);return h.fileText}}
  h.adopter=h.load("db/scheduleDualResourceAdoptionRepo.ts").createInternalDualResourceCloudAdopter(h.transport)
  h.review=()=>h.adopter.review(ID,h.file)
  return h
}
for(const noCloudThumb of [false,true])test(`explicit cloud choice atomically adopts exclusive bytes; absent cloud thumbnail=${noCloudThumb}`,async()=>{
  const h=await fixture({noCloudThumb}),before=all(h),tag=await h.db.tags.get(TAG),first=await meta(h,"scheduleConversions")
  await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:null,tagIds:[TAG],title:"无关日记",dirty:0}))
  const other=await h.db.entries.get(OTHER_ENTRY),r=await h.review();assert.equal(r.ready,true);assert.equal(all(h).includes("云端版本"),true)
  assert.equal(await meta(h,ARCHIVE),undefined);assert.equal((await h.db.entries.get(ID)).title,"本机版本")
  assert.deepEqual([...r.choices],[CHOICE]);assert.equal(h.calls[0].lease.ownerUserId,"account-a")
  const done=await h.adopter.resolve(r.reviewId,CHOICE,true);assert.equal(done.applied,true);assert.equal(done.localIntentStatus,"superseded_by_explicit_choice")
  assert.equal(h.reads,2);assert.equal(h.calls.length,2);assert.equal(h.waits,1)
  const saved=await h.db.entries.get(ID),media=await h.db.media.get(OTHER_ID)
  assert.equal(saved.title,"云端版本");assert.equal(saved.id,ID);assert.equal(saved.fromScheduleId,ID);assert.equal(saved.dirty,0)
  assert.deepEqual(Buffer.from(await media.blob.arrayBuffer()),cloudBytes)
  if(noCloudThumb)assert.equal(media.thumbBlob,null);else assert.deepEqual(Buffer.from(await media.thumbBlob.arrayBuffer()),cloudThumb)
  assert.equal(media.remoteUrl,"");assert.equal(media.thumbRemoteUrl,"");assert.equal(media.dirty,0)
  assert.deepEqual(await h.db.tags.get(TAG),tag);assert.deepEqual(await h.db.entries.get(OTHER_ENTRY),other)
  assert.equal((await meta(h,"scheduleConversions")).length,0);assert.equal((await meta(h,"scheduleConflicts")).length,1)
  const archive=(await meta(h,ARCHIVE))[0];assert.equal(archive.kind,"terminal-dual-resource-cloud-adoption");assert.equal(archive.choice,CHOICE)
  assert.equal(archive.evidence.local.media[0].blobBase64,localBytes.toString("base64"));assert.equal(archive.evidence.local.media[0].thumbBase64,localThumb.toString("base64"))
  assert.equal(archive.evidence.cloudMedia[0].blobBase64,cloudBytes.toString("base64"));assert.equal(archive.evidence.local.state.intentions[0].entry.title,first[0].entry.title)
  assert.equal((await h.load("db/scheduleStateRepo.ts").protectedConversions()).entryIds.has(ID),false)
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false)
  assert.notEqual(all(h),before)
})
test("cloud metadata changes are adopted only with the exclusive bytes and saved old metadata",async()=>{
  const h=await fixture({width:9}),r=await h.review();assert.equal(r.ready,true)
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,true)
  assert.equal((await h.db.media.get(OTHER_ID)).width,9);assert.equal((await meta(h,ARCHIVE))[0].evidence.local.media[0].width,2)
})
for(const mode of ["tag-difference","shared-active","shared-deleted","other-intent","other-candidate","p2-history","deep-reference"])test(`unsupported or shared ${mode} stays protected`,async()=>{
  const h=await fixture({tagDifference:mode==="tag-difference",differentIds:mode==="different-ids"})
  if(mode.startsWith("shared-"))await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:image(OTHER_ID),isDeleted:mode==="shared-deleted"?1:0,deletedAt:mode==="shared-deleted"?AT:null}))
  if(mode==="other-intent")await h.db.meta.put({key:"scheduleConversions",value:[...await meta(h,"scheduleConversions"),intent({scheduleId:OTHER_ENTRY,source:{...intent().source,id:OTHER_ENTRY},entry:entry({id:OTHER_ENTRY,fromScheduleId:OTHER_ENTRY,content:image(OTHER_ID)}),ownerUserId:"account-a"})]})
  if(mode==="other-candidate")await h.db.meta.put({key:"scheduleConflicts",value:[...await meta(h,"scheduleConflicts"),{scheduleId:OTHER_ENTRY,kind:"conversion-entry",serverEntry:entry({id:OTHER_ENTRY,fromScheduleId:OTHER_ENTRY,content:image(OTHER_ID)})}]})
  if(mode==="p2-history")await h.db.meta.put({key:"conflicts",value:[{entryId:OTHER_ENTRY,local:entry({id:OTHER_ENTRY,fromScheduleId:null,content:image(OTHER_ID)})}]})
  if(mode==="deep-reference"){let body={};for(let i=0;i<75;i++)body={nested:body};await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:body}))}
  const before=all(h),r=await h.review();assert.equal(r.ready,false);assert.equal(all(h),before);assert.equal(await meta(h,ARCHIVE),undefined)
})
for(const field of ["cloud-bytes","local-bytes","source-id","unknown-format","enable-resolution","cloud-metadata"])test(`invalid dual file ${field} cannot enable adoption`,async()=>{
  const h=await fixture(),packet=JSON.parse(h.fileText)
  if(field==="cloud-bytes")packet.cloudMedia[0].blobBase64=localBytes.toString("base64")
  if(field==="local-bytes")packet.local.media[0].blobBase64=png(9).toString("base64")
  if(field==="source-id")packet.scheduleId=OTHER_ENTRY
  if(field==="unknown-format")packet.format="terminal-matched-resource-conflict-evidence"
  if(field==="enable-resolution")packet.resolutionEnabled=true
  if(field==="cloud-metadata")packet.cloudMedia[0].width=99
  h.fileText=JSON.stringify(packet);const before=all(h)
  assert.equal((await h.review()).ready,false);assert.equal(all(h),before)
})
for(const mode of ["confirm","choice","review-id"])test(`explicit ${mode} is mandatory and triggers no extra reads`,async()=>{
  const h=await fixture(),r=await h.review(),before=all(h),reads=h.reads,calls=h.calls.length
  assert.equal((await h.adopter.resolve(mode==="review-id"?r.reviewId+1:r.reviewId,mode==="choice"?"cloud-source-keep-diary":CHOICE,mode!=="confirm")).applied,false)
  assert.equal(h.reads,reads);assert.equal(h.calls.length,calls);assert.equal(all(h),before)
})
for(const mode of ["account","relogin","epoch","file","local-bytes","tag","source","candidate","purge","draft","cloud","shared-added"])test(`change after review (${mode}) rejects the whole adoption`,async()=>{
  const h=await fixture(),r=await h.review();assert.equal(r.ready,true)
  if(mode==="account")h.user("account-b")
  if(mode==="relogin"){h.user("account-b");h.user("account-a")}
  if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restored"})
  if(mode==="file"){const packet=JSON.parse(h.fileText);packet.exportedAt="2026-10-09T10:00:00.000Z";h.fileText=JSON.stringify(packet)}
  if(mode==="local-bytes")await h.db.media.update(OTHER_ID,{blob:blob(png(9))})
  if(mode==="tag")await h.db.tags.update(TAG,{color:"red"})
  if(mode==="source")await h.db.schedules.update(ID,{title:"changed"})
  if(mode==="candidate")await h.db.meta.put({key:"scheduleConflicts",value:[]})
  if(mode==="purge")await h.db.meta.put({key:"pendingPurges",value:[ID]})
  if(mode==="draft")await h.db.meta.put({key:"draft",value:{text:"keep"}})
  if(mode==="cloud")h.reply.review.entry.title="new cloud title"
  if(mode==="shared-added")await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:image(OTHER_ID)}))
  const before=all(h);assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false)
  assert.equal(all(h),before);assert.equal(await meta(h,ARCHIVE),undefined)
})
for(const table of ["media","schedules","entries","meta"])test(`write failure in ${table} rolls back bytes, archive, source and protection`,async()=>{
  const h=await fixture(),r=await h.review(),before=all(h);h.failNext(table)
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before)
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()),localBytes)
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).thumbBlob.arrayBuffer()),localThumb)
})
for(const mode of ["account","epoch","cancel","shared"])test(`transaction byte-verification boundary ${mode} cannot commit a stale plan`,async()=>{
  const h=await fixture({onWait:async state=>{
    if(mode==="account")state.user("account-b")
    if(mode==="epoch")await state.db.meta.put({key:"ownerGeneration",value:"changed"})
    if(mode==="cancel")state.adopter.cancel()
    if(mode==="shared")await state.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:image(OTHER_ID)}))
  }}),r=await h.review(),before=all(h)
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false)
  assert.equal(all(h),before);assert.equal(await meta(h,ARCHIVE),undefined)
})
test("waitFor failure preserves original bytes and queue",async()=>{
  const h=await fixture({waitFail:true}),r=await h.review(),before=all(h)
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before)
})
for(const mode of ["source-ahead","entry-ahead","base-ahead","base-same-water-contradiction"])test(`known ${mode} cannot move backwards to the file proof`,async()=>{
  const h=await fixture(),r=await h.review();assert.equal(r.ready,true)
  if(mode==="source-ahead")await h.db.schedules.update(ID,{serverUpdatedAt:"2026-10-08T10:00:03.000Z"})
  if(mode==="entry-ahead")await h.db.entries.update(ID,{serverUpdatedAt:"2026-10-08T10:00:03.000Z"})
  if(mode.startsWith("base-")){
    const at=mode==="base-ahead"?"2026-10-08T10:00:03.000Z":SERVER
    await h.db.meta.put({key:`scheduleServerState:${ID}`,value:{ownerUserId:"account-a",generation:"epoch",source:terminal({title:"contradiction",dirty:0,updatedAt:at,serverUpdatedAt:at})}})
  }
  const before=all(h);assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before)
})
test("cancel during review GET prevents a late ticket and single-flight blocks another operation",async()=>{
  let start,release;const started=new Promise(r=>{start=r}),wait=new Promise(r=>{release=r})
  const h=await fixture({onGet:async(_,n)=>{if(n===1){start();await wait}}})
  const pending=h.review();await started;assert.equal((await h.review()).reason,"busy")
  assert.equal((await h.adopter.resolve(1,CHOICE,true)).reason,"busy")
  h.adopter.cancel();release();assert.equal((await pending).ready,false)
  assert.equal((await h.adopter.resolve(1,CHOICE,true)).applied,false)
})
for(const mode of ["cancel","account"])test(`late ${mode} after media write rolls back the already-written bytes and archive`,async()=>{
  const h=await fixture(),r=await h.review(),before=all(h),put=h.db.media.put
  h.db.media.put=async row=>{await put(row);if(mode==="cancel")h.adopter.cancel();else h.user("account-b")}
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before)
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()),localBytes)
})
test("an unrelated valid conversion queue, errors, cursor and purge list remain unchanged after adoption",async()=>{
  const h=await fixture()
  const otherIntent=intent({scheduleId:OTHER_ENTRY,source:{...intent().source,id:OTHER_ENTRY},entry:entry({id:OTHER_ENTRY,fromScheduleId:OTHER_ENTRY,content:null}),ownerUserId:"account-a"})
  await h.db.meta.put({key:"scheduleConversions",value:[...await meta(h,"scheduleConversions"),otherIntent]})
  await h.db.meta.put({key:"pendingPurges",value:[OTHER_ENTRY]});await h.db.meta.put({key:"lastSyncAt",value:AT})
  await h.db.meta.put({key:"syncErrors",value:[{kind:"entry",id:OTHER_ENTRY,paused:true,count:3}]})
  const r=await h.review();assert.equal(r.ready,true)
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,true)
  assert.deepEqual(await meta(h,"scheduleConversions"),[otherIntent]);assert.deepEqual(await meta(h,"pendingPurges"),[OTHER_ENTRY])
  assert.equal(await meta(h,"lastSyncAt"),AT);assert.equal((await meta(h,"syncErrors"))[0].count,3)
  assert.ok((await h.load("db/scheduleStateRepo.ts").protectedConversions()).entryIds.has(OTHER_ENTRY))
})
test("new shared diary introduced during the final GET prevents media replacement",async()=>{
  const h=await fixture({onGet:async(state,n)=>{if(n===2)await state.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:image(OTHER_ID)}))}}),r=await h.review()
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false)
  assert.equal((await h.db.entries.get(ID)).title,"本机版本");assert.equal(await meta(h,ARCHIVE),undefined)
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()),localBytes)
})
test("second physical file read failure cannot release protection",async()=>{
  const h=await fixture({onRead:async(_,n)=>{if(n===2)throw Error("file gone")}}),r=await h.review(),before=all(h)
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before)
})
test("duplicate linked diary identities cannot enable resource adoption",async()=>{
  const h=await fixture();await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:ID,content:null}))
  const before=all(h);assert.equal((await h.review()).ready,false);assert.equal(all(h),before)
})
for(const mode of ["receipt-unknown","source-deleted","entry-deleted"])test(`current cloud ${mode} is not bypassed by an older valid file`,async()=>{
  const h=await fixture(),r=await h.review(),before=all(h)
  if(mode==="receipt-unknown")Object.assign(h.reply.review,{receipt_known:false,reviewable:false,reason:"receipt_unknown",first_entry_date:null,first_entry_deleted:null})
  if(mode==="source-deleted")h.reply.review.schedule.deleted_at=AT
  if(mode==="entry-deleted"){h.reply.review.entry.deleted_at=AT;h.reply.review.entry_state="deleted"}
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before)
})
test("ordinary P2 after adoption does not re-upload the superseded local image or diary",async()=>{
  const h=await fixture(),r=await h.review();assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,true)
  const sent=[],uploads=[]
  h.mocks["@/api/mappers"]={fromWireEntry:r=>r,fromWireTag:r=>r,mediaPatchFromWire:r=>r,toWireEntry:r=>r,toWireTag:r=>r,toWireMediaMetaPush:r=>r}
  h.mocks["@/api/endpoints"]={pushBatch:async body=>{sent.push(body);return {serverTime:SERVER,entries:[],tags:body.tags.map(r=>({id:r.id,status:"applied"})),mediaMeta:[]}},uploadMedia:async(...args)=>{uploads.push(args)},pullChanges:async()=>({serverTime:SERVER,syncUntil:SERVER,cursorId:"",hasMore:false,entries:[],tags:[],mediaMeta:[]})}
  await h.load("api/sync.ts").runSync()
  assert.equal(uploads.length,0);assert.ok(sent.every(body=>body.entries.length===0&&body.mediaMeta.length===0))
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()),cloudBytes)
})

const KEEP = "cloud-source-keep-diary"
async function keepFixture(options={}) {
  const h=await fixture(options)
  if(options.newId)h.mocks["@/shared/ids"].newId=options.newId
  h.adopter=h.load("db/scheduleDualResourceAdoptionRepo.ts").createInternalDualResourceLocalKeeper(h.transport)
  h.review=()=>h.adopter.review(ID,h.file)
  return h
}
for(const noCloudThumb of [false,true])test(`local keep forks images without overwriting server IDs; cloud thumbnail absent=${noCloudThumb}`,async()=>{
  const h=await keepFixture({noCloudThumb}),before=all(h),fileBefore=h.fileText,tag=await h.db.tags.get(TAG),r=await h.review()
  assert.equal(r.ready,true);assert.deepEqual([...r.choices],[KEEP]);assert.equal(all(h),before)
  const done=await h.adopter.resolve(r.reviewId,KEEP,true);assert.equal(done.applied,true)
  assert.equal(done.reason,"local_diary_with_fresh_image_ids_ready_for_p2")
  const saved=await h.db.entries.get(ID),archive=(await meta(h,ARCHIVE))[0],mapping=archive.resourceIdMap
  assert.equal(saved.title,"本机版本");assert.equal(saved.id,ID);assert.equal(saved.fromScheduleId,ID);assert.equal(saved.dirty,1)
  assert.equal(saved.serverUpdatedAt,SERVER);assert.ok(Date.parse(saved.clientUpdatedAt)>Date.parse(AT))
  assert.equal(mapping.length,1);assert.equal(mapping[0].from,OTHER_ID);assert.notEqual(mapping[0].to,OTHER_ID)
  assert.equal(saved.content.doc.content[0].attrs.src,`local://media/${mapping[0].to}`)
  const media=await h.db.media.get(mapping[0].to)
  assert.deepEqual(Buffer.from(await media.blob.arrayBuffer()),localBytes);assert.deepEqual(Buffer.from(await media.thumbBlob.arrayBuffer()),localThumb)
  assert.equal(media.dirty,1);assert.equal(media.entryId,ID);assert.equal(media.remoteUrl,"");assert.equal(media.thumbRemoteUrl,"")
  assert.equal(await h.db.media.get(OTHER_ID),undefined);assert.equal(await meta(h,"pendingPurges"),undefined)
  assert.equal(archive.kind,"terminal-dual-resource-local-keep");assert.equal(archive.choice,KEEP)
  assert.equal(archive.evidence.local.media[0].blobBase64,localBytes.toString("base64"));assert.equal(archive.evidence.cloudMedia[0].blobBase64,cloudBytes.toString("base64"))
  assert.deepEqual(archive.result,saved);assert.equal(h.fileText,fileBefore);assert.deepEqual(await h.db.tags.get(TAG),tag)
  assert.equal((await meta(h,"scheduleConversions")).length,0);assert.equal((await meta(h,"scheduleConflicts")).length,1)
  assert.equal((await h.load("db/scheduleStateRepo.ts").protectedConversions()).entryIds.has(ID),false)
  assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,false)
})
test("local keep remaps repeated/nested images once and preserves formatting, text and unrelated attributes",async()=>{
  const h=await keepFixture(),packet=JSON.parse(h.fileText)
  const body={schemaVersion:1,doc:{type:"doc",content:[{type:"paragraph",attrs:{align:"center"},content:[{type:"text",text:`literal local://media/${OTHER_ID}`,marks:[{type:"bold"}]}]},
    {type:"image",attrs:{src:`local://media/${OTHER_ID}`,alt:"do not change",title:"image"}},
    {type:"blockquote",content:[{type:"image",attrs:{src:`local://media/${OTHER_ID}`}}]}]}}
  await h.db.entries.update(ID,{content:body});packet.local.state.entry.content=body;packet.local.state.linkedEntries[0].content=body
  h.fileText=JSON.stringify(packet)
  const r=await h.review();assert.equal(r.ready,true);assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,true)
  const saved=await h.db.entries.get(ID),map=(await meta(h,ARCHIVE))[0].resourceIdMap
  assert.equal(map.length,1);assert.equal(h.stores.media.rows.size,1)
  assert.equal(saved.content.doc.content[0].content[0].text,`literal local://media/${OTHER_ID}`)
  assert.equal(saved.content.doc.content[0].content[0].marks[0].type,"bold")
  assert.equal(saved.content.doc.content[1].attrs.alt,"do not change")
  assert.equal(saved.content.doc.content[2].content[0].attrs.src,`local://media/${map[0].to}`)
  assert.equal(packet.local.state.entry.content.doc.content[1].attrs.src,`local://media/${OTHER_ID}`)
})
test("keeping a currently text-only local diary archives historical images without inventing new active copies",async()=>{
  const h=await keepFixture(),packet=JSON.parse(h.fileText)
  await h.db.entries.update(ID,{content:null});packet.local.state.entry.content=null;packet.local.state.linkedEntries[0].content=null
  h.fileText=JSON.stringify(packet)
  const r=await h.review();assert.equal(r.ready,true);assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,true)
  assert.equal((await h.db.entries.get(ID)).content,null);assert.equal(h.stores.media.rows.size,0)
  assert.equal((await meta(h,ARCHIVE))[0].resourceIdMap.length,0)
  assert.equal((await meta(h,ARCHIVE))[0].evidence.local.media.length,1)
})
for(const mode of ["bad-signature","mime-mismatch","bad-thumb"])test(`local keep refuses nonuploadable ${mode} while retaining all evidence`,async()=>{
  const h=await keepFixture(),packet=JSON.parse(h.fileText),row=await h.db.media.get(OTHER_ID)
  if(mode==="bad-signature"){row.blob=blob(Buffer.alloc(localBytes.length,1));packet.local.media[0].blobBase64=Buffer.alloc(localBytes.length,1).toString("base64")}
  if(mode==="mime-mismatch"){row.mime="image/jpeg";packet.local.media[0].mime="image/jpeg"}
  if(mode==="bad-thumb"){row.thumbBlob=blob(Buffer.alloc(localThumb.length,1));packet.local.media[0].thumbBase64=Buffer.alloc(localThumb.length,1).toString("base64")}
  await h.db.media.put(row);h.fileText=JSON.stringify(packet);const before=all(h)
  assert.equal((await h.review()).ready,false);assert.equal(all(h),before)
})
for(const target of ["media","entries","schedules","tags","old-id","invalid","other-reference"])test(`fresh image ID ${target} collision never overwrites an existing identity`,async()=>{
  const chosen=target==="old-id"?OTHER_ID:target==="invalid"?"not-a-uuid":SECOND
  const h=await keepFixture({newId:()=>chosen})
  if(target==="media")await h.db.media.put({id:SECOND,entryId:"",blob:blob(localBytes),dirty:0})
  if(target==="entries")await h.db.entries.put(entry({id:SECOND,fromScheduleId:null,content:null}))
  if(target==="schedules")await h.db.schedules.put({...terminal(),id:SECOND,convertedEntryId:SECOND,dirty:0,serverUpdatedAt:SERVER})
  if(target==="tags")await h.db.tags.put({id:SECOND,name:"occupied",color:null,createdAt:AT,dirty:0})
  if(target==="other-reference")await h.db.meta.put({key:"conflicts",value:[{entryId:OTHER_ENTRY,local:entry({id:OTHER_ENTRY,fromScheduleId:null,content:image(SECOND)})}]})
  const r=await h.review();assert.equal(r.ready,true);const before=all(h)
  assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,false);assert.equal(all(h),before)
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()),localBytes)
})
for(const mode of ["shared-diary","other-intent","other-candidate","tag-difference"])test(`local keep cannot bypass ${mode}`,async()=>{
  const h=await keepFixture({tagDifference:mode==="tag-difference",differentIds:mode==="different-ids"})
  if(mode==="shared-diary")await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:image(OTHER_ID)}))
  if(mode==="other-intent")await h.db.meta.put({key:"scheduleConversions",value:[...await meta(h,"scheduleConversions"),intent({scheduleId:OTHER_ENTRY,source:{...intent().source,id:OTHER_ENTRY},entry:entry({id:OTHER_ENTRY,fromScheduleId:OTHER_ENTRY,content:image(OTHER_ID)}),ownerUserId:"account-a"})]})
  if(mode==="other-candidate")await h.db.meta.put({key:"scheduleConflicts",value:[...await meta(h,"scheduleConflicts"),{scheduleId:OTHER_ENTRY,kind:"conversion-entry",serverEntry:entry({id:OTHER_ENTRY,fromScheduleId:OTHER_ENTRY,content:image(OTHER_ID)})}]})
  const before=all(h);assert.equal((await h.review()).ready,false);assert.equal(all(h),before)
})
for(const mode of ["account","relogin","epoch","file","bytes","tag","cloud","purge","draft","shared"])test(`local keep rechecks ${mode} after preview`,async()=>{
  const h=await keepFixture(),r=await h.review();assert.equal(r.ready,true)
  if(mode==="account")h.user("account-b")
  if(mode==="relogin"){h.user("account-b");h.user("account-a")}
  if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restore"})
  if(mode==="file"){const packet=JSON.parse(h.fileText);packet.exportedAt=AT;h.fileText=JSON.stringify(packet)}
  if(mode==="bytes")await h.db.media.update(OTHER_ID,{blob:blob(png(9))})
  if(mode==="tag")await h.db.tags.update(TAG,{color:"red"})
  if(mode==="cloud")h.reply.review.entry.title="changed"
  if(mode==="purge")await h.db.meta.put({key:"pendingPurges",value:[ID]})
  if(mode==="draft")await h.db.meta.put({key:"draft",value:{text:"keep"}})
  if(mode==="shared")await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:image(OTHER_ID)}))
  const before=all(h);assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,false);assert.equal(all(h),before)
})
for(const table of ["media","entries","schedules","meta"])test(`local keep write failure in ${table} restores old cache, clone rows, archive and protection`,async()=>{
  const h=await keepFixture(),r=await h.review(),before=all(h);h.failNext(table)
  assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,false);assert.equal(all(h),before)
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()),localBytes)
})
for(const mode of ["cancel","account","epoch"])test(`local keep ${mode} after old-cache deletion cannot leave a half-remapped diary`,async()=>{
  const h=await keepFixture(),r=await h.review(),before=all(h),remove=h.db.media.delete
  h.db.media.delete=async id=>{await remove(id);if(mode==="cancel")h.adopter.cancel();if(mode==="account")h.user("account-b");if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"new"})}
  assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,false);assert.equal(all(h),before)
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()),localBytes)
})
test("local keep requires its own explicit choice; cloud and local factories cannot silently switch sides",async()=>{
  const h=await keepFixture(),r=await h.review(),before=all(h)
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false)
  assert.equal((await h.adopter.resolve(r.reviewId,KEEP,false)).applied,false)
  assert.equal((await h.adopter.resolve(r.reviewId+1,KEEP,true)).applied,false);assert.equal(all(h),before)
  assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,true)
})
test("P2 uploads retained bytes only under fresh IDs and updates the one stable diary",async()=>{
  const h=await keepFixture(),r=await h.review();assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,true)
  const fresh=(await meta(h,ARCHIVE))[0].resourceIdMap[0].to,uploads=[],sent=[]
  h.mocks["@/api/mappers"]={fromWireEntry:r=>r,fromWireTag:r=>r,mediaPatchFromWire:r=>r,toWireEntry:r=>r,toWireTag:r=>r,toWireMediaMetaPush:r=>r}
  h.mocks["@/api/endpoints"]={uploadMedia:async(id,bytes,options,owner)=>{uploads.push({id,bytes,options,owner})},pushBatch:async body=>{
    sent.push(body);return {serverTime:SERVER,entries:body.entries.map(r=>({id:r.id,status:"applied"})),tags:body.tags.map(r=>({id:r.id,status:"applied"})),mediaMeta:body.mediaMeta.map(r=>({id:r.id,status:"applied"}))}},pullChanges:async()=>({serverTime:SERVER,syncUntil:SERVER,cursorId:"",hasMore:false,entries:[],tags:[],mediaMeta:[]})}
  await h.load("api/sync.ts").runSync()
  assert.equal(uploads.length,1);assert.equal(uploads[0].id,fresh);assert.equal(uploads[0].owner,"account-a")
  assert.deepEqual(Buffer.from(await uploads[0].bytes.arrayBuffer()),localBytes)
  assert.ok(sent.every(body=>body.mediaMeta.every(row=>row.id!==OTHER_ID)))
  assert.equal(sent[0].entries[0].id,ID);assert.equal(sent[0].entries[0].fromScheduleId,ID)
  assert.equal(sent[0].entries[0].content.doc.content[0].attrs.src,`local://media/${fresh}`)
  assert.equal((await h.db.entries.get(ID)).dirty,0);assert.equal((await h.db.media.get(fresh)).dirty,0)
  assert.equal(h.stores.entries.rows.size,1);assert.equal(h.reply.media[0].original.sha256,sha(cloudBytes))
})
async function twoImageKeepFixture(options={}) {
  const h=await keepFixture(options),row=await h.db.media.get(OTHER_ID)
  await h.db.media.put({...row,id:SECOND,sortOrder:1})
  const body={schemaVersion:1,doc:{type:"doc",content:[{type:"image",attrs:{src:`local://media/${SECOND}`}},{type:"image",attrs:{src:`local://media/${OTHER_ID}`}},{type:"image",attrs:{src:`local://media/${SECOND}`}}]}}
  await h.db.entries.update(ID,{content:body});h.reply.review.entry.content=body
  h.reply.media_ids.push(SECOND);h.reply.media.push({...structuredClone(h.reply.media[0]),id:SECOND,sort_order:1})
  let text=""
  const handle={async getFile(){return {size:new Blob([text]).size,text:async()=>text}},async createWritable(){return {async write(value){text=value},async close(){},async abort(){}}}}
  const exporter=h.load("db/scheduleDualResourceEvidenceRepo.ts").createInternalDualResourceEvidenceExporter(h.transport)
  const r=await exporter.prepare(ID,true);assert.equal(r.ready,true)
  assert.equal((await exporter.save(r.reviewId,true,handle)).saved,true)
  h.fileText=text;h.calls=[];return h
}
test("two retained images receive unique new IDs in document order and repeated references reuse one clone",async()=>{
  const h=await twoImageKeepFixture(),r=await h.review();assert.equal(r.ready,true)
  assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,true)
  const map=(await meta(h,ARCHIVE))[0].resourceIdMap,saved=await h.db.entries.get(ID)
  assert.equal(map.length,2);assert.equal(map[0].from,SECOND);assert.equal(map[1].from,OTHER_ID);assert.notEqual(map[0].to,map[1].to)
  assert.equal(saved.content.doc.content[0].attrs.src,saved.content.doc.content[2].attrs.src)
  assert.equal((await h.db.media.get(map[0].to)).sortOrder,0);assert.equal((await h.db.media.get(map[1].to)).sortOrder,1)
  assert.equal(h.stores.media.rows.size,2);assert.equal(await h.db.media.get(OTHER_ID),undefined);assert.equal(await h.db.media.get(SECOND),undefined)
})
test("duplicate generated IDs abort a whole multi-image keep without replacing the occupied mapping",async()=>{
  const h=await twoImageKeepFixture({newId:()=>"019a0300-1234-7000-8000-000000000006"}),r=await h.review(),before=all(h)
  assert.equal(r.ready,true);assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,false);assert.equal(all(h),before)
  assert.equal(await meta(h,ARCHIVE),undefined);assert.equal(h.stores.media.rows.size,2)
})
test("cache eviction failure rolls back the earlier archive write",async()=>{
  const h=await keepFixture(),r=await h.review(),before=all(h);h.failNext("media","delete")
  assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,false);assert.equal(all(h),before)
})
test("local keep plan advances beyond microsecond revisions even with a backwards wall clock",async()=>{
  const h=await keepFixture(),packet=JSON.parse(h.fileText),localAt="2026-10-08T10:00:01.123456Z",remoteAt="2026-10-08T10:00:02.999999Z"
  packet.local.state.entry.clientUpdatedAt=localAt;packet.local.state.linkedEntries[0].clientUpdatedAt=localAt
  packet.cloud.review.entry.client_updated_at=remoteAt
  const before=JSON.stringify(packet),plan=h.load("shared/scheduleDualResourceAdoption.ts").planDualLocalKeep(packet,new Map([[OTHER_ID,SECOND]]),AT)
  assert.equal(plan.entry.clientUpdatedAt,"2026-10-08T10:00:03.000Z")
  assert.equal(plan.entry.updatedAt,plan.entry.clientUpdatedAt);assert.equal(plan.entry.entryDate,packet.local.state.entry.entryDate)
  assert.equal(plan.entry.sortOrder,packet.local.state.entry.sortOrder);assert.deepEqual([...plan.entry.tagIds],packet.local.state.entry.tagIds)
  assert.equal(JSON.stringify(packet),before)
})
test("cancel after clone insertion still rolls back clone, old-cache deletion, diary and evidence archive",async()=>{
  const h=await keepFixture(),r=await h.review(),before=all(h),add=h.db.media.add
  h.db.media.add=async row=>{await add(row);h.adopter.cancel()}
  assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,false);assert.equal(all(h),before)
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()),localBytes)
})

async function refreshSetEvidence(h) {
  let text=""; const handle={async getFile(){return {size:new Blob([text]).size,text:async()=>text}},async createWritable(){return {async write(value){text=value},async close(){},async abort(){}}}}
  const phase=h.phase;h.phase="capture"
  const exporter=h.load("db/scheduleDualResourceEvidenceRepo.ts").createInternalDualResourceEvidenceExporter(h.transport)
  const ready=await exporter.prepare(ID,true);assert.equal(ready.ready,true)
  assert.equal((await exporter.save(ready.reviewId,true,handle)).saved,true)
  h.fileText=text;h.phase=phase;h.calls=[]
}
const images = ids => ({schemaVersion:1,doc:{type:"doc",content:ids.map(id=>({type:"image",attrs:{src:`local://media/${id}`}}))}})
async function setFixture(kind,choice=CHOICE,options={}) {
  const h=await (choice===KEEP?keepFixture:fixture)({...options,differentIds:kind==="disjoint"})
  if(kind==="cloud-superset") {
    h.reply.media_ids.push(SECOND);h.reply.media.push({...structuredClone(h.reply.media[0]),id:SECOND,sort_order:1})
    h.reply.review.entry.content=images([OTHER_ID,SECOND])
  }
  if(kind==="local-superset") {
    await h.db.media.put({...await h.db.media.get(OTHER_ID),id:SECOND,sortOrder:1})
    await h.db.entries.update(ID,{content:images([SECOND,OTHER_ID,SECOND])})
  }
  if(kind==="partial-overlap") {
    const third="019a0300-1234-7000-8000-000000000006"
    await h.db.media.put({...await h.db.media.get(OTHER_ID),id:SECOND,sortOrder:1})
    await h.db.entries.update(ID,{content:images([SECOND,OTHER_ID,SECOND])})
    h.reply.media_ids=[SECOND,third];h.reply.media=[{...structuredClone(h.reply.media[0]),id:SECOND},{...structuredClone(h.reply.media[0]),id:third,sort_order:1}]
    h.reply.review.entry.content=images([third,SECOND,third])
  }
  if(kind==="empty-cloud") {
    h.reply.media_ids=[];h.reply.media=[];h.reply.review.entry.content=null
  }
  if(kind==="empty-local") {
    await h.db.entries.update(ID,{content:null})
    await h.db.media.delete(OTHER_ID)
    await h.db.meta.put({key:"scheduleConflicts",value:[{scheduleId:ID,kind:"conversion-entry",serverEntry:null},{scheduleId:OTHER_ENTRY,kind:"unrelated"}]})
  }
  if(kind!=="disjoint")await refreshSetEvidence(h)
  return h
}
for(const kind of ["disjoint","cloud-superset","local-superset","partial-overlap","empty-cloud","empty-local"])for(const choice of [CHOICE,KEEP])test(`different image sets ${kind} support explicit ${choice} without another diary`,async()=>{
  const h=await setFixture(kind,choice),packet=JSON.parse(h.fileText),file=h.fileText,before=all(h),tag=await h.db.tags.get(TAG),r=await h.review()
  assert.equal(r.ready,true);assert.equal(all(h),before)
  const local=packet.local.mediaIds,cloud=packet.cloud.media_ids,expected={localOnly:local.filter(id=>!cloud.includes(id)),cloudOnly:cloud.filter(id=>!local.includes(id)),common:local.filter(id=>cloud.includes(id))}
  assert.deepEqual(JSON.parse(JSON.stringify(r.imageSets)),expected);assert.deepEqual([...r.choices],[choice])
  const done=await h.adopter.resolve(r.reviewId,choice,true);assert.equal(done.applied,true)
  const saved=await h.db.entries.get(ID),archive=(await meta(h,ARCHIVE))[0],rows=await h.db.media.toArray()
  assert.equal(h.stores.entries.rows.size,1);assert.equal(saved.id,ID);assert.equal(saved.fromScheduleId,ID)
  assert.deepEqual(archive.result,saved);assert.deepEqual(archive.imageSets,expected)
  assert.deepEqual(archive.evidence,packet);assert.equal(h.fileText,file);assert.deepEqual(await h.db.tags.get(TAG),tag)
  assert.equal((await meta(h,"scheduleConversions")).length,0);assert.equal((await meta(h,"scheduleConflicts")).length,1)
  assert.equal(await meta(h,"pendingPurges"),undefined);assert.equal((await h.db.schedules.get(ID)).dirty,0)
  if(choice===CHOICE) {
    assert.deepEqual(rows.map(row=>row.id).sort(),cloud)
    assert.deepEqual(saved.content,packet.cloud.review.entry.content);assert.equal(saved.title,"云端版本");assert.equal(saved.dirty,0)
    for(const row of rows){assert.equal(row.dirty,0);assert.equal(row.orphanedAt,null);assert.deepEqual(Buffer.from(await row.blob.arrayBuffer()),cloudBytes)}
    assert.equal(h.stores.media.rows.has(SECOND),cloud.includes(SECOND))
  } else {
    const currentIds=kind==="empty-local"?[]:(kind==="local-superset"||kind==="partial-overlap")?[SECOND,OTHER_ID]:[OTHER_ID]
    assert.deepEqual(archive.resourceIdMap.map(row=>row.from),currentIds);assert.equal(rows.length,currentIds.length)
    for(const row of rows){assert.ok(!local.includes(row.id)&&!cloud.includes(row.id));assert.equal(row.dirty,1);assert.equal(row.orphanedAt,null);assert.deepEqual(Buffer.from(await row.blob.arrayBuffer()),localBytes)}
    assert.equal(saved.title,"本机版本");assert.equal(saved.dirty,1);assert.equal(saved.serverUpdatedAt,SERVER)
    if(kind==="empty-local")assert.equal(saved.content,null)
  }
})
for(const choice of [CHOICE,KEEP])for(const target of ["media","entries","schedules","tags","shared-active","shared-deleted","other-intent","other-candidate","p2-history"])test(`remote-only ID ${target} stays protected for ${choice}`,async()=>{
  const h=await setFixture("disjoint",choice)
  if(target==="media")await h.db.media.put({id:SECOND,entryId:OTHER_ENTRY,blob:blob(png(9)),thumbBlob:null,dirty:0})
  if(target==="entries")await h.db.entries.put(entry({id:SECOND,fromScheduleId:null,content:null}))
  if(target==="schedules")await h.db.schedules.put({...terminal(),id:SECOND,convertedEntryId:SECOND})
  if(target==="tags")await h.db.tags.put({id:SECOND,name:"occupied",color:null,createdAt:AT,dirty:0})
  if(target.startsWith("shared-"))await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:image(SECOND),isDeleted:target==="shared-deleted"?1:0,deletedAt:target==="shared-deleted"?AT:null}))
  if(target==="other-intent")await h.db.meta.put({key:"scheduleConversions",value:[...await meta(h,"scheduleConversions"),intent({scheduleId:OTHER_ENTRY,source:{...intent().source,id:OTHER_ENTRY},entry:entry({id:OTHER_ENTRY,fromScheduleId:OTHER_ENTRY,content:image(SECOND)}),ownerUserId:"account-a"})]})
  if(target==="other-candidate")await h.db.meta.put({key:"scheduleConflicts",value:[...await meta(h,"scheduleConflicts"),{scheduleId:OTHER_ENTRY,kind:"conversion-entry",serverEntry:entry({id:OTHER_ENTRY,fromScheduleId:OTHER_ENTRY,content:image(SECOND)})}]})
  if(target==="p2-history")await h.db.meta.put({key:"conflicts",value:[{entryId:OTHER_ENTRY,local:entry({id:OTHER_ENTRY,fromScheduleId:null,content:image(SECOND)})}]})
  const before=all(h);assert.equal((await h.review()).ready,false);assert.equal(all(h),before);assert.equal(await meta(h,ARCHIVE),undefined)
})
for(const choice of [CHOICE,KEEP])for(const when of ["after-review","final-get","write-wait"])test(`late remote-only occupancy ${when} cannot commit ${choice}`,async()=>{
  const insert=async h=>{await h.db.media.put({id:SECOND,entryId:OTHER_ENTRY,blob:blob(png(9)),thumbBlob:null,dirty:0})}
  const h=await setFixture("disjoint",choice,{onGet:async(h,n)=>{if(when==="final-get"&&n===2)await insert(h)},onWait:async h=>{if(when==="write-wait")await insert(h)}}),r=await h.review()
  assert.equal(r.ready,true);if(when==="after-review")await insert(h)
  const before=all(h);assert.equal((await h.adopter.resolve(r.reviewId,choice,true)).applied,false)
  if(when!=="final-get")assert.equal(all(h),before)
  else assert.equal((await h.db.media.get(SECOND)).entryId,OTHER_ENTRY)
  assert.equal((await h.db.entries.get(ID)).title,"本机版本");assert.equal(await meta(h,ARCHIVE),undefined)
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()),localBytes)
})
for(const operation of ["delete","insert","entry","source","archive"])test(`different-set cloud adoption ${operation} failure rolls the full replacement back`,async()=>{
  const h=await setFixture("disjoint"),r=await h.review(),before=all(h)
  if(operation==="delete")h.failNext("media","delete")
  if(operation==="insert")h.failNext("media","put")
  if(operation==="entry")h.failNext("entries")
  if(operation==="source")h.failNext("schedules")
  if(operation==="archive")h.failNext("meta")
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before)
  assert.equal(await h.db.media.get(SECOND),undefined)
})
for(const change of ["cancel","account","epoch"])test(`different-set cloud adoption ${change} after local-only eviction rolls back`,async()=>{
  const h=await setFixture("disjoint"),r=await h.review(),before=all(h),remove=h.db.media.delete
  h.db.media.delete=async id=>{await remove(id);if(change==="cancel")h.adopter.cancel();if(change==="account")h.user("account-b");if(change==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restored"})}
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before)
})
test("local fresh ID cannot reuse a cloud-only identity even when it is absent from every local table",async()=>{
  const h=await setFixture("disjoint",KEEP,{newId:()=>SECOND}),r=await h.review(),before=all(h)
  assert.equal(r.ready,true);assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,false);assert.equal(all(h),before)
})
for(const choice of [CHOICE,KEEP])test(`different image sets still block tag-definition differences for ${choice}`,async()=>{
  const h=await setFixture("disjoint",choice,{tagDifference:true}),before=all(h)
  assert.equal((await h.review()).ready,false);assert.equal(all(h),before)
})
for(const choice of [CHOICE,KEEP])test(`different-set ${choice} invokes no network writes and hands only selected bytes to normal P2`,async()=>{
  const h=await setFixture("disjoint",choice),r=await h.review(),sent=[],uploads=[]
  h.transport.image=()=>{throw Error("resolver must read saved bytes, not request new image bytes")}
  assert.equal((await h.adopter.resolve(r.reviewId,choice,true)).applied,true)
  h.mocks["@/api/mappers"]={fromWireEntry:r=>r,fromWireTag:r=>r,mediaPatchFromWire:r=>r,toWireEntry:r=>r,toWireTag:r=>r,toWireMediaMetaPush:r=>r}
  h.mocks["@/api/endpoints"]={uploadMedia:async(id,bytes)=>{uploads.push({id,bytes})},pushBatch:async body=>{sent.push(body);return {serverTime:SERVER,entries:body.entries.map(r=>({id:r.id,status:"applied"})),tags:body.tags.map(r=>({id:r.id,status:"applied"})),mediaMeta:body.mediaMeta.map(r=>({id:r.id,status:"applied"}))}},pullChanges:async()=>({serverTime:SERVER,syncUntil:SERVER,cursorId:"",hasMore:false,entries:[],tags:[],mediaMeta:[]})}
  await h.load("api/sync.ts").runSync()
  assert.ok(sent.every(body=>body.mediaMeta.every(row=>row.id!==OTHER_ID&&row.id!==SECOND)))
  if(choice===CHOICE){assert.equal(uploads.length,0);assert.ok(sent.every(body=>body.entries.length===0))}
  else {assert.equal(uploads.length,1);assert.ok(![OTHER_ID,SECOND].includes(uploads[0].id));assert.deepEqual(Buffer.from(await uploads[0].bytes.arrayBuffer()),localBytes);assert.equal(sent[0].entries[0].id,ID)}
  assert.equal(h.stores.entries.rows.size,1)
})
for(const choice of [CHOICE,KEEP])for(const boundary of ["final-get","write-wait"])test(`remote-only reference introduced at ${boundary} blocks ${choice} even without a media row`,async()=>{
  const share=async h=>{await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:image(SECOND)}))}
  const h=await setFixture("disjoint",choice,{onGet:async(h,n)=>{if(boundary==="final-get"&&n===2)await share(h)},onWait:async h=>{if(boundary==="write-wait")await share(h)}}),r=await h.review(),before=all(h)
  assert.equal(r.ready,true);assert.equal((await h.adopter.resolve(r.reviewId,choice,true)).applied,false)
  if(boundary==="write-wait")assert.equal(all(h),before)
  assert.equal(await h.db.media.get(SECOND),undefined);assert.equal(await meta(h,ARCHIVE),undefined)
  assert.equal((await h.db.entries.get(ID)).title,"本机版本")
})
for(const choice of [CHOICE,KEEP])test(`different image sets do not implicitly accept different tag membership for ${choice}`,async()=>{
  const h=await setFixture("disjoint",choice)
  h.reply.tag_ids=[OTHER_ENTRY];h.reply.tags=[{...h.reply.tags[0],id:OTHER_ENTRY}];h.reply.review.entry.tag_ids=[OTHER_ENTRY]
  await refreshSetEvidence(h);const before=all(h)
  assert.equal((await h.review()).ready,false);assert.equal(all(h),before)
})
test("cloud-only rows use nonoverwriting add and an in-transaction duplicate rolls every write back",async()=>{
  const h=await setFixture("disjoint"),r=await h.review(),before=all(h),put=h.db.meta.put
  h.db.meta.put=async row=>{await put(row);if(row.key===ARCHIVE)await h.db.media.put({id:SECOND,entryId:OTHER_ENTRY,dirty:0})}
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before)
})
