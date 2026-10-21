const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path")
const {loadTS}=require("./schedules-harness.cjs"),{ID,OTHER_ID}=require("./schedules-data-harness.cjs")
const EXTRA="019a0300-1234-7000-8000-000000000003",plain=v=>JSON.parse(JSON.stringify(v))
const ready=()=>({ready:true,reason:"explicit_cloud_missing_bytes_confirmation",reviewId:7,steps:[{mediaId:OTHER_ID,createRow:true,fillOriginal:true,fillThumbnail:true}],resolutionEnabled:false,materialOrigin:"authenticated_current_image_bytes",downloaded:true})
const done=()=>({repaired:true,reason:"local_missing_bytes_repaired",resolutionEnabled:false,intentStatus:"unchanged_protected"})
function fixture(){const h={calls:[],cancels:0,response:ready(),result:done()};h.port={async prepare(...args){h.calls.push(["prepare",...args]);return h.prepare?h.prepare():h.response},async repair(...args){h.calls.push(["repair",...args]);return h.repair?h.repair():h.result},cancel(){h.cancels++}}
 h.panel=loadTS("shared/scheduleResourceDownloadPanel.ts").createScheduleResourceDownloadPanel(h.port,ID,[OTHER_ID,EXTRA]);return h}
test("mount and selection are inert, no default all-selection and state copies are isolated",()=>{
 const h=fixture();assert.deepEqual(plain(h.panel.inspect().selectedIds),[]);h.panel.select([OTHER_ID]);assert.equal(h.calls.length,0)
 const copy=h.panel.inspect();copy.selectedIds.push(EXTRA);assert.equal(h.panel.inspect().selectedIds.length,1);assert.equal(h.panel.inspect().preview,null)
})
test("explicit download preparation cannot write without separate strict confirmation",async()=>{
 const h=fixture();assert.equal(await h.panel.prepare(),false);h.panel.select([OTHER_ID]);assert.equal(await h.panel.prepare(),true)
 assert.deepEqual(plain(h.calls[0]),["prepare",ID,[OTHER_ID]]);assert.equal(await h.panel.apply(),false)
 h.panel.confirm("true");assert.equal(await h.panel.apply(),false);h.panel.confirm(true);assert.equal(await h.panel.apply(),true)
 assert.deepEqual(h.calls[1],["repair",7,true]);assert.equal(h.panel.inspect().preview,null);assert.match(h.panel.inspect().notice,/保护未变/)
 assert.equal(await h.panel.apply(),false)
})
for(const mode of ["not-ready","unsafe-resolution","bad-origin","not-downloaded","wrong-reason","zero-ticket","fraction-ticket","empty-steps","unselected","duplicate","bad-boolean","no-slot","create-without-original"])test(`malformed download plan ${mode} cannot authorize a write`,async()=>{
 const h=fixture(),r=h.response;h.panel.select([OTHER_ID])
 if(mode==="not-ready")r.ready=false;if(mode==="unsafe-resolution")r.resolutionEnabled=true;if(mode==="bad-origin")r.materialOrigin="file";if(mode==="not-downloaded")r.downloaded=false;if(mode==="wrong-reason")r.reason="file"
 if(mode==="zero-ticket")r.reviewId=0;if(mode==="fraction-ticket")r.reviewId=1.5;if(mode==="empty-steps")r.steps=[];if(mode==="unselected")r.steps[0].mediaId=EXTRA;if(mode==="duplicate")r.steps.push({...r.steps[0]})
 if(mode==="bad-boolean")r.steps[0].fillOriginal=1;if(mode==="no-slot")Object.assign(r.steps[0],{fillOriginal:false,fillThumbnail:false});if(mode==="create-without-original")r.steps[0].fillOriginal=false
 assert.equal(await h.panel.prepare(),false);h.panel.confirm(true);assert.equal(await h.panel.apply(),false);assert.equal(h.panel.inspect().preview,null);assert.equal(h.calls.length,1)
})
for(const ids of [[],[OTHER_ID,OTHER_ID],[ID],["bad"]])test(`invalid selection ${JSON.stringify(ids)} cannot request bytes`,async()=>{
 const h=fixture();h.panel.select(ids);assert.equal(await h.panel.prepare(),false);assert.equal(h.calls.length,0)
})
for(const stage of ["prepare","apply"])for(const action of ["select","cancel","expire","close","dispose"])test(`late ${stage} after ${action} cannot republish success or overlap`,async()=>{
 const h=fixture();h.panel.select([OTHER_ID]);let release;const gate=new Promise(r=>release=r)
 if(stage==="apply"){await h.panel.prepare();h.panel.confirm(true);h.repair=()=>gate}else h.prepare=()=>gate
 const pending=stage==="apply"?h.panel.apply():h.panel.prepare();assert.equal(h.panel.inspect().busy,true)
 if(action==="select")h.panel.select([EXTRA]);else h.panel[action]()
 assert.equal(h.panel.inspect().busy,true);assert.equal(await h.panel.prepare(),false);assert.equal(await h.panel.apply(),false)
 release(stage==="apply"?done():ready());assert.equal(await pending,false);assert.equal(h.panel.inspect().busy,false);assert.equal(h.panel.inspect().preview,null);assert.match(h.panel.inspect().notice,/不会.*撤销/)
})
for(const stage of ["prepare","apply"])test(`synchronous close on ${stage} busy event starts no port call`,async()=>{
 const h=fixture();h.panel.select([OTHER_ID]);if(stage==="apply"){await h.panel.prepare();h.panel.confirm(true)}
 h.panel.subscribe(()=>{if(h.panel.inspect().busy&&!h.panel.inspect().closed)h.panel.close()})
 assert.equal(await(stage==="apply"?h.panel.apply():h.panel.prepare()),false);assert.equal(h.calls.length,stage==="apply"?1:0)
})
for(const mode of ["throw","not-repaired","wrong-reason","unsafe-resolution","cleared-protection"])test(`unconfirmed result ${mode} requires a fresh plan with no retry`,async()=>{
 const h=fixture();h.panel.select([OTHER_ID]);await h.panel.prepare();h.panel.confirm(true)
 if(mode==="throw")h.repair=()=>{throw Error("private-token https://private")};if(mode==="not-repaired")h.result.repaired=false;if(mode==="wrong-reason")h.result.reason="anything";if(mode==="unsafe-resolution")h.result.resolutionEnabled=true;if(mode==="cleared-protection")h.result.intentStatus="cleared"
 assert.equal(await h.panel.apply(),false);assert.equal(h.panel.inspect().preview,null);assert.equal(await h.panel.apply(),false);assert.doesNotMatch(JSON.stringify(h.panel.inspect()),/private-token|https:\/\/private/)
})
for(const ids of [[],[OTHER_ID,OTHER_ID],["bad"]])test(`invalid available IDs ${JSON.stringify(ids)} fail before port access`,()=>{
 const h=fixture();assert.throws(()=>loadTS("shared/scheduleResourceDownloadPanel.ts").createScheduleResourceDownloadPanel(h.port,ID,ids));assert.equal(h.calls.length,0)
})
test("Vue download panel is injection-only, explicit and context-invalidated; static check not render",()=>{
 const s=fs.readFileSync(path.join(__dirname,"../src/components/schedules/ScheduleResourceDownloadPanel.vue"),"utf8")
 for(const text of ["port: ResourceDownloadPanelPort","panel.prepare()","panel.apply()","panel.expire()","panel.dispose()","flush: \"sync\""])assert.ok(s.includes(text))
 assert.doesNotMatch(s,/@\/db|@\/api|fetch\(|v-html|<img|type="file"|localStorage/)
 assert.doesNotThrow(()=>require("node:module").stripTypeScriptTypes(s.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]))
})
