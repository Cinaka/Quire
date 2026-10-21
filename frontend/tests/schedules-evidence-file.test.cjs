const {test}=require("node:test"),assert=require("node:assert/strict")
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os")
const {ID,OTHER_ID,AT,content,schedule,terminal,entry,intent,setup}=require("./schedules-data-harness.cjs")
const SERVER="2026-10-08T10:00:02.000Z",MICRO="2026-10-08T10:00:01.123456Z"
const KEEP="cloud-source-keep-diary",CLOUD="cloud-source-use-diary"
function sourceWire(r){return {id:r.id,remind_date:r.remindDate,title:r.title,content:r.content,content_text:r.contentText,status:r.status,
  converted_entry_id:r.convertedEntryId,converted_at:r.convertedAt,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
function entryWire(r){return {id:r.id,from_schedule_id:r.fromScheduleId,entry_date:r.entryDate,sort_order:r.sortOrder,title:r.title,content:r.content,
  content_text:r.contentText,mood:r.mood,weather:r.weather,tag_ids:r.tagIds,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
function fixture(){
  const h=setup();h.mocks["@/api/tokenStore"]=h.tokens
  const codec=h.load("shared/scheduleConflictEvidenceFile.ts"),io=h.load("io/scheduleConflictEvidenceFile.ts")
  const local=schedule({title:"本机计划"}),server=schedule({title:"云端计划",serverUpdatedAt:SERVER,updatedAt:SERVER,dirty:0})
  const pending=h.load("shared/scheduleConflict.ts").conflictEvidence({id:ID,server,snapshot:{local,records:[{scheduleId:ID,kind:"schedule-push",reason:"stale",submitted:local,expectedServerRevision:AT,serverSchedule:server}],queue:[],linkedEntries:[],draft:null}},"keep-local")
  const source=terminal(),diary=entry({title:"现在本机正文"}),remote=entry({title:"云端当前正文",clientUpdatedAt:MICRO,serverUpdatedAt:SERVER,updatedAt:SERVER,dirty:0})
  const cloud=terminal({title:"云端第一次",serverUpdatedAt:SERVER,updatedAt:SERVER,dirty:0}),first=intent({ownerUserId:"account-a"})
  const reply={read_only:true,reviewable:true,reason:"terminal_review",receipt_known:true,first_entry_date:"2026-10-07",first_entry_deleted:false,
    schedule:sourceWire(cloud),entry:entryWire(remote),entry_state:"active"}
  const review=h.load("shared/scheduleTerminalReview.ts").parseScheduleTerminalReview(reply,ID)
  const localState={source,entry:diary,linkedEntries:[diary],intentions:[first],candidates:[{scheduleId:ID,kind:"conversion-ack",reason:"server_entry_changed",firstIntent:first,serverSchedule:cloud,serverEntry:remote}],media:[],pendingPurges:[],p2Conflicts:[],scheduleDraft:null,diaryDraft:null}
  const ticket={id:ID,lease:{ownerUserId:"account-a"},fingerprint:"",server:review,local:localState}
  const terminalEvidence=h.load("shared/scheduleTerminalConflict.ts").terminalConflictEvidence(ticket,KEEP)
  return {h,codec,io,pending,terminalEvidence,source,diary,first,reply,localState}
}
const file=text=>({size:new Blob([text]).size,async text(){return text}})
function handle(options={}){
  let data=options.existing??"",writes=0,opens=0,closes=0,aborts=0,reads=0
  const events=[]
  return {events,stats:()=>({data,writes,opens,closes,aborts,reads}),async getFile(){
    reads++;events.push("read");if(options.getFile)await options.getFile(reads)
    if(options.failReadAt===reads)throw new Error("permission denied")
    if(options.changedBeforeWrite&&reads===2)data="keep another user's file"
    const value=options.corrupt&&closes?data.replace("现在本机正文","wrong saved diary"):data
    const f=file(value);if(options.savedSizeMismatch&&closes)f.size++
    if(options.readFail&&closes)f.text=async()=>{throw new Error("read denied")}
    return f
  },async createWritable(config){
    opens++;events.push("open");assert.equal(config.mode,"exclusive");assert.equal(config.keepExistingData,false)
    if(options.openFail)throw new Error("not supported")
    let staged=""
    return {async write(text){writes++;events.push("write");if(options.writeHook)await options.writeHook();if(options.writeFail)throw new Error("disk full");staged=text},
      async close(){closes++;events.push("close");if(options.closeFail)throw new Error("close failed");data=staged},async abort(){aborts++;events.push("abort");if(options.abortFail)throw new Error("abort failed")}}
  }}
}
for(const name of ["pending","terminalEvidence"]){
  test(`${name} creates and safely reopens a distinct non-backup evidence file`,async()=>{
    const f=fixture(),text=f.codec.serializeConflictEvidenceFile(f[name]),parsed=f.codec.parseConflictEvidenceFile(text)
    assert.equal(JSON.stringify(parsed),JSON.stringify(f[name]));assert.equal(text.endsWith("\n"),true)
    const read=await f.io.readConflictEvidenceFile(file(text));assert.equal(JSON.stringify(read),JSON.stringify(parsed))
    for(const secret of ["ownerUserId","tokenGeneration","generation","Bearer"])assert.equal(text.includes(secret),false)
    const target=handle();const preserve=f.io.createConflictEvidenceFilePreserver(target)
    await preserve(f[name]);assert.equal(target.stats().data,text);assert.equal(target.stats().closes,1);assert.equal(target.stats().reads,3)
    await assert.rejects(preserve(f[name]));assert.equal(target.stats().writes,1)
    assert.match(f.codec.conflictEvidenceFileName(f[name]),/^quire-conflict-019a.*\.json$/)
    assert.equal(f.codec.conflictEvidenceFileName(f[name]).includes("计划"),false)
  })
}
test("file validation preserves microseconds and immutable first text without claiming a live confirmation",()=>{
  const f=fixture(),r=f.codec.parseConflictEvidenceFile(f.codec.serializeConflictEvidenceFile(f.terminalEvidence))
  assert.equal(r.cloudReview.entry.clientUpdatedAt,MICRO);assert.equal(r.intentions[0].entry.title,"日记")
  assert.equal(r.meaning,"explicit_choice_not_first_intent_confirmation");assert.equal(r.cloudReview.firstEntryDate,"2026-10-07")
  r.intentions[0].entry.title="change returned copy";assert.equal(f.terminalEvidence.intentions[0].entry.title,"日记")
})
for(const mode of ["app","format","version","time","id","choice","meaning","private-root","private-intent","private-candidate","missing","source","entry-id","cloud-field","cloud-dirty","cloud-state","first-date","tag","image","future-content"]){
  test(`damaged or unsupported ${mode} evidence fails before opening any writable file`,async()=>{
    const f=fixture(),e=structuredClone(f.terminalEvidence)
    if(mode==="app")e.app="other";if(mode==="format")e.format="backup";if(mode==="version")e.formatVersion=2
    if(mode==="time")e.exportedAt="2026-02-30T00:00:00.000Z";if(mode==="id")e.scheduleId=OTHER_ID
    if(mode==="choice")e.choice="automatically-convert";if(mode==="meaning")e.meaning="confirmed"
    if(mode==="private-root")e.token="private";if(mode==="private-intent")e.intentions[0].ownerUserId="account-a"
    if(mode==="private-candidate")e.candidates[0].token="private";if(mode==="missing")delete e.localEntry
    if(mode==="source")e.localSource.status="pending";if(mode==="entry-id")e.localEntry.fromScheduleId=OTHER_ID
    if(mode==="cloud-field")e.cloudReview.entry.privateHash="private";if(mode==="cloud-dirty")e.cloudReview.entry.dirty=1
    if(mode==="cloud-state")e.cloudReview.entryState="purged";if(mode==="first-date")e.cloudReview.firstEntryDate="bad"
    if(mode==="tag")e.localEntry.tagIds=[OTHER_ID]
    if(mode==="image")e.candidates[0].firstIntent.entry.content={schemaVersion:1,doc:{type:"doc",content:[{type:"image",attrs:{src:`local://media/${OTHER_ID}`}}]}}
    if(mode==="future-content")e.localEntry.content.schemaVersion=999
    const target=handle();await assert.rejects(f.io.createConflictEvidenceFilePreserver(target)(e));assert.equal(target.stats().opens,0)
    assert.throws(()=>f.codec.parseConflictEvidenceFile(JSON.stringify(e)))
  })
}
for(const mode of ["malformed","backup","empty","huge","deep","many"]){
  test(`${mode} file is not treated as a restore instruction`,()=>{
    const f=fixture();let text=""
    if(mode==="malformed")text="{partial";if(mode==="backup")text=JSON.stringify({app:"quire",formatVersion:3,entries:[],tags:[],media:[]})
    if(mode==="huge")text=" ".repeat(f.codec.CONFLICT_EVIDENCE_MAX_CHARS+1)
    if(mode==="deep")text=JSON.stringify({a:JSON.parse('['.repeat(70)+'0'+']'.repeat(70))})
    if(mode==="many")text=JSON.stringify({a:Array(100001).fill(0)})
    assert.throws(()=>f.codec.parseConflictEvidenceFile(text))
  })
}
for(const mode of ["existing","changedBeforeWrite","openFail","writeFail","closeFail","corrupt","savedSizeMismatch","readFail"]){
  test(`${mode} cannot satisfy the preservation callback or overwrite an existing destination`,async()=>{
    const f=fixture(),options={[mode]:true};if(mode==="existing")options.existing="must keep"
    const target=handle(options);await assert.rejects(f.io.createConflictEvidenceFilePreserver(target)(f.terminalEvidence))
    if(mode==="existing"){assert.equal(target.stats().data,"must keep");assert.equal(target.stats().opens,0)}
    if(mode==="changedBeforeWrite"){assert.equal(target.stats().writes,0);assert.equal(target.stats().aborts,1)}
    if(mode==="writeFail"||mode==="closeFail")assert.equal(target.stats().aborts,1)
  })
}
test("abort failure never converts a failed write into success",async()=>{
  const f=fixture(),target=handle({writeFail:true,abortFail:true})
  await assert.rejects(f.io.createConflictEvidenceFilePreserver(target)(f.pending),/disk full/)
})
test("single-flight prevents simultaneous file overwrite",async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve})
  const f=fixture(),target=handle({writeHook:()=>gate}),preserve=f.io.createConflictEvidenceFilePreserver(target)
  const saving=preserve(f.pending);await assert.rejects(preserve(f.terminalEvidence));release();await saving;assert.equal(target.stats().writes,1)
})
for(const mode of ["size","read-length","read-error"]){
  test(`read-only ${mode} failure does not return accepted evidence`,async()=>{
    const f=fixture(),text=f.codec.serializeConflictEvidenceFile(f.pending),input=file(text)
    if(mode==="size")input.size=Infinity;if(mode==="read-length")input.size++
    if(mode==="read-error")input.text=async()=>{throw new Error("read blocked")}
    await assert.rejects(f.io.readConflictEvidenceFile(input))
  })
}
test("actual isolated filesystem close/read round-trip retains both text versions",async()=>{
  const f=fixture(),dir=await fs.mkdtemp(path.join(os.tmpdir(),"quire-evidence-")),dest=path.join(dir,"evidence.json")
  try{
    await fs.writeFile(dest,"")
    const target={async getFile(){return file(await fs.readFile(dest,"utf8"))},async createWritable(){let staged="";return {
      async write(text){staged=text},async close(){await fs.writeFile(dest,staged)},async abort(){}}}}
    await f.io.createConflictEvidenceFilePreserver(target)(f.terminalEvidence)
    const opened=await f.io.readConflictEvidenceFile(await target.getFile())
    assert.equal(opened.localEntry.title,"现在本机正文");assert.equal(opened.cloudReview.entry.title,"云端当前正文")
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})
for(const mode of ["ok","corrupt","closeFail","account-change"]){
  test(`real terminal resolver + file adapter ${mode} hands off protection only after verified preservation`,async()=>{
    const f=fixture(),{h}=f
    await h.db.meta.put({key:"ownerUserId",value:"account-a"});await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
    await h.db.schedules.put(f.source);await h.db.entries.put(f.diary)
    await h.db.meta.put({key:"scheduleConversions",value:[f.first]});await h.db.meta.put({key:"scheduleConflicts",value:f.localState.candidates})
    const resolver=h.load("db/scheduleTerminalConflictRepo.ts").createInternalScheduleTerminalConflictResolver({async review(){return f.reply}})
    const r=await resolver.review(ID),target=handle({corrupt:mode==="corrupt",closeFail:mode==="closeFail",getFile:async n=>{if(mode==="account-change"&&n===3)h.user("account-b")}})
    const before=JSON.stringify([...h.stores.meta.rows.values()]),result=await resolver.resolve(r.reviewId,CLOUD,true,f.io.createConflictEvidenceFilePreserver(target))
    assert.equal(result.applied,mode==="ok")
    if(mode==="ok"){assert.equal((await h.db.meta.get("scheduleConversions")).value.length,0);assert.equal((await h.db.entries.get(ID)).title,"云端当前正文")}
    else{assert.equal(JSON.stringify([...h.stores.meta.rows.values()]),before);assert.equal((await h.db.entries.get(ID)).title,"现在本机正文")}
  })
}
test("reopening evidence never writes storage, makes a cloud request, or mounts a formal route",async()=>{
  const f=fixture(),before=JSON.stringify([...f.h.stores.meta.rows.values()])
  await f.io.readConflictEvidenceFile(file(f.codec.serializeConflictEvidenceFile(f.terminalEvidence)))
  assert.equal(JSON.stringify([...f.h.stores.meta.rows.values()]),before)
  const raw=require("node:fs");for(const name of ["repo/index.ts","router/index.ts","api/sync.ts"]){assert.equal(raw.readFileSync(path.join(__dirname,"../src",name),"utf8").includes("ConflictEvidenceFilePreserver"),false)}
})

for(const mode of ["ok","remote-change"]){
  test(`pending resolver + verified file ${mode} rechecks remote after file close`,async()=>{
    const f=fixture(),{h}=f
    await h.db.meta.put({key:"ownerUserId",value:"account-a"});await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
    await h.db.schedules.put(f.pending.local);await h.db.meta.put({key:"scheduleConflicts",value:f.pending.candidates})
    let calls=0,remote=f.pending.server
    const resolver=h.load("db/scheduleConflictRepo.ts").createInternalScheduleConflictResolver({async detail(){calls++;return sourceWire(remote)}})
    const r=await resolver.review(ID),before=JSON.stringify([...h.stores.meta.rows.values()])
    const target=handle({getFile:async n=>{if(mode==="remote-change"&&n===3)remote={...remote,title:"changed during file save"}}})
    const result=await resolver.resolve(r.reviewId,"use-cloud",true,f.io.createConflictEvidenceFilePreserver(target))
    assert.equal(result.applied,mode==="ok");assert.equal(calls,3)
    if(mode==="remote-change"){assert.equal(result.reason,"server_changed_reopen");assert.equal(JSON.stringify([...h.stores.meta.rows.values()]),before)}
    else assert.equal((await h.db.meta.get("scheduleConflicts")).value.length,0)
  })
}
