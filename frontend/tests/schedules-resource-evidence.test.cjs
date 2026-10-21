const {test}=require("node:test"),assert=require("node:assert/strict")
const {ID,OTHER_ID,AT,content,schedule,terminal,entry,intent,setup}=require("./schedules-data-harness.cjs")
const TAG="019a0300-1234-7000-8000-000000000003",HIST="019a0300-1234-7000-8000-000000000004"
const image=id=>({schemaVersion:1,doc:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"图片与标签正文"}]},{type:"image",attrs:{src:`local://media/${id}`,alt:"完整原图"}}]}})
const media=(id=OTHER_ID,extra={})=>({id,entryId:ID,blob:new Blob(["original image bytes"],{type:"image/png"}),thumbBlob:new Blob(["thumb"],{type:"image/webp"}),mime:"image/png",width:3,height:2,size:20,sortOrder:0,remoteUrl:"https://private?token=must-not-export",thumbRemoteUrl:"https://private/thumb?signature=private",createdAt:AT,dirty:1,...extra})
const all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
async function fixture(){
  const h=setup();h.mocks["@/api/tokenStore"]=h.tokens
  await h.db.meta.put({key:"ownerUserId",value:"account-a"});await h.db.meta.put({key:"ownerGeneration",value:"epoch"})
  const current=entry({content:image(OTHER_ID),tagIds:[TAG]})
  await h.db.schedules.put(terminal());await h.db.entries.put(current)
  await h.db.meta.put({key:"scheduleConversions",value:[intent({ownerUserId:"account-a",protectedMediaIds:[HIST]})]})
  await h.db.meta.put({key:"scheduleConflicts",value:[{scheduleId:ID,kind:"conversion-entry",localEntry:entry({content:image(HIST),tagIds:[TAG]}),serverEntry:current},{scheduleId:HIST,kind:"unknown-other",token:"unrelated"}]})
  for(const m of [media(),media(HIST)])await h.db.media.put(m)
  await h.db.tags.put({id:TAG,name:"测试标签",color:"green",createdAt:AT,dirty:1})
  const exporter=h.load("db/scheduleResourceEvidenceRepo.ts").createInternalScheduleResourceEvidenceExporter()
  return {...h,exporter,codec:h.load("shared/scheduleResourceEvidence.ts"),io:h.load("io/scheduleResourceEvidenceFile.ts")}
}
function handle(options={}){let data=options.existing??"",saved=false;return {async getFile(){const text=options.corrupt&&saved?data.replace("original image bytes","other"):data;return {size:new Blob([text]).size,async text(){return text}}},async createWritable(){let staged="";return {async write(text){if(options.writeFail)throw new Error("disk full");staged=text},async close(){data=options.corrupt?staged.replace("图片与标签正文","different text"):staged;saved=true},async abort(){}}}}}
test("capture preserves current/historical images, thumbnails, tag definitions and first intent without releasing anything",async()=>{
  const h=await fixture(),before=all(h),r=await h.exporter.export(ID)
  assert.equal(r.ready,true);assert.equal(r.resolutionEnabled,false);assert.equal(r.evidence.completeLocalResources,true);assert.equal(all(h),before)
  assert.equal(r.evidence.media.length,2);assert.equal(r.evidence.tags[0].name,"测试标签")
  assert.equal(Buffer.from(r.evidence.media[0].blobBase64,"base64").toString(),"original image bytes")
  assert.equal(Buffer.from(r.evidence.media[0].thumbBase64,"base64").toString(),"thumb");assert.equal(r.evidence.media[0].thumbMime,"image/webp")
  assert.equal(r.evidence.state.intentions[0].entry.content.doc.content[0].content[0].text,"写成")
  const text=h.codec.serializeScheduleResourceEvidence(r.evidence)
  for(const private of ["ownerUserId","tokenGeneration","generation","https://private","must-not-export","signature=private"])assert.equal(text.includes(private),false)
  assert.equal(r.evidence.media[0].hadRemoteLink,true);assert.equal(h.codec.parseScheduleResourceEvidence(text).resolutionEnabled,false)
})
for(const mode of ["missing-image","missing-tag","remote-placeholder","missing-protected"]){
  test(`${mode} produces a precise incomplete snapshot, never a complete backup or writable choice`,async()=>{
    const h=await fixture();if(mode==="missing-tag")await h.db.tags.delete(TAG)
    else if(mode==="remote-placeholder")await h.db.media.put(media(OTHER_ID,{blob:new Blob([])}))
    else await h.db.media.delete(mode==="missing-protected"?HIST:OTHER_ID)
    const before=all(h),r=await h.exporter.export(ID);assert.equal(r.ready,true);assert.equal(r.evidence.completeLocalResources,false)
    assert.equal(mode==="missing-tag"?r.evidence.missingTagIds[0]:r.evidence.missingMediaIds[0],mode==="missing-tag"?TAG:mode==="missing-protected"?HIST:OTHER_ID)
    assert.equal(r.resolutionEnabled,false);assert.equal(all(h),before)
  })
}
for(const mode of ["unknown-media","foreign-media","wrong-size","foreign-intent","unknown-intent","unknown-candidate","future-content","external-image","draft","diary-draft","broken-conflicts","broken-p2","broken-purges"]){
  test(`${mode} fails closed without rewriting resources or exposing a partial file`,async()=>{
    const h=await fixture()
    if(mode==="unknown-media")await h.db.media.put(media(OTHER_ID,{privateToken:"keep"}))
    if(mode==="foreign-media")await h.db.media.put(media(OTHER_ID,{entryId:HIST}))
    if(mode==="wrong-size")await h.db.media.put(media(OTHER_ID,{size:999}))
    if(mode==="foreign-intent"||mode==="unknown-intent"){const rows=(await h.db.meta.get("scheduleConversions")).value;if(mode==="foreign-intent")rows[0].ownerUserId="account-b";else rows[0].privateToken="keep";await h.db.meta.put({key:"scheduleConversions",value:rows})}
    if(mode==="unknown-candidate"){const rows=(await h.db.meta.get("scheduleConflicts")).value;rows[0].token="do not leak";await h.db.meta.put({key:"scheduleConflicts",value:rows})}
    if(mode==="future-content"){const r=await h.db.entries.get(ID);r.content.schemaVersion=999;await h.db.entries.put(r)}
    if(mode==="external-image"){const r=await h.db.entries.get(ID);r.content.doc.content[1].attrs.src="https://remote/?token=private";await h.db.entries.put(r)}
    if(mode==="draft")await h.db.meta.put({key:"scheduleDraft",value:{unknown:"keep"}})
    if(mode==="diary-draft")await h.db.meta.put({key:"draft",value:{text:"keep unsaved"}})
    if(mode==="broken-conflicts")await h.db.meta.put({key:"scheduleConflicts",value:{keep:"broken"}})
    if(mode==="broken-p2")await h.db.meta.put({key:"conflicts",value:{keep:"broken"}})
    if(mode==="broken-purges")await h.db.meta.put({key:"pendingPurges",value:{keep:"broken"}})
    const before=all(h),r=await h.exporter.export(ID);assert.equal(r.ready,false);assert.equal(r.evidence,undefined);assert.equal(all(h),before)
  })
}
for(const mode of ["account","relogin","epoch","source","entry","candidate","tag","same-size-bytes","thumbnail","deleted-image"]){
  test(`change during binary encoding: ${mode} rejects stale evidence and retains the original protection`,async()=>{
    const h=await fixture(),original=Blob.prototype.arrayBuffer;let changed=false,after
    Blob.prototype.arrayBuffer=async function(){const result=await original.call(this);if(!changed){changed=true
      if(mode==="account")h.user("account-b");if(mode==="relogin"){h.user("account-b");h.user("account-a")}
      if(mode==="epoch")await h.db.meta.put({key:"ownerGeneration",value:"new epoch"})
      if(mode==="source")await h.db.schedules.put(terminal({title:"changed"}))
      if(mode==="entry")await h.db.entries.put(entry({title:"changed"}))
      if(mode==="candidate"){const rows=(await h.db.meta.get("scheduleConflicts")).value;rows[0].localEntry.title="changed";await h.db.meta.put({key:"scheduleConflicts",value:rows})}
      if(mode==="tag")await h.db.tags.put({id:TAG,name:"changed",color:null,createdAt:AT,dirty:1})
      if(mode==="same-size-bytes")await h.db.media.put(media(OTHER_ID,{blob:new Blob(["different same bytes"],{type:"image/png"})}))
      if(mode==="thumbnail")await h.db.media.put(media(OTHER_ID,{thumbBlob:new Blob(["other"],{type:"image/webp"})}))
      if(mode==="deleted-image")await h.db.media.delete(OTHER_ID)
      after=all(h)
    }return result}
    try{const r=await h.exporter.export(ID);assert.equal(r.ready,false);assert.equal(all(h),after)}finally{Blob.prototype.arrayBuffer=original}
  })
}
for(const mode of ["private-root","private-media","private-intent","false-complete","wrong-missing","duplicate-media","bad-base64","pad-bits","bad-size","wrong-binding","resolution","meaning","future","missing-thumb-mime"]){
  test(`read-only package rejects ${mode} rather than accepting it as an authority`,async()=>{
    const h=await fixture(),r=await h.exporter.export(ID),e=structuredClone(r.evidence)
    if(mode==="private-root")e.token="keep";if(mode==="private-media")e.media[0].remoteUrl="https://private"
    if(mode==="private-intent")e.state.intentions[0].ownerUserId="account-a"
    if(mode==="false-complete")e.completeLocalResources=false;if(mode==="wrong-missing")e.missingTagIds=[TAG]
    if(mode==="duplicate-media")e.media.push(e.media[0]);if(mode==="bad-base64")e.media[0].blobBase64="%bad"
    if(mode==="pad-bits"){e.media[0].blobBase64="YR==";e.media[0].size=1}
    if(mode==="bad-size")e.media[0].size++;if(mode==="wrong-binding")e.media[0].entryId=HIST
    if(mode==="resolution")e.resolutionEnabled=true;if(mode==="meaning")e.meaning="confirmed"
    if(mode==="future")e.formatVersion=999;if(mode==="missing-thumb-mime")e.media[0].thumbMime=null
    assert.throws(()=>h.codec.parseScheduleResourceEvidence(JSON.stringify(e)))
  })
}
for(const mode of ["ok","corrupt","write-failure","existing"]){
  test(`resource file ${mode} uses verified close/read without modifying queue, media or source`,async()=>{
    const h=await fixture(),r=await h.exporter.export(ID),before=all(h),target=handle({corrupt:mode==="corrupt",writeFail:mode==="write-failure",existing:mode==="existing"?"keep old file":""})
    const preserve=h.io.createScheduleResourceEvidenceFilePreserver(target)
    if(mode==="ok"){await preserve(r.evidence);const file=await target.getFile(),opened=await h.io.readScheduleResourceEvidenceFile(file);assert.equal(opened.media.length,2);assert.equal(opened.resolutionEnabled,false)}
    else await assert.rejects(preserve(r.evidence))
    assert.equal(all(h),before)
  })
}
test("target P2 candidate bodies and deleted/orphaned local media remain independently preserved",async()=>{
  const h=await fixture();await h.db.meta.put({key:"conflicts",value:[{entryId:ID,at:AT,local:entry({content:image(HIST),tagIds:[TAG]}),server:entry({content:image(OTHER_ID)})}]})
  await h.db.media.put(media(HIST,{entryId:"",orphanedAt:AT}));await h.db.entries.put(entry({content:image(OTHER_ID),isDeleted:1,deletedAt:AT}))
  const r=await h.exporter.export(ID);assert.equal(r.ready,true);assert.equal(r.evidence.state.p2Conflicts.length,1);assert.equal(r.evidence.state.entry.isDeleted,1);assert.equal(r.evidence.media.find(m=>m.id===HIST).orphanedAt,AT)
})
test("absent diary is recorded as absent, never regenerated while exporting",async()=>{
  const h=await fixture();await h.db.entries.delete(ID);const r=await h.exporter.export(ID);assert.equal(r.ready,true);assert.equal(r.evidence.state.entry,null);assert.equal(await h.db.entries.get(ID),undefined)
})
test("unreferenced media associated with this diary is retained, unrelated tags/media are not exported",async()=>{
  const h=await fixture(),extra="019a0300-1234-7000-8000-000000000005";await h.db.media.put(media(extra));await h.db.tags.put({id:HIST,name:"unrelated",color:null,createdAt:AT,dirty:1})
  const r=await h.exporter.export(ID);assert.equal(r.evidence.media.length,3);assert.equal(r.evidence.tags.length,1)
})
test("no automatic mount, requests, or rich-resolution unlock is introduced",async()=>{
  const h=await fixture(),fs=require("node:fs"),path=require("node:path")
  for(const name of ["repo/index.ts","router/index.ts","api/sync.ts"]){assert.equal(fs.readFileSync(path.join(__dirname,"../src",name),"utf8").includes("createInternalScheduleResourceEvidenceExporter"),false)}
  assert.equal((await h.exporter.export("bad")).ready,false)
  await h.db.meta.put({key:"scheduleConversions",value:[]});await h.db.meta.put({key:"scheduleConflicts",value:[]});assert.equal((await h.exporter.export(ID)).ready,false)
})
for(const mode of ["legacy-p2","unknown-tag","thumb-mime","oversized-binary"]){
  test(`${mode} cannot bypass complete-resource or known-field rules`,async()=>{
    const h=await fixture()
    if(mode==="legacy-p2")await h.db.meta.put({key:"conflicts",value:[{at:AT,local:entry(),server:entry()}]})
    if(mode==="unknown-tag")await h.db.tags.put({id:TAG,name:"keep",color:null,createdAt:AT,dirty:1,privateToken:"do not leak"})
    if(mode==="thumb-mime")await h.db.media.put(media(OTHER_ID,{thumbBlob:new Blob(["thumb"])}))
    if(mode==="oversized-binary"){const blob=new Blob([new Uint8Array(h.codec.RESOURCE_EVIDENCE_MAX_BINARY+1)]);await h.db.media.put(media(OTHER_ID,{blob,size:blob.size,thumbBlob:null}))}
    const before=all(h);assert.equal((await h.exporter.export(ID)).ready,false);assert.equal(all(h),before)
  })
}
test("binary read failure returns no partial package and retains all protection",async()=>{
  const h=await fixture(),before=all(h),original=Blob.prototype.arrayBuffer
  Blob.prototype.arrayBuffer=async()=>{throw new Error("read blocked")}
  try{assert.equal((await h.exporter.export(ID)).ready,false);assert.equal(all(h),before)}finally{Blob.prototype.arrayBuffer=original}
})
test("resource exporter is single-flight and does not start competing byte reads",async()=>{
  const h=await fixture(),original=Blob.prototype.arrayBuffer;let release,started
  const gate=new Promise(resolve=>{release=resolve}),began=new Promise(resolve=>{started=resolve});let first=true
  Blob.prototype.arrayBuffer=async function(){if(first){first=false;started();await gate}return original.call(this)}
  try{const result=h.exporter.export(ID);await began;assert.equal((await h.exporter.export(ID)).reason,"busy");release();assert.equal((await result).ready,true)}finally{Blob.prototype.arrayBuffer=original}
})
test("known empty journal is allowed but an empty-to-empty revision change invalidates byte capture",async()=>{
  const h=await fixture();await h.db.meta.put({key:"scheduleDraft",value:{formatVersion:1,revision:3,draft:null}})
  assert.equal((await h.exporter.export(ID)).ready,true)
  const original=Blob.prototype.arrayBuffer;let changed=false
  Blob.prototype.arrayBuffer=async function(){const value=await original.call(this);if(!changed){changed=true;await h.db.meta.put({key:"scheduleDraft",value:{formatVersion:1,revision:4,draft:null}})}return value}
  try{assert.equal((await h.exporter.export(ID)).ready,false)}finally{Blob.prototype.arrayBuffer=original}
})
test("actual isolated resource file close/read keeps original and thumbnail bytes and never becomes a restore",async()=>{
  const h=await fixture(),r=await h.exporter.export(ID),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path")
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"quire-resource-")),dest=path.join(dir,"resource.json")
  try{
    await fs.writeFile(dest,"")
    const target={async getFile(){const text=await fs.readFile(dest,"utf8");return {size:Buffer.byteLength(text),async text(){return text}}},async createWritable(){let staged="";return {async write(text){staged=text},async close(){await fs.writeFile(dest,staged)},async abort(){}}}}
    await h.io.createScheduleResourceEvidenceFilePreserver(target)(r.evidence)
    const result=await h.io.readScheduleResourceEvidenceFile(await target.getFile())
    assert.equal(Buffer.from(result.media[0].blobBase64,"base64").toString(),"original image bytes")
    assert.equal(Buffer.from(result.media[0].thumbBase64,"base64").toString(),"thumb")
    assert.equal(result.resolutionEnabled,false);assert.equal(result.tags[0].name,"测试标签")
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})

test("pending purge is explicitly recorded as evidence, never replayed or dropped from the real queue",async()=>{
  const h=await fixture();await h.db.meta.put({key:"pendingPurges",value:[ID]});const before=all(h),r=await h.exporter.export(ID)
  assert.equal(r.ready,true);assert.equal(r.evidence.entryPendingPurge,true);assert.equal(r.resolutionEnabled,false);assert.equal(all(h),before)
})
test("unknown reason text remains private and fails evidence export rather than being treated as a protocol reason",async()=>{
  const h=await fixture(),rows=(await h.db.meta.get("scheduleConflicts")).value
  rows[0]={scheduleId:ID,kind:"conversion-ack",reason:"a_private_token",firstIntent:intent({ownerUserId:"account-a"}),serverSchedule:terminal(),serverEntry:entry()}
  await h.db.meta.put({key:"scheduleConflicts",value:rows});const before=all(h)
  assert.equal((await h.exporter.export(ID)).ready,false);assert.equal(all(h),before)
})
