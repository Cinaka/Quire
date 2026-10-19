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
for(const choice of [CHOICE,KEEP])test(`different image sets cannot release unconfirmed local-only tag definitions for ${choice}`,async()=>{
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

const CLOUD_TAG="019a0300-1234-7000-8000-000000000007", LOCAL_TAG="019a0300-1234-7000-8000-000000000008"
async function tagSetFixture(kind,choice=CHOICE,options={}) {
  const h=await (choice===KEEP?keepFixture:fixture)(options)
  await h.db.tags.update(TAG,{dirty:0})
  if(kind==="disjoint"||kind==="cloud-superset"||kind==="partial-overlap") {
    const ids=kind==="disjoint"?[CLOUD_TAG]:[TAG,CLOUD_TAG]
    h.reply.tag_ids=ids;h.reply.review.entry.tag_ids=ids
    h.reply.tags=ids.map(id=>id===TAG?h.reply.tags[0]:{id,name:"云端另一个标签",color:"blue",created_at:SERVER})
  }
  if(kind==="local-superset"||kind==="partial-overlap") {
    await h.db.tags.put({id:LOCAL_TAG,name:"本机额外标签",color:null,createdAt:AT,dirty:0})
    await h.db.entries.update(ID,{tagIds:[TAG,LOCAL_TAG]})
  }
  if(kind==="empty-cloud") {
    h.reply.tag_ids=[];h.reply.tags=[];h.reply.review.entry.tag_ids=[]
  }
  if(kind==="empty-local") {
    await h.db.entries.update(ID,{tagIds:[]})
    const candidates=await meta(h,"scheduleConflicts");candidates[0].localEntry.tagIds=[];candidates[0].serverEntry.tagIds=[]
    await h.db.meta.put({key:"scheduleConflicts",value:candidates});await h.db.tags.delete(TAG)
  }
  if(options.noImages) {
    await h.db.entries.update(ID,{content:null});h.reply.review.entry.content=null;h.reply.media_ids=[];h.reply.media=[]
    const candidates=await meta(h,"scheduleConflicts");candidates[0].localEntry.content=null;candidates[0].serverEntry.content=null
    await h.db.meta.put({key:"scheduleConflicts",value:candidates});await h.db.media.delete(OTHER_ID)
  }
  await refreshSetEvidence(h);return h
}
for(const kind of ["disjoint","cloud-superset","local-superset","partial-overlap","empty-cloud","empty-local"])for(const choice of [CHOICE,KEEP])test(`tag membership ${kind} supports ${choice} without modifying shared definitions`,async()=>{
  const h=await tagSetFixture(kind,choice),packet=JSON.parse(h.fileText),tags=await h.db.tags.toArray(),before=all(h),r=await h.review()
  assert.equal(r.ready,true);assert.equal(all(h),before)
  const local=packet.local.tagIds,remote=packet.cloud.tag_ids,expected={localOnly:local.filter(id=>!remote.includes(id)),cloudOnly:remote.filter(id=>!local.includes(id)),common:local.filter(id=>remote.includes(id))}
  assert.deepEqual(JSON.parse(JSON.stringify(r.tagSets)),expected)
  assert.equal((await h.adopter.resolve(r.reviewId,choice,true)).applied,true)
  const saved=await h.db.entries.get(ID),archive=(await meta(h,ARCHIVE))[0]
  assert.deepEqual(saved.tagIds,choice===CHOICE?packet.cloud.review.entry.tag_ids:packet.local.state.entry.tagIds)
  assert.deepEqual(archive.tagPlan.sets,expected);assert.deepEqual(archive.result,saved)
  assert.deepEqual(archive.evidence,packet);assert.equal(h.stores.entries.rows.size,1)
  for(const tag of tags)assert.deepEqual(await h.db.tags.get(tag.id),tag)
  for(const proof of packet.cloud.tags) {
    const original=tags.find(tag=>tag.id===proof.id),row=await h.db.tags.get(proof.id)
    if(original)assert.deepEqual(row,original)
    else if(choice===CHOICE)assert.deepEqual(row,{id:proof.id,name:proof.name,color:proof.color,createdAt:proof.created_at,dirty:0})
    else assert.equal(row,undefined)
  }
  assert.equal((await meta(h,"scheduleConversions")).length,0);assert.equal((await meta(h,"scheduleConflicts")).length,1)
})
for(const choice of [CHOICE,KEEP])test(`tag-only diary membership works without images for ${choice}`,async()=>{
  const h=await tagSetFixture("disjoint",choice,{noImages:true}),r=await h.review()
  assert.equal(r.ready,true);assert.equal((await h.adopter.resolve(r.reviewId,choice,true)).applied,true)
  assert.equal((await h.db.entries.get(ID)).content,null);assert.equal(h.stores.media.rows.size,0)
  assert.deepEqual((await h.db.entries.get(ID)).tagIds,[choice===CHOICE?CLOUD_TAG:TAG])
})
for(const choice of [CHOICE,KEEP])test(`local-only dirty tag definitions cannot be silently released for ${choice}`,async()=>{
  const h=await tagSetFixture("disjoint",choice);await h.db.tags.update(TAG,{dirty:1});await refreshSetEvidence(h);const before=all(h)
  assert.equal((await h.review()).ready,false);assert.equal(all(h),before)
})
for(const choice of [CHOICE,KEEP])test(`common shared tag name or color difference remains unresolved for ${choice}`,async()=>{
  const h=await tagSetFixture("cloud-superset",choice);h.reply.tags[0].color="red";await refreshSetEvidence(h);const before=all(h)
  assert.equal((await h.review()).ready,false);assert.equal(all(h),before)
})
for(const choice of [CHOICE,KEEP])test(`existing cloud-only tag with identical definition can stay shared for ${choice}`,async()=>{
  const h=await tagSetFixture("disjoint",choice),row={id:CLOUD_TAG,name:"云端另一个标签",color:"blue",createdAt:AT,dirty:0}
  await h.db.tags.put(row);await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:null,tagIds:[CLOUD_TAG],dirty:0}))
  const other=await h.db.entries.get(OTHER_ENTRY),r=await h.review();assert.equal(r.ready,true)
  assert.equal((await h.adopter.resolve(r.reviewId,choice,true)).applied,true)
  assert.deepEqual(await h.db.tags.get(CLOUD_TAG),row);assert.deepEqual(await h.db.entries.get(OTHER_ENTRY),other)
})
for(const choice of [CHOICE,KEEP])for(const mode of ["different-name","different-color","same-name-other-id","case-accent-name","cross-media","cross-entry","cross-source","missing-shared","missing-intent","missing-candidate","missing-p2"])test(`cloud-only tag ${mode} blocks unsafe ${choice}`,async()=>{
  const h=await tagSetFixture("disjoint",choice)
  if(mode==="different-name"||mode==="different-color")await h.db.tags.put({id:CLOUD_TAG,name:mode==="different-name"?"其他定义":"云端另一个标签",color:mode==="different-color"?"red":"blue",createdAt:AT,dirty:0})
  if(mode==="same-name-other-id")await h.db.tags.put({id:LOCAL_TAG,name:"云端另一个标签",color:"blue",createdAt:AT,dirty:0})
  if(mode==="case-accent-name"){h.reply.tags[0].name="Résumé";await refreshSetEvidence(h);await h.db.tags.put({id:LOCAL_TAG,name:" resume ",color:null,createdAt:AT,dirty:0})}
  if(mode==="cross-media")await h.db.media.put({id:CLOUD_TAG,entryId:OTHER_ENTRY,blob:blob(png(9)),dirty:0})
  if(mode==="cross-entry")await h.db.entries.put(entry({id:CLOUD_TAG,fromScheduleId:null,content:null}))
  if(mode==="cross-source")await h.db.schedules.put({...terminal(),id:CLOUD_TAG,convertedEntryId:CLOUD_TAG})
  if(mode==="missing-shared")await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:null,tagIds:[CLOUD_TAG]}))
  if(mode==="missing-intent")await h.db.meta.put({key:"scheduleConversions",value:[...await meta(h,"scheduleConversions"),intent({scheduleId:OTHER_ENTRY,source:{...intent().source,id:OTHER_ENTRY},entry:entry({id:OTHER_ENTRY,fromScheduleId:OTHER_ENTRY,content:null,tagIds:[CLOUD_TAG]}),ownerUserId:"account-a"})]})
  if(mode==="missing-candidate")await h.db.meta.put({key:"scheduleConflicts",value:[...await meta(h,"scheduleConflicts"),{scheduleId:OTHER_ENTRY,kind:"conversion-entry",serverEntry:entry({id:OTHER_ENTRY,fromScheduleId:OTHER_ENTRY,content:null,tagIds:[CLOUD_TAG]})}]})
  if(mode==="missing-p2")await h.db.meta.put({key:"conflicts",value:[{entryId:OTHER_ENTRY,local:entry({id:OTHER_ENTRY,fromScheduleId:null,content:null,tagIds:[CLOUD_TAG]})}]})
  const before=all(h);assert.equal((await h.review()).ready,false);assert.equal(all(h),before);assert.equal(await meta(h,ARCHIVE),undefined)
})
for(const choice of [CHOICE,KEEP])test(`clean local-only tag shared by other diaries is not edited or removed for ${choice}`,async()=>{
  const h=await tagSetFixture("disjoint",choice),tag=await h.db.tags.get(TAG)
  await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:null,tagIds:[TAG],dirty:0}))
  const other=await h.db.entries.get(OTHER_ENTRY),r=await h.review();assert.equal(r.ready,true)
  assert.equal((await h.adopter.resolve(r.reviewId,choice,true)).applied,true)
  assert.deepEqual(await h.db.tags.get(TAG),tag);assert.deepEqual(await h.db.entries.get(OTHER_ENTRY),other)
})
for(const boundary of ["after-review","final-get","write-wait"])for(const mode of ["definition","same-name","occupied","missing-reference"])test(`late tag ${mode} at ${boundary} cannot install a stale membership plan`,async()=>{
  const change=async h=>{
    if(mode==="definition")await h.db.tags.put({id:CLOUD_TAG,name:"new definition",color:null,createdAt:AT,dirty:1})
    if(mode==="same-name")await h.db.tags.put({id:LOCAL_TAG,name:"云端另一个标签",color:null,createdAt:AT,dirty:0})
    if(mode==="occupied")await h.db.media.put({id:CLOUD_TAG,entryId:OTHER_ENTRY,blob:blob(png(9)),dirty:0})
    if(mode==="missing-reference")await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:null,tagIds:[CLOUD_TAG]}))
  }
  const h=await tagSetFixture("disjoint",CHOICE,{onGet:async(h,n)=>{if(boundary==="final-get"&&n===2)await change(h)},onWait:async h=>{if(boundary==="write-wait")await change(h)}}),r=await h.review()
  assert.equal(r.ready,true);if(boundary==="after-review")await change(h)
  const before=all(h);assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false)
  if(boundary!=="final-get")assert.equal(all(h),before)
  assert.equal((await h.db.entries.get(ID)).title,"本机版本");assert.equal(await meta(h,ARCHIVE),undefined)
})
for(const table of ["tags","media","entries","schedules","meta"])test(`tag adoption ${table} failure rolls tags, bytes, diary and protection back together`,async()=>{
  const h=await tagSetFixture("disjoint"),r=await h.review(),before=all(h);assert.equal(r.ready,true);h.failNext(table)
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before);assert.equal(await h.db.tags.get(CLOUD_TAG),undefined)
})
for(const mode of ["cancel","account","epoch"])test(`late ${mode} after adding cloud tag rolls the tag and archive back`,async()=>{
  const h=await tagSetFixture("disjoint"),r=await h.review(),before=all(h),add=h.db.tags.add
  h.db.tags.add=async row=>{await add(row);if(mode==="cancel")h.adopter.cancel();if(mode==="account")h.user("account-b");if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restored"})}
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before)
})
test("retained image ID cannot collide with a cloud-only tag that is not yet installed",async()=>{
  const h=await tagSetFixture("disjoint",KEEP,{newId:()=>CLOUD_TAG}),r=await h.review(),before=all(h)
  assert.equal(r.ready,true);assert.equal((await h.adopter.resolve(r.reviewId,KEEP,true)).applied,false);assert.equal(all(h),before)
})
for(const choice of [CHOICE,KEEP])test(`ordinary P2 after tag membership ${choice} does not upload or redefine shared tags`,async()=>{
  const h=await tagSetFixture("disjoint",choice),r=await h.review(),sent=[]
  assert.equal((await h.adopter.resolve(r.reviewId,choice,true)).applied,true)
  h.mocks["@/api/mappers"]={fromWireEntry:r=>r,fromWireTag:r=>r,mediaPatchFromWire:r=>r,toWireEntry:r=>r,toWireTag:r=>r,toWireMediaMetaPush:r=>r}
  h.mocks["@/api/endpoints"]={uploadMedia:async()=>{},pushBatch:async body=>{sent.push(body);return {serverTime:SERVER,entries:body.entries.map(r=>({id:r.id,status:"applied"})),tags:body.tags.map(r=>({id:r.id,status:"applied"})),mediaMeta:body.mediaMeta.map(r=>({id:r.id,status:"applied"}))}},pullChanges:async()=>({serverTime:SERVER,syncUntil:SERVER,cursorId:"",hasMore:false,entries:[],tags:[],mediaMeta:[]})}
  await h.load("api/sync.ts").runSync();assert.ok(sent.every(body=>body.tags.length===0))
  if(choice===KEEP)assert.deepEqual(sent[0].entries[0].tagIds,[TAG]);else assert.ok(sent.every(body=>body.entries.length===0))
})
for(const choice of [CHOICE,KEEP])test(`identical cloud-only tag appearing after preview still requires a fresh review for ${choice}`,async()=>{
  const h=await tagSetFixture("disjoint",choice),r=await h.review()
  assert.equal(r.ready,true);await h.db.tags.put({id:CLOUD_TAG,name:"云端另一个标签",color:"blue",createdAt:AT,dirty:0});const before=all(h)
  assert.equal((await h.adopter.resolve(r.reviewId,choice,true)).applied,false);assert.equal(all(h),before)
})
test("second missing cloud tag failure rolls back the first inserted tag and every other table",async()=>{
  const h=await tagSetFixture("disjoint")
  h.reply.tag_ids=[...h.reply.tag_ids,LOCAL_TAG];h.reply.review.entry.tag_ids=[...h.reply.tag_ids];h.reply.tags.push({id:LOCAL_TAG,name:"第二个云端标签",color:null,created_at:SERVER})
  await refreshSetEvidence(h);const r=await h.review(),before=all(h),add=h.db.tags.add;let calls=0
  assert.equal(r.ready,true);h.db.tags.add=async row=>{if(++calls===2)throw Error("second tag insert");return add(row)}
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(calls,2);assert.equal(all(h),before)
})
test("new unrelated tag during review does not invalidate a safe tag membership plan",async()=>{
  const h=await tagSetFixture("disjoint"),r=await h.review(),row={id:LOCAL_TAG,name:"完全无关",color:null,createdAt:AT,dirty:0}
  assert.equal(r.ready,true);await h.db.tags.put(row)
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,true);assert.deepEqual(await h.db.tags.get(LOCAL_TAG),row)
})
test("cloud tag install never overwrites a duplicate inserted after archive, even within a transaction",async()=>{
  const h=await tagSetFixture("disjoint"),r=await h.review(),before=all(h),put=h.db.meta.put
  h.db.meta.put=async row=>{await put(row);if(row.key===ARCHIVE)await h.db.tags.put({id:CLOUD_TAG,name:"do not replace",color:null,createdAt:AT,dirty:1})}
  assert.equal((await h.adopter.resolve(r.reviewId,CHOICE,true)).applied,false);assert.equal(all(h),before)
})

// Independent naming is only a durable preparation, never an upload or diary handoff.
async function copyFixture(choice=CHOICE,options={}) {
  const h=await fixture({tagDifference:true,...options})
  h.preparer=h.load("db/scheduleSharedTagCopyRepo.ts").createInternalSharedTagCopyPreparer(h.transport)
  h.names=[{from:TAG,name:"用户明确的新标签"}];h.copyReview=()=>h.preparer.review(ID,h.file,choice,h.names)
  return h
}
async function preparedCopy(choice=CHOICE,options={}) {
  const h=await copyFixture(choice,options),r=await h.copyReview();assert.equal(r.ready,true)
  h.done=await h.preparer.prepare(r.reviewId,true);assert.equal(h.done.prepared,true);return h
}
const resources=h=>JSON.stringify(Object.fromEntries(["entries","schedules","tags","media"].map(key=>[key,[...h.stores[key].rows.values()]])))
for(const choice of [CHOICE,KEEP])test(`explicit independent names ${choice} reserve only archive identities, never live definitions or diary references`,async()=>{
  const h=await copyFixture(choice)
  await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:null,tagIds:[TAG],title:"共享标签的其他日记",dirty:1}))
  const before=resources(h),queue=await meta(h,"scheduleConversions"),candidates=await meta(h,"scheduleConflicts"),r=await h.copyReview()
  assert.equal(r.ready,true);assert.equal(r.resolutionEnabled,false)
  const done=await h.preparer.prepare(r.reviewId,true);assert.equal(done.prepared,true)
  assert.equal(done.cloudConfirmed,false);assert.equal(done.diarySyncEnabled,false);assert.equal(done.resolutionEnabled,false)
  assert.equal(resources(h),before);assert.deepEqual(await meta(h,"scheduleConversions"),queue);assert.deepEqual(await meta(h,"scheduleConflicts"),candidates)
  assert.equal(h.reads,2);assert.equal(h.calls.length,2);assert.equal(h.waits,2)
  const plan=(await meta(h,ARCHIVE))[0];assert.equal(plan.choice,choice);assert.equal(plan.state,"prepared");assert.equal(plan.names[0].name,h.names[0].name)
  assert.equal(plan.copies[0].from,TAG);assert.notEqual(plan.copies[0].tag.id,TAG);assert.notEqual(plan.copies[0].tag.id,plan.id)
  assert.equal(await h.db.tags.get(plan.copies[0].tag.id),undefined);assert.equal(plan.copies[0].tag.color,"green")
  assert.equal(plan.evidence.local.media[0].blobBase64,localBytes.toString("base64"));assert.equal(plan.evidence.cloudMedia[0].blobBase64,cloudBytes.toString("base64"))
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()),localBytes)
  const held=await h.load("db/scheduleStateRepo.ts").protectedConversions();assert.ok(held.tagIds.has(TAG));assert.ok(held.tagIds.has(plan.copies[0].tag.id));assert.ok(held.entryIds.has(ID));assert.ok(held.mediaIds.has(OTHER_ID))
})
for(const mode of ["empty","space","trim","long","existing","near-name","wrong-id","missing","extra","unknown-field","duplicate"])test(`independent naming rejects ${mode} without writes or implicit suffixes`,async()=>{
  const h=await copyFixture();let names=h.names
  if(mode==="empty")names=[{from:TAG,name:""}]
  if(mode==="space")names=[{from:TAG,name:"  "}]
  if(mode==="trim")names=[{from:TAG,name:" new "}]
  if(mode==="long")names=[{from:TAG,name:"x".repeat(33)}]
  if(mode==="existing")names=[{from:TAG,name:"共同标签"}]
  if(mode==="near-name"){await h.db.tags.put({id:SECOND,name:"Café",color:null,createdAt:AT,dirty:0});names=[{from:TAG,name:"CAFE"}]}
  if(mode==="wrong-id")names=[{from:SECOND,name:"new"}]
  if(mode==="missing")names=[]
  if(mode==="extra")names=[...names,{from:SECOND,name:"extra"}]
  if(mode==="unknown-field")names=[{...names[0],automatic:true}]
  if(mode==="duplicate")names=[...names,...names]
  const before=all(h);assert.equal((await h.preparer.review(ID,h.file,CHOICE,names)).ready,false);assert.equal(all(h),before)
})
for(const choice of [CHOICE,KEEP])test(`same saved file and explicit names resume one stable preparation after reload for ${choice}`,async()=>{
  const h=await preparedCopy(choice),before=all(h),first=h.done
  h.preparer=h.load("db/scheduleSharedTagCopyRepo.ts").createInternalSharedTagCopyPreparer(h.transport)
  const listed=await h.preparer.listPrepared();assert.equal(listed.length,1);assert.equal(listed[0].currentEpoch,true);assert.equal(listed[0].planId,first.planId)
  const r=await h.copyReview();assert.equal(r.ready,true);const done=await h.preparer.prepare(r.reviewId,true)
  assert.equal(done.prepared,true);assert.equal(done.planId,first.planId);assert.deepEqual(done.copies,first.copies);assert.equal(all(h),before)
})
for(const mode of ["confirm","review-id"])test(`independent preparation requires explicit ${mode} before rereading`,async()=>{
  const h=await copyFixture(),r=await h.copyReview(),reads=h.reads,calls=h.calls.length,before=all(h)
  assert.equal((await h.preparer.prepare(mode==="review-id"?r.reviewId+1:r.reviewId,mode!=="confirm")).prepared,false)
  assert.equal(h.reads,reads);assert.equal(h.calls.length,calls);assert.equal(all(h),before)
})
for(const mode of ["account","relogin","epoch","file","local-bytes","tag","catalog","cloud","cancel"])test(`independent preparation rejects stale ${mode} without archive or remap`,async()=>{
  const h=await copyFixture(),r=await h.copyReview();assert.equal(r.ready,true)
  if(mode==="account")h.user("account-b")
  if(mode==="relogin"){h.user("account-b");h.user("account-a")}
  if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restored"})
  if(mode==="file"){const file=JSON.parse(h.fileText);file.exportedAt="2026-10-09T10:00:00.000Z";h.fileText=JSON.stringify(file)}
  if(mode==="local-bytes")await h.db.media.update(OTHER_ID,{blob:blob(png(9))})
  if(mode==="tag")await h.db.tags.update(TAG,{color:"red"})
  if(mode==="catalog")await h.db.tags.put({id:SECOND,name:"new unrelated",color:null,createdAt:AT,dirty:0})
  if(mode==="cloud")h.reply.tags[0].color="red"
  if(mode==="cancel")h.preparer.cancel()
  const before=all(h);assert.equal((await h.preparer.prepare(r.reviewId,true)).prepared,false);assert.equal(all(h),before);assert.equal(await meta(h,ARCHIVE),undefined)
})
for(const mode of ["cancel","account","epoch","failure"])test(`independent preparation late archive ${mode} rolls the transaction back`,async()=>{
  const h=await copyFixture(),r=await h.copyReview(),before=all(h),put=h.db.meta.put
  h.db.meta.put=async row=>{await put(row);if(row.key===ARCHIVE){if(mode==="cancel")h.preparer.cancel();if(mode==="account")h.user("account-b");if(mode==="epoch")await put({key:"ownerGeneration",value:"restored"});if(mode==="failure")throw Error("disk")}}
  assert.equal((await h.preparer.prepare(r.reviewId,true)).prepared,false);assert.equal(all(h),before)
})
for(const mode of ["cancel","account","epoch","failure"])test(`independent preparation byte wait ${mode} cannot commit`,async()=>{
  const h=await copyFixture(CHOICE,{onWait:async h=>{if(mode==="cancel")h.preparer.cancel();if(mode==="account")h.user("account-b");if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restored"});if(mode==="failure")throw Error("wait")}})
  const r=await h.copyReview(),before=all(h);assert.equal(r.ready,true);assert.equal((await h.preparer.prepare(r.reviewId,true)).prepared,false);assert.equal(all(h),before)
})
for(const mode of ["plan-collision","copy-collision","duplicate-generated","invalid-generated","dangling-reference"])test(`independent preparation ${mode} never reuses another identity`,async()=>{
  const h=await copyFixture();let n=0
  const fresh="019a0300-1234-7000-8000-000000001001"
  h.mocks["@/shared/ids"].newId=()=>{n++;if(mode==="plan-collision")return TAG;if(mode==="copy-collision")return n===1?fresh:OTHER_ID;if(mode==="invalid-generated")return "random";if(mode==="dangling-reference")return SECOND;return fresh}
  h.preparer=h.load("db/scheduleSharedTagCopyRepo.ts").createInternalSharedTagCopyPreparer(h.transport)
  if(mode==="dangling-reference")await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:null,tagIds:[SECOND]}))
  const r=await h.copyReview(),before=all(h);assert.equal(r.ready,true);assert.equal((await h.preparer.prepare(r.reviewId,true)).prepared,false);assert.equal(all(h),before)
})
for(const mode of ["names","choice","epoch"])test(`existing preparation is not replaced by different ${mode}`,async()=>{
  const h=await preparedCopy(),beforePlans=await meta(h,ARCHIVE)
  if(mode==="names")h.names=[{from:TAG,name:"另一个明确名称"}]
  if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restored"})
  const r=await h.preparer.review(ID,h.file,mode==="choice"?KEEP:CHOICE,h.names);assert.equal(r.ready,true)
  const before=all(h);assert.equal((await h.preparer.prepare(r.reviewId,true)).prepared,false);assert.equal(all(h),before);assert.deepEqual(await meta(h,ARCHIVE),beforePlans)
})
test("explicit discard only retires unpublished names and leaves original resources and conversion protected",async()=>{
  const h=await preparedCopy(),before=resources(h),queue=await meta(h,"scheduleConversions"),plan=(await meta(h,ARCHIVE))[0]
  assert.equal((await h.preparer.discard(plan.id,false)).discarded,false)
  assert.equal((await h.preparer.discard(plan.id,true)).discarded,true);assert.equal(resources(h),before);assert.deepEqual(await meta(h,"scheduleConversions"),queue)
  assert.equal((await meta(h,ARCHIVE))[0].state,"discarded");assert.equal((await h.preparer.listPrepared()).length,0)
  const held=await h.load("db/scheduleStateRepo.ts").protectedConversions();assert.ok(held.entryIds.has(ID));assert.ok(held.tagIds.has(TAG));assert.equal(held.tagIds.has(plan.copies[0].tag.id),false)
})
for(const mode of ["epoch","local-change","catalog-change","write-failure"])test(`discard ${mode} leaves the preparation and original hold intact`,async()=>{
  const h=await preparedCopy(),plan=(await meta(h,ARCHIVE))[0]
  if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restored"})
  if(mode==="local-change")await h.db.entries.update(ID,{title:"new"})
  if(mode==="catalog-change")await h.db.tags.put({id:SECOND,name:"new",color:null,createdAt:AT,dirty:0})
  if(mode==="write-failure")h.failNext("meta")
  const before=all(h);assert.equal((await h.preparer.discard(plan.id,true)).discarded,false);assert.equal(all(h),before)
})
for(const mode of ["version","state","field","mapping","hold-set","duplicate"])test(`malformed independent archive ${mode} stops protection-sensitive work`,async()=>{
  const h=await preparedCopy(),plans=await meta(h,ARCHIVE),plan=plans[0]
  if(mode==="version")plan.version=2
  if(mode==="state")plan.state="confirmed"
  if(mode==="field")plan.unknown=true
  if(mode==="mapping")plan.copies[0].from=SECOND
  if(mode==="hold-set")plan.originalTagIds=[]
  if(mode==="duplicate")plans.push(structuredClone(plan))
  await h.db.meta.put({key:ARCHIVE,value:plans});const before=all(h)
  await assert.rejects(h.load("db/scheduleStateRepo.ts").protectedConversions());assert.equal(all(h),before)
  await assert.rejects(h.preparer.listPrepared())
})
for(const epoch of ["epoch","restored"])test(`prepared holds survive missing queue and same-owner epoch ${epoch}`,async()=>{
  const h=await preparedCopy(),plan=(await meta(h,ARCHIVE))[0]
  await h.db.meta.put({key:"scheduleConversions",value:[]});await h.db.schedules.update(ID,{dirty:0,serverUpdatedAt:SERVER});await h.db.meta.put({key:"ownerGeneration",value:epoch})
  const held=await h.load("db/scheduleStateRepo.ts").protectedConversions();assert.ok(held.entryIds.has(ID));assert.ok(held.tagIds.has(TAG));assert.ok(held.tagIds.has(plan.copies[0].tag.id));assert.ok(held.mediaIds.has(OTHER_ID))
  assert.equal((await h.preparer.listPrepared())[0].currentEpoch,epoch==="epoch")
})
test("independent names preserve unrelated archive kinds and normalize microsecond catalog timestamps",async()=>{
  const h=await copyFixture();await h.db.tags.put({id:SECOND,name:"unrelated",color:null,createdAt:"2026-10-08T10:00:00.123456Z",dirty:0})
  await h.db.meta.put({key:ARCHIVE,value:[{kind:"other-history",opaque:{keep:true}}]})
  const r=await h.copyReview();assert.equal(r.ready,true);assert.equal((await h.preparer.prepare(r.reviewId,true)).prepared,true)
  const plans=await meta(h,ARCHIVE);assert.equal(plans.length,2);assert.equal(plans[0].opaque.keep,true);assert.equal(plans[1].catalog.find(t=>t.id===SECOND).createdAt,"2026-10-08T10:00:00.123456Z")
})
test("ordinary P2 cannot upload prepared names, original shared definitions or diaries using them; unrelated data continues",async()=>{
  const h=await preparedCopy(),sent=[],plan=(await meta(h,ARCHIVE))[0]
  await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:null,tagIds:[TAG],dirty:1}))
  await h.db.tags.put({id:SECOND,name:"普通标签",color:null,createdAt:AT,dirty:1})
  await h.db.entries.put(entry({id:LOCAL_TAG,fromScheduleId:null,content:null,tagIds:[SECOND],dirty:1}))
  h.mocks["@/api/mappers"]={fromWireEntry:r=>r,fromWireTag:r=>r,mediaPatchFromWire:r=>r,toWireEntry:r=>r,toWireTag:r=>r,toWireMediaMetaPush:r=>r}
  h.mocks["@/api/endpoints"]={uploadMedia:async()=>{throw Error("protected media uploaded")},pushBatch:async body=>{sent.push(body);return {serverTime:SERVER,entries:body.entries.map(r=>({id:r.id,status:"applied"})),tags:body.tags.map(r=>({id:r.id,status:"applied"})),mediaMeta:body.mediaMeta.map(r=>({id:r.id,status:"applied"}))}},pullChanges:async()=>({serverTime:SERVER,syncUntil:SERVER,cursorId:"",hasMore:false,entries:[],tags:[],mediaMeta:[]})}
  await h.load("api/sync.ts").runSync();assert.ok(sent.length)
  const entries=sent.flatMap(b=>b.entries),tags=sent.flatMap(b=>b.tags)
  assert.deepEqual(entries.map(r=>r.id),[LOCAL_TAG]);assert.deepEqual(tags.map(r=>r.id),[SECOND]);assert.ok(!tags.some(r=>r.id===plan.copies[0].tag.id));assert.equal((await h.db.tags.get(TAG)).dirty,1);assert.equal((await h.db.entries.get(OTHER_ENTRY)).dirty,1)
})
for(const choice of [CHOICE,KEEP])test(`independent naming covers all current tags in selected diary order for ${choice}`,async()=>{
  const h=await tagSetFixture("disjoint",choice)
  h.preparer=h.load("db/scheduleSharedTagCopyRepo.ts").createInternalSharedTagCopyPreparer(h.transport)
  const selected=choice===KEEP?await h.db.entries.get(ID):{tagIds:h.reply.review.entry.tag_ids}
  const names=selected.tagIds.map((from,index)=>({from,name:`独立命名${index+1}`})),r=await h.preparer.review(ID,h.file,choice,[...names].reverse())
  assert.equal(r.ready,true);const done=await h.preparer.prepare(r.reviewId,true);assert.equal(done.prepared,true)
  assert.deepEqual(done.copies.map(row=>row.from),selected.tagIds);assert.deepEqual(done.copies.map(row=>row.tag.name),names.map(row=>row.name))
  assert.equal(new Set(done.copies.map(row=>row.tag.id)).size,names.length)
})
for(const names of [[{from:TAG,name:"新名称"},{from:CLOUD_TAG,name:"新名称"}],[{from:TAG,name:"Café"},{from:CLOUD_TAG,name:"CAFE"}]])test(`duplicate new names across selected tags are not auto-adjusted: ${names[0].name}`,async()=>{
  const h=await tagSetFixture("disjoint"),preparer=h.load("db/scheduleSharedTagCopyRepo.ts").createInternalSharedTagCopyPreparer(h.transport),before=all(h)
  assert.equal((await preparer.review(ID,h.file,CHOICE,names)).ready,false);assert.equal(all(h),before)
})
test("tag-only shared definition conflict can prepare names without downloading or creating any image",async()=>{
  const h=await tagSetFixture("disjoint",KEEP,{noImages:true}),preparer=h.load("db/scheduleSharedTagCopyRepo.ts").createInternalSharedTagCopyPreparer(h.transport)
  const current=await h.db.entries.get(ID),r=await preparer.review(ID,h.file,KEEP,current.tagIds.map((from,i)=>({from,name:`无图独立${i}`})))
  assert.equal(r.ready,true);assert.equal((await preparer.prepare(r.reviewId,true)).prepared,true);assert.equal((await h.db.media.toArray()).length,0)
})
test("a name already reserved by another source blocks preparation without silently replacing that plan",async()=>{
  const h=await copyFixture(),packet=JSON.parse(h.fileText),check=h.load("shared/scheduleSharedTagCopy.ts").checkSharedTagCopyRecord
  // A valid independent second source uses its own stable diary identity and retains its original evidence.
  const first=await h.copyReview();assert.equal((await h.preparer.prepare(first.reviewId,true)).prepared,true)
  const existing=(await meta(h,ARCHIVE))[0],other=JSON.parse(JSON.stringify(existing).replaceAll(ID,OTHER_ENTRY))
  other.id="019a0300-1234-7000-8000-000000001020";other.copies[0].tag.id="019a0300-1234-7000-8000-000000001021"
  assert.equal(check(other).scheduleId,OTHER_ENTRY)
  await h.db.meta.put({key:ARCHIVE,value:[other]});const before=all(h),r=await h.copyReview()
  assert.equal(r.ready,true);assert.equal((await h.preparer.prepare(r.reviewId,true)).prepared,false);assert.equal(all(h),before)
  assert.equal(packet.scheduleId,ID)
})
test("duplicate reserved copy identities across archive plans fail closed even when a plan is discarded",async()=>{
  const h=await preparedCopy(),plan=(await meta(h,ARCHIVE))[0],other=structuredClone(plan)
  other.id="019a0300-1234-7000-8000-000000001020";other.state="discarded"
  await h.db.meta.put({key:ARCHIVE,value:[plan,other]});await assert.rejects(h.load("db/scheduleStateRepo.ts").protectedConversions())
})
test("prepared holds reject P2 cloud overwrites of original and reserved tags while allowing unrelated pulls",async()=>{
  const h=await preparedCopy(),plan=(await meta(h,ARCHIVE))[0]
  h.mocks["@/api/mappers"]={fromWireEntry:r=>r,fromWireTag:r=>r,mediaPatchFromWire:r=>r,toWireEntry:r=>r,toWireTag:r=>r,toWireMediaMetaPush:r=>r}
  h.mocks["@/api/endpoints"]={uploadMedia:async()=>{throw Error("upload")},pushBatch:async()=>{throw Error("push")},pullChanges:async()=>({serverTime:SERVER,syncUntil:SERVER,cursorId:"",hasMore:false,entries:[],tags:[{id:TAG,name:"do not overwrite",color:"red",createdAt:AT,dirty:0},{...plan.copies[0].tag,dirty:0},{id:SECOND,name:"普通云端标签",color:null,createdAt:AT,dirty:0}],mediaMeta:[]})}
  await h.load("api/sync.ts").runSync();assert.equal((await h.db.tags.get(TAG)).name,"共同标签");assert.equal(await h.db.tags.get(plan.copies[0].tag.id),undefined);assert.equal((await h.db.tags.get(SECOND)).name,"普通云端标签")
})
for(const boundary of ["final-get","write-wait"])for(const change of ["tag","bytes","catalog"])test(`independent preparation ${change} at ${boundary} cannot commit stale evidence`,async()=>{
  const mutate=async h=>{if(change==="tag")await h.db.tags.update(TAG,{name:"concurrent"});if(change==="bytes")await h.db.media.update(OTHER_ID,{blob:blob(png(8))});if(change==="catalog")await h.db.tags.put({id:SECOND,name:"concurrent catalog",color:null,createdAt:AT,dirty:0})}
  const h=await copyFixture(CHOICE,{onGet:async(h,n)=>{if(boundary==="final-get"&&n===2)await mutate(h)},onWait:async h=>{if(boundary==="write-wait")await mutate(h)}}),r=await h.copyReview(),before=all(h)
  assert.equal(r.ready,true);assert.equal((await h.preparer.prepare(r.reviewId,true)).prepared,false);assert.equal(await meta(h,ARCHIVE),undefined)
  if(boundary==="write-wait")assert.equal(all(h),before)
})
for(const mode of ["cancel","account","epoch"])test(`late ${mode} while discarding names retains complete archive`,async()=>{
  const h=await preparedCopy(),plan=(await meta(h,ARCHIVE))[0],before=all(h),put=h.db.meta.put
  h.db.meta.put=async row=>{await put(row);if(row.key===ARCHIVE){if(mode==="cancel")h.preparer.cancel();if(mode==="account")h.user("account-b");if(mode==="epoch")await put({key:"ownerGeneration",value:"restored"})}}
  assert.equal((await h.preparer.discard(plan.id,true)).discarded,false);assert.equal(all(h),before)
})
test("valid foreign-owner preparation is not exposed or applied to the current owner's resources",async()=>{
  const h=await preparedCopy(),plans=await meta(h,ARCHIVE),copy=plans[0].copies[0].tag.id
  plans[0].ownerUserId="account-b";await h.db.meta.put({key:ARCHIVE,value:plans})
  assert.equal((await h.preparer.listPrepared()).length,0);assert.equal((await h.load("db/scheduleStateRepo.ts").protectedConversions()).tagIds.has(copy),false)
  assert.equal((await h.preparer.discard(plans[0].id,true)).discarded,false)
})

const PUB_KIND="terminal-independent-tag-publication"
async function publisherFixture(choice=CHOICE,options={}) {
  const h=await preparedCopy(choice,{
    onGet:async(h,n)=>{if(h.publicationActive)await options.onGet?.(h,n)},
    onRead:async(h,n)=>{if(h.publicationActive)await options.onRead?.(h,n)},
    onWait:async h=>{if(h.publicationActive)await options.onWait?.(h)},
  })
  h.publicationActive=true;h.calls=[];h.posts=[];h.serverTags=new Map()
  h.transport.publish=async(id,body,lease,signal)=>{
    const records=await meta(h,ARCHIVE);assert.ok(records.some(row=>row.kind===PUB_KIND&&row.planId===body.plan_id))
    h.posts.push({id,body:structuredClone(body),lease:structuredClone(lease),signal})
    await options.beforePost?.(h,body,signal)
    const tags=body.copies.map(copy=>{
      const previous=h.serverTags.get(copy.id);if(previous&&(previous.name!==copy.name||previous.color!==copy.color))throw Error("server collision")
      const tag=previous??{id:copy.id,name:copy.name,color:copy.color,created_at:SERVER};h.serverTags.set(copy.id,tag)
      return {...tag,from_tag_id:copy.from_tag_id,created:!previous}
    })
    const receipt={proof_scope:"independent_tag_presence",tags_confirmed:true,resolution_enabled:false,diary_sync_enabled:false,schedule_id:id,plan_id:body.plan_id,tags}
    await options.afterPost?.(h,receipt,signal)
    return receipt
  }
  h.publisher=h.load("db/scheduleTagPublicationRepo.ts").createInternalScheduleTagPublisher(h.transport)
  h.publishReview=()=>h.publisher.review(h.done.planId,h.file)
  h.publications=async()=> (await meta(h,ARCHIVE)).filter(row=>row.kind===PUB_KIND)
  return h
}
for(const choice of [CHOICE,KEEP])test(`durable publication ${choice} confirms only new tag presence without live table changes`,async()=>{
  const h=await publisherFixture(choice),before=resources(h),queue=await meta(h,"scheduleConversions"),candidates=await meta(h,"scheduleConflicts"),plan=(await meta(h,ARCHIVE))[0]
  const r=await h.publishReview();assert.equal(r.ready,true);assert.equal((await h.publications()).length,0);assert.equal(h.posts.length,0)
  const done=await h.publisher.publish(r.reviewId,true);assert.equal(done.tagsConfirmed,true);assert.equal(done.diarySyncEnabled,false);assert.equal(done.resolutionEnabled,false)
  assert.equal(resources(h),before);assert.deepEqual(await meta(h,"scheduleConversions"),queue);assert.deepEqual(await meta(h,"scheduleConflicts"),candidates);assert.deepEqual((await meta(h,ARCHIVE))[0],plan)
  const publication=(await h.publications())[0];assert.equal(publication.state,"confirmed");assert.equal(publication.request.expected_resources.review.entry.title,"云端版本")
  assert.equal(publication.receipt.tags[0].id,plan.copies[0].tag.id);assert.equal(h.posts[0].lease.ownerUserId,"account-a");assert.equal(h.posts[0].lease.generation,"epoch")
  assert.equal(JSON.stringify(publication).includes("tokenGeneration"),false);assert.equal(await h.db.tags.get(plan.copies[0].tag.id),undefined)
  const held=await h.load("db/scheduleStateRepo.ts").protectedConversions();assert.ok(held.tagIds.has(TAG));assert.ok(held.tagIds.has(plan.copies[0].tag.id));assert.ok(held.entryIds.has(ID))
  const listed=await h.publisher.list();assert.equal(listed[0].historicalConfirmation,true);assert.equal(listed[0].requiresRecheck,true)
})
for(const mode of ["confirmation","review-id"])test(`publication ${mode} is explicit and starts no POST or archive write`,async()=>{
  const h=await publisherFixture(),r=await h.publishReview(),before=all(h),calls=h.calls.length,reads=h.reads
  assert.equal((await h.publisher.publish(mode==="review-id"?r.reviewId+1:r.reviewId,mode!=="confirmation")).tagsConfirmed,false)
  assert.equal(all(h),before);assert.equal(h.calls.length,calls);assert.equal(h.reads,reads);assert.equal(h.posts.length,0)
})
for(const choice of [CHOICE,KEEP])test(`lost publication response retries original IDs and original request after reload for ${choice}`,async()=>{
  let fail=true;const h=await publisherFixture(choice,{afterPost:async()=>{if(fail){fail=false;throw Error("lost response")}}}),r=await h.publishReview()
  assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,false);assert.equal((await h.publications())[0].state,"started");assert.equal(h.serverTags.size,1)
  h.publisher=h.load("db/scheduleTagPublicationRepo.ts").createInternalScheduleTagPublisher(h.transport)
  const listed=await h.publisher.list();assert.equal(listed[0].historicalConfirmation,false);assert.equal(h.posts.length,1)
  const next=await h.publishReview(),done=await h.publisher.publish(next.reviewId,true);assert.equal(done.tagsConfirmed,true);assert.equal(done.tags[0].created,false)
  assert.deepEqual(h.posts[0].body,h.posts[1].body);assert.equal((await h.publications()).length,1);assert.equal(h.serverTags.size,1)
})
test("confirmed publication is historical and explicit repeat rechecks presence instead of creating a second tag",async()=>{
  const h=await publisherFixture(),r=await h.publishReview();assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,true)
  const next=await h.publishReview();assert.equal(next.historicalConfirmation,true);assert.equal(h.posts.length,1)
  const done=await h.publisher.publish(next.reviewId,true);assert.equal(done.tagsConfirmed,true);assert.equal(done.tags[0].created,false);assert.equal(h.serverTags.size,1);assert.equal((await h.publications()).length,1)
})
for(const state of ["started","confirmed"])test(`publication ${state} cannot be discarded as unpublished local names`,async()=>{
  const h=await publisherFixture(CHOICE,{afterPost:async()=>{if(state==="started")throw Error("lost")}}),r=await h.publishReview()
  await h.publisher.publish(r.reviewId,true);const before=all(h)
  assert.equal((await h.preparer.discard(h.done.planId,true)).discarded,false);assert.equal(all(h),before)
})
for(const mode of ["account","relogin","epoch","local-title","local-bytes","catalog","file","cloud","cancel"])test(`publication preflight ${mode} cannot persist an intent or POST`,async()=>{
  const h=await publisherFixture(),r=await h.publishReview();assert.equal(r.ready,true)
  if(mode==="account")h.user("account-b")
  if(mode==="relogin"){h.user("account-b");h.user("account-a")}
  if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"new"})
  if(mode==="local-title")await h.db.entries.update(ID,{title:"new"})
  if(mode==="local-bytes")await h.db.media.update(OTHER_ID,{blob:blob(png(8))})
  if(mode==="catalog")await h.db.tags.put({id:SECOND,name:"new",color:null,createdAt:AT,dirty:0})
  if(mode==="file"){const p=JSON.parse(h.fileText);p.exportedAt="2026-10-11T00:00:00.000Z";h.fileText=JSON.stringify(p)}
  if(mode==="cloud")h.reply.tags[0].color="red"
  if(mode==="cancel")h.publisher.cancel()
  const before=all(h);assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,false);assert.equal(all(h),before);assert.equal(h.posts.length,0)
})
for(const mode of ["account","epoch","cancel","write-failure"])test(`publication intent ${mode} rolls back before any POST`,async()=>{
  const h=await publisherFixture(),r=await h.publishReview(),before=all(h),put=h.db.meta.put
  h.db.meta.put=async row=>{await put(row);if(row.key===ARCHIVE&&row.value.some(x=>x.kind===PUB_KIND)){
    if(mode==="account")h.user("account-b");if(mode==="epoch")await put({key:"ownerGeneration",value:"restored"});if(mode==="cancel")h.publisher.cancel();if(mode==="write-failure")throw Error("disk")
  }}
  assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,false);assert.equal(all(h),before);assert.equal(h.posts.length,0)
})
for(const mode of ["account","relogin","epoch","cancel","local-title","local-bytes","catalog","lost"])test(`publication after server commit ${mode} retains uncertain durable intent and never hands off`,async()=>{
  const h=await publisherFixture(CHOICE,{afterPost:async(h,_r,signal)=>{
    if(mode==="account")h.user("account-b");if(mode==="relogin"){h.user("account-b");h.user("account-a")}
    if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"restored"})
    if(mode==="cancel"){h.publisher.cancel();assert.equal(signal.aborted,true)}
    if(mode==="local-title")await h.db.entries.update(ID,{title:"new"})
    if(mode==="local-bytes")await h.db.media.update(OTHER_ID,{blob:blob(png(8))})
    if(mode==="catalog")await h.db.tags.put({id:SECOND,name:"new",color:null,createdAt:AT,dirty:0})
    if(mode==="lost")throw Error("network")
  }}),r=await h.publishReview();assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,false)
  assert.equal(h.serverTags.size,1);assert.equal((await h.publications())[0].state,"started");assert.equal(await h.db.tags.get(h.done.copies[0].tag.id),undefined)
  assert.equal((await meta(h,"scheduleConversions")).length,1);assert.deepEqual((await h.db.entries.get(ID)).tagIds,[TAG])
})
for(const field of ["scope","flag","diary-flag","resolution-flag","plan","source","id","from","name","color","created","timestamp","missing","extra","tag-extra"])test(`publication malformed receipt ${field} cannot be persisted as confirmation`,async()=>{
  const h=await publisherFixture(CHOICE,{afterPost:async(_h,r)=>{
    if(field==="scope")r.proof_scope="conversion_ack"
    if(field==="flag")r.tags_confirmed=1
    if(field==="diary-flag")r.diary_sync_enabled=true
    if(field==="resolution-flag")r.resolution_enabled=true
    if(field==="plan")r.plan_id=OTHER_ENTRY
    if(field==="source")r.schedule_id=OTHER_ENTRY
    if(field==="id")r.tags[0].id=TAG
    if(field==="from")r.tags[0].from_tag_id=OTHER_ENTRY
    if(field==="name")r.tags[0].name="not explicit"
    if(field==="color")r.tags[0].color="red"
    if(field==="created")r.tags[0].created=1
    if(field==="timestamp")r.tags[0].created_at="2026-02-30T00:00:00.000Z"
    if(field==="missing")r.tags=[]
    if(field==="extra")r.owner="private"
    if(field==="tag-extra")r.tags[0].owner="private"
  }}),r=await h.publishReview();assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,false);assert.equal((await h.publications())[0].state,"started")
})
for(const mode of ["failure","cancel","account","epoch"])test(`publication final local confirmation ${mode} keeps the started record for safe retry`,async()=>{
  const h=await publisherFixture(),r=await h.publishReview(),put=h.db.meta.put
  h.db.meta.put=async row=>{await put(row);if(row.key===ARCHIVE&&row.value.some(x=>x.kind===PUB_KIND&&x.state==="confirmed")){
    if(mode==="failure")throw Error("disk");if(mode==="cancel")h.publisher.cancel();if(mode==="account")h.user("account-b");if(mode==="epoch")await put({key:"ownerGeneration",value:"restored"})
  }}
  assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,false);assert.equal((await h.publications())[0].state,"started");assert.equal(h.serverTags.size,1)
})
for(const mode of ["bytes","tag","catalog"])test(`publication final byte wait rejects concurrent ${mode} and rolls back confirmation`,async()=>{
  let changed=false;const h=await publisherFixture(CHOICE,{onWait:async h=>{if(h.posts.length&&!changed){changed=true;if(mode==="bytes")await h.db.media.update(OTHER_ID,{blob:blob(png(9))});if(mode==="tag")await h.db.tags.update(TAG,{name:"changed"});if(mode==="catalog")await h.db.tags.put({id:SECOND,name:"new",color:null,createdAt:AT,dirty:0})}}}),r=await h.publishReview(),before=resources(h)
  assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,false);assert.equal(changed,true);assert.equal((await h.publications())[0].state,"started");assert.equal(resources(h),before)
})
for(const mode of ["duplicate","orphan","discarded-plan","request","state","receipt","unknown","digest-format"])test(`publication malformed archive ${mode} fails closed for P2 protection`,async()=>{
  const h=await publisherFixture(),r=await h.publishReview();assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,true)
  let rows=await meta(h,ARCHIVE);const p=rows.find(x=>x.kind===PUB_KIND)
  if(mode==="duplicate")rows.push(structuredClone(p))
  if(mode==="orphan")rows=rows.filter(x=>x.kind!=="terminal-independent-tag-copy")
  if(mode==="discarded-plan")rows[0].state="discarded"
  if(mode==="request")p.request.copies[0].name="other"
  if(mode==="state")p.state="discarded"
  if(mode==="receipt")p.receipt.tags[0].id=TAG
  if(mode==="unknown")p.unknown=true
  if(mode==="digest-format")p.planDigest="invalid"
  await h.db.meta.put({key:ARCHIVE,value:rows});await assert.rejects(h.load("db/scheduleStateRepo.ts").protectedConversions());await assert.rejects(h.publisher.list())
})
test("publication valid-format but wrong plan digest cannot resume or overwrite historical receipt",async()=>{
  const h=await publisherFixture(),r=await h.publishReview();await h.publisher.publish(r.reviewId,true)
  const rows=await meta(h,ARCHIVE);rows.find(x=>x.kind===PUB_KIND).planDigest="0".repeat(64);await h.db.meta.put({key:ARCHIVE,value:rows});const before=all(h)
  assert.equal((await h.publishReview()).ready,false);assert.equal(all(h),before);assert.equal(h.posts.length,1)
})
test("server-created timestamp changes never replace the previous confirmed publication identity",async()=>{
  const h=await publisherFixture(),r=await h.publishReview();await h.publisher.publish(r.reviewId,true)
  const before=(await h.publications())[0],tag=h.serverTags.get(h.done.copies[0].tag.id);tag.created_at="2026-10-09T00:00:00.000Z"
  const next=await h.publishReview();assert.equal(next.ready,true);assert.equal((await h.publisher.publish(next.reviewId,true)).tagsConfirmed,false)
  assert.deepEqual((await h.publications())[0],before)
})
for(const status of [404,409,422,500])test(`publication HTTP ${status} retains intent without automatic retry or compensation`,async()=>{
  const h=await publisherFixture(CHOICE,{beforePost:async()=>{throw Object.assign(Error("failure"),{status})}}),r=await h.publishReview()
  assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,false);assert.equal(h.posts.length,1);assert.equal((await h.publications())[0].state,"started");assert.equal(h.serverTags.size,0)
})
test("a cancelled in-flight publication stays busy until it settles and does not allow a parallel restart",async()=>{
  let release;const wait=new Promise(resolve=>release=resolve),h=await publisherFixture(CHOICE,{beforePost:async()=>wait}),r=await h.publishReview()
  const pending=h.publisher.publish(r.reviewId,true);while(!h.posts.length)await new Promise(resolve=>setTimeout(resolve,1))
  h.publisher.cancel();assert.equal((await h.publishReview()).reason,"busy");release();assert.equal((await pending).tagsConfirmed,false);assert.equal((await h.publications())[0].state,"started")
})
test("publication original wire dates are retained unchanged rather than posting normalized evidence",async()=>{
  const h=await publisherFixture();h.reply.tags[0].created_at=SERVER.replace(/Z$/,"")
  // Equal instants are allowed by evidence parsing, but the POST must echo the fresh raw server spelling.
  const r=await h.publishReview();assert.equal(r.ready,true);assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,true)
  assert.equal(h.posts[0].body.expected_resources.tags[0].created_at,SERVER.replace(/Z$/,""))
})

for(const at of [1,2])test(`publication cancellation during proof GET ${at} never reaches POST`,async()=>{
  const h=await publisherFixture(CHOICE,{onGet:async(h,n)=>{if(n===at)h.publisher.cancel()}}),r=await h.publishReview()
  if(at===1)assert.equal(r.ready,false);else{assert.equal(r.ready,true);assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,false)}
  assert.equal(h.posts.length,0);assert.equal((await h.publications()).length,0)
})
test("two independent publication callers converge to one intent and the same remote tag identities",async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),h=await publisherFixture(CHOICE,{beforePost:async h=>{if(h.posts.length===1)await gate}})
  const first=h.publisher,second=h.load("db/scheduleTagPublicationRepo.ts").createInternalScheduleTagPublisher(h.transport)
  const a=await first.review(h.done.planId,h.file),b=await second.review(h.done.planId,h.file)
  assert.equal(a.ready,true);assert.equal(b.ready,true);const pending=first.publish(a.reviewId,true)
  while(!h.posts.length)await new Promise(resolve=>setTimeout(resolve,1))
  assert.equal((await second.publish(b.reviewId,true)).tagsConfirmed,true);release();assert.equal((await pending).tagsConfirmed,true)
  assert.equal((await h.publications()).length,1);assert.equal(h.serverTags.size,1);assert.deepEqual(h.posts[0].body,h.posts[1].body)
})
test("a fresh review after same-owner relogin safely recovers an uncertain publication",async()=>{
  let once=true;const h=await publisherFixture(CHOICE,{afterPost:async h=>{if(once){once=false;h.user("account-b");h.user("account-a")}}}),r=await h.publishReview()
  assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,false)
  const next=await h.publishReview();assert.equal(next.ready,true);assert.equal((await h.publisher.publish(next.reviewId,true)).tagsConfirmed,true)
  assert.equal(h.posts[1].lease.tokenGeneration,2);assert.equal(h.serverTags.size,1)
})
test("raw wire spelling changes after an uncertain POST cannot silently replace the persisted request",async()=>{
  let once=true;const h=await publisherFixture(CHOICE,{afterPost:async()=>{if(once){once=false;throw Error("lost")}}}),r=await h.publishReview()
  await h.publisher.publish(r.reviewId,true);h.reply.tags[0].created_at=SERVER.replace(/Z$/,"");const before=all(h)
  assert.equal((await h.publishReview()).ready,false);assert.equal(all(h),before);assert.equal(h.posts.length,1)
})
test("physical evidence file changed after POST leaves the started record without local acknowledgement",async()=>{
  const h=await publisherFixture(CHOICE,{onRead:async h=>{if(h.posts.length){const p=JSON.parse(h.fileText);p.exportedAt="2026-10-12T00:00:00.000Z";h.fileText=JSON.stringify(p)}}}),r=await h.publishReview()
  assert.equal((await h.publisher.publish(r.reviewId,true)).tagsConfirmed,false);assert.equal((await h.publications())[0].state,"started");assert.equal(h.serverTags.size,1)
})
for(const state of ["started","confirmed"])test(`ordinary P2 with publication ${state} keeps prepared identities protected and still syncs unrelated data`,async()=>{
  const h=await publisherFixture(CHOICE,{afterPost:async()=>{if(state==="started")throw Error("lost")}}),r=await h.publishReview();await h.publisher.publish(r.reviewId,true)
  const sent=[];await h.db.entries.put(entry({id:OTHER_ENTRY,fromScheduleId:null,content:null,tagIds:[],dirty:1}))
  h.mocks["@/api/mappers"]={fromWireEntry:r=>r,fromWireTag:r=>r,mediaPatchFromWire:r=>r,toWireEntry:r=>r,toWireTag:r=>r,toWireMediaMetaPush:r=>r}
  h.mocks["@/api/endpoints"]={uploadMedia:async()=>{throw Error("protected upload")},pushBatch:async body=>{sent.push(body);return {serverTime:SERVER,entries:body.entries.map(r=>({id:r.id,status:"applied"})),tags:[],mediaMeta:[]}},pullChanges:async()=>({serverTime:SERVER,syncUntil:SERVER,cursorId:"",hasMore:false,entries:[],tags:h.done.copies.map(c=>({...c.tag,dirty:0})),mediaMeta:[]})}
  await h.load("api/sync.ts").runSync();assert.deepEqual(sent.flatMap(b=>b.entries.map(r=>r.id)),[OTHER_ENTRY]);assert.equal(await h.db.tags.get(h.done.copies[0].tag.id),undefined)
  assert.equal(h.posts.length,1);assert.equal((await meta(h,"scheduleConversions")).length,1);assert.equal((await h.db.tags.get(TAG)).dirty,1)
})
test("same-owner restore invalidates publication writes but retains historical confirmation and original safety holds",async()=>{
  const h=await publisherFixture(),r=await h.publishReview();await h.publisher.publish(r.reviewId,true)
  await h.db.meta.put({key:"ownerGeneration",value:"restored"});const before=all(h)
  assert.equal((await h.publisher.list())[0].currentEpoch,false);assert.equal((await h.publishReview()).ready,false);assert.equal(all(h),before)
  const held=await h.load("db/scheduleStateRepo.ts").protectedConversions();assert.ok(held.entryIds.has(ID));assert.ok(held.tagIds.has(h.done.copies[0].tag.id))
})
