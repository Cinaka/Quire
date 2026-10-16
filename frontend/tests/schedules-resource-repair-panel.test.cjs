const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path")
const {loadTS}=require("./schedules-harness.cjs"),{ID,OTHER_ID}=require("./schedules-data-harness.cjs")
const EXTRA="019a0300-1234-7000-8000-000000000003",POLICY="bytes_only_never_replay_archived_choice_or_business_state"
const plain=value=>JSON.parse(JSON.stringify(value)),deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const ready=()=>({ready:true,reason:"explicit_missing_bytes_confirmation",reviewId:7,steps:[{mediaId:OTHER_ID,createRow:true,fillOriginal:true,fillThumbnail:true}],resolutionEnabled:false,unusedFileMediaIds:[],fileFormat:"terminal-local-resource-evidence",fileStatePolicy:POLICY})
const repaired=()=>({repaired:true,reason:"local_missing_bytes_repaired",resolutionEnabled:false,intentStatus:"unchanged_protected"})
function fixture(){const h={calls:[],reads:0,cancels:0,response:ready(),result:repaired()}
 h.port={async prepare(...args){h.calls.push(["prepare",...args]);return h.prepare?h.prepare(...args):h.response},async repair(...args){h.calls.push(["repair",...args]);return h.repair?h.repair(...args):h.result},cancel(){h.cancels++}}
 h.panel=loadTS("shared/scheduleResourceRepairPanel.ts").createScheduleResourceRepairPanel(h.port,ID,[OTHER_ID,EXTRA])
 h.file={name:"本机证据.json",size:12,async text(){h.reads++;return"private"}}
 h.choose=()=>{h.panel.setFile(h.file);h.panel.select([OTHER_ID])};return h
}
test("mount and selection never read a file, GET proof, select all or import bytes",()=>{
 const h=fixture();assert.deepEqual(plain(h.panel.inspect().selectedIds),[]);h.choose()
 assert.equal(h.calls.length,0);assert.equal(h.reads,0);assert.equal(h.panel.inspect().preview,null);assert.equal(h.panel.inspect().confirmed,false)
 const state=h.panel.inspect();state.selectedIds.push(EXTRA);state.fileInfo.name="changed";assert.equal(h.panel.inspect().selectedIds.length,1);assert.equal(h.panel.inspect().fileInfo.name,h.file.name)
})
test("explicit prepare then separate strict checkbox confirmation is required for repair",async()=>{
 const h=fixture();h.choose();assert.equal(await h.panel.apply(),false);assert.equal(await h.panel.prepare(),true)
 assert.equal(h.calls[0][1],ID);assert.deepEqual(plain(h.calls[0][2]),[OTHER_ID]);assert.equal(h.calls[0][3],h.file)
 assert.equal(await h.panel.apply(),false);h.panel.confirm("true");assert.equal(await h.panel.apply(),false)
 h.panel.confirm(true);assert.equal(await h.panel.apply(),true);assert.deepEqual(h.calls[1],["repair",7,true])
 assert.equal(h.panel.inspect().preview,null);assert.equal(h.panel.inspect().confirmed,false);assert.match(h.panel.inspect().notice,/保护未变/);assert.equal(await h.panel.apply(),false)
})
for(const mode of ["missing-file","missing-selection","empty-file","huge-file","bad-size","missing-text","foreign-id","duplicate-id"])test(`invalid ${mode} does not call port`,async()=>{
 const h=fixture();h.choose()
 if(mode==="missing-file")h.panel.setFile(null)
 if(mode==="missing-selection")h.panel.select([])
 if(mode==="empty-file")h.panel.setFile({...h.file,size:0})
 if(mode==="huge-file")h.panel.setFile({...h.file,size:64*1024*1024+1})
 if(mode==="bad-size")h.panel.setFile({...h.file,size:1.5})
 if(mode==="missing-text")h.panel.setFile({...h.file,text:null})
 if(mode==="foreign-id")h.panel.select([ID])
 if(mode==="duplicate-id")h.panel.select([OTHER_ID,OTHER_ID])
 assert.equal(await h.panel.prepare(),false);assert.equal(h.calls.length,0)
})
for(const mode of ["not-ready","unsafe-resolution","missing-policy","zero-ticket","fraction-ticket","unknown-format","empty-steps","unselected-step","duplicate-step","bad-boolean","empty-slot","create-without-original","missing-unused","selected-unused","duplicate-unused","bad-unused"])test(`malformed preview ${mode} cannot authorize repair`,async()=>{
 const h=fixture();h.choose();const r=h.response
 if(mode==="not-ready")r.ready=false
 if(mode==="unsafe-resolution")r.resolutionEnabled=true
 if(mode==="missing-policy")delete r.fileStatePolicy
 if(mode==="zero-ticket")r.reviewId=0
 if(mode==="fraction-ticket")r.reviewId=1.5
 if(mode==="unknown-format")r.fileFormat="backup"
 if(mode==="empty-steps")r.steps=[]
 if(mode==="unselected-step")r.steps[0].mediaId=EXTRA
 if(mode==="duplicate-step")r.steps.push(r.steps[0])
 if(mode==="bad-boolean")r.steps[0].fillOriginal=1
 if(mode==="empty-slot")Object.assign(r.steps[0],{fillOriginal:false,fillThumbnail:false})
 if(mode==="create-without-original")r.steps[0].fillOriginal=false
 if(mode==="missing-unused")delete r.unusedFileMediaIds
 if(mode==="selected-unused")r.unusedFileMediaIds=[OTHER_ID]
 if(mode==="duplicate-unused")r.unusedFileMediaIds=[EXTRA,EXTRA]
 if(mode==="bad-unused")r.unusedFileMediaIds=["bad"]
 assert.equal(await h.panel.prepare(),false);h.panel.confirm(true);assert.equal(await h.panel.apply(),false);assert.equal(h.panel.inspect().preview,null)
 assert.equal(h.calls.length,1)
})
test("compound evidence is labelled and unused IDs are displayed only, never auto selected",async()=>{
 const h=fixture();h.choose();h.response.fileFormat="terminal-matched-resource-conflict-evidence";h.response.unusedFileMediaIds=[EXTRA]
 assert.equal(await h.panel.prepare(),true);assert.equal(h.panel.inspect().preview.unusedFileMediaIds[0],EXTRA);assert.deepEqual(plain(h.panel.inspect().selectedIds),[OTHER_ID])
})
for(const action of ["file","selection","cancel","expire","close","dispose"])test(`${action} invalidates a preview and its checkbox`,async()=>{
 const h=fixture();h.choose();await h.panel.prepare();h.panel.confirm(true)
 if(action==="file")h.panel.setFile({...h.file,name:"new.json"});else if(action==="selection")h.panel.select([EXTRA]);else h.panel[action]()
 assert.equal(await h.panel.apply(),false);assert.equal(h.panel.inspect().preview,null);assert.equal(h.panel.inspect().confirmed,false);assert.ok(h.cancels>=3)
})
for(const stage of ["prepare","apply"])for(const action of ["file","selection","cancel","expire","close","dispose"])test(`late ${stage} cannot publish success after ${action}`,async()=>{
 const h=fixture();h.choose();const gate=deferred();let pending
 if(stage==="apply"){await h.panel.prepare();h.panel.confirm(true);h.repair=()=>gate.promise;pending=h.panel.apply()}
 else{h.prepare=()=>gate.promise;pending=h.panel.prepare()}
 assert.equal(h.panel.inspect().busy,true)
 if(action==="file")h.panel.setFile({...h.file,name:"replacement.json"});else if(action==="selection")h.panel.select([EXTRA]);else h.panel[action]()
 assert.equal(h.panel.inspect().busy,true);assert.equal(await h.panel.prepare(),false);assert.equal(await h.panel.apply(),false)
 gate.resolve(stage==="prepare"?ready():repaired());assert.equal(await pending,false)
 assert.equal(h.panel.inspect().busy,false);assert.equal(h.panel.inspect().preview,null);assert.doesNotMatch(h.panel.inspect().notice,/已补齐本机/)
 assert.match(h.panel.inspect().notice,/已提交.*不会.*撤销/)
 if(["close","dispose","expire"].includes(action)){h.choose();assert.equal(await h.panel.prepare(),false)}
})
for(const stage of ["prepare","apply"])test(`deferred ${stage} failure after cancellation does not leak exception or reopen`,async()=>{
 const h=fixture();h.choose();const gate=deferred()
 if(stage==="apply"){await h.panel.prepare();h.panel.confirm(true);h.repair=()=>gate.promise}else h.prepare=()=>gate.promise
 const pending=stage==="apply"?h.panel.apply():h.panel.prepare();h.panel.close();gate.reject(Error("private token https://private"));await pending
 assert.equal(h.panel.inspect().closed,true);assert.doesNotMatch(JSON.stringify(h.panel.inspect()),/private token|https:\/\/private/)
})
for(const mode of ["throw","repaired-false","unsafe-resolution","wrong-protection"])test(`unconfirmed application ${mode} requires fresh review and never auto retries`,async()=>{
 const h=fixture();h.choose();await h.panel.prepare();h.panel.confirm(true)
 if(mode==="throw")h.repair=()=>{throw Error("private token")}
 if(mode==="repaired-false")h.result.repaired=false
 if(mode==="unsafe-resolution")h.result.resolutionEnabled=true
 if(mode==="wrong-protection")h.result.intentStatus="cleared"
 assert.equal(await h.panel.apply(),false);assert.equal(h.panel.inspect().preview,null);assert.equal(h.panel.inspect().confirmed,false);assert.equal(h.panel.inspect().busy,false)
 assert.doesNotMatch(h.panel.inspect().error,/private token/);assert.equal(await h.panel.apply(),false);assert.equal(h.calls.length,2)
})
test("listener unsubscribe and disposal stop publishing UI changes",async()=>{
 const h=fixture();let events=0;const unsubscribe=h.panel.subscribe(()=>events++);h.choose();assert.equal(events,2);unsubscribe();await h.panel.prepare();assert.equal(events,2)
 h.panel.subscribe(()=>events++);h.panel.dispose();h.panel.confirm(true);assert.equal(events,2)
})
for(const value of [[],[OTHER_ID,OTHER_ID],["bad"]])test(`invalid available media list ${JSON.stringify(value)} fails before port access`,()=>{
 const h=fixture();assert.throws(()=>loadTS("shared/scheduleResourceRepairPanel.ts").createScheduleResourceRepairPanel(h.port,ID,value));assert.equal(h.calls.length,0)
})
test("new Vue panel is injection-only, explicit-action and cancellation wired; not a render test",()=>{
 const source=fs.readFileSync(path.join(__dirname,"../src/components/schedules/ScheduleResourceRepairPanel.vue"),"utf8")
 assert.match(source,/port: ResourceRepairPanelPort/);assert.match(source,/type="file"/);assert.match(source,/panel\.prepare\(\)/);assert.match(source,/panel\.apply\(\)/)
 assert.match(source,/panel\.expire\(\)/);assert.match(source,/flush: "sync"/);assert.match(source,/panel\.close\(\)/);assert.match(source,/panel\.dispose\(\)/)
 assert.doesNotMatch(source,/@\/db|@\/api|@\/repo|v-html|<img|fetch\(|localStorage|window\./)
 const script=source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
 assert.doesNotThrow(()=>require("node:module").stripTypeScriptTypes(script))
})

for(const stage of ["prepare","apply"])test(`synchronous close on ${stage} busy notification starts no late request`,async()=>{
 const h=fixture();h.choose()
 if(stage==="apply"){await h.panel.prepare();h.panel.confirm(true)}
 h.panel.subscribe(()=>{if(h.panel.inspect().busy&&!h.panel.inspect().closed)h.panel.close()})
 assert.equal(await (stage==="prepare"?h.panel.prepare():h.panel.apply()),false)
 assert.equal(h.calls.length,stage==="prepare"?0:1);assert.equal(h.panel.inspect().closed,true);assert.equal(h.panel.inspect().busy,false)
})
