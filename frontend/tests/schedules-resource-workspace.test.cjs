const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path")
const {loadTS}=require("./schedules-harness.cjs")
const ID="019a0300-1234-7000-8000-000000000001",TAG="019a0300-1234-7000-8000-000000000002",PLAN="019a0300-1234-7000-8000-000000000003"
const CLOUD="cloud-source-use-diary",KEEP="cloud-source-keep-diary",clone=x=>JSON.parse(JSON.stringify(x))
function gate(){let resolve;const promise=new Promise(done=>resolve=done);return{resolve,promise}}
function fixture(options={}){
 const h={calls:[],picks:0,cancelled:0,targetCancelled:0,file:{size:10,text:async()=>"original"}},entry={title:"title",date:"2026-10-10",text:"正文",tags:[{id:TAG,name:"原标签",color:"green"}]}
 h.preview={sourceId:ID,local:clone(entry),cloud:clone(entry),localMediaCount:1,cloudMediaCount:1,directChoices:[CLOUD,KEEP],independentChoices:[CLOUD,KEEP],blockers:[],plan:null}
 h.target={name:"fresh.json",handle:{getFile:async()=>h.file,createWritable:async()=>{throw Error("not directly written by panel")}},cancel(){h.targetCancelled++}}
 h.port={async prepareEvidence(confirmed){h.calls.push(["download",confirmed]);return options.prepare?options.prepare(h):{ready:true,reviewId:7}},async saveEvidence(id,handle){h.calls.push(["save",id,handle]);return options.save?options.save(h):{saved:true}},async inspect(file){h.calls.push(["inspect",file]);return options.inspect?options.inspect(h):h.preview},cancel(){h.cancelled++}}
 for(const [method,outcome]of [["prepareCopies","names_prepared"],["publishCopies","tags_confirmed"],["handoffCopies","diary_handed_off"],["resolveDirect","diary_handed_off"]])h.port[method]=async(...args)=>{h.calls.push([method,...args]);return options.action?options.action(h,method,args):{ok:true,outcome,cloudSynced:false}}
 h.panel=loadTS("shared/scheduleResourceWorkspacePanel.ts").createScheduleResourceWorkspacePanel(h.port,ID,()=>{h.picks++;return options.pick?options.pick(h):Promise.resolve(h.target)})
 h.read=()=>h.panel.readFile(h.file,"original.json")
 h.select=async(action="names")=>{await h.read();h.panel.choose(CLOUD);if(action==="names")h.panel.setName(TAG,"明确新名称");h.panel.confirm(action,true)}
 return h
}
test("workspace construction is inert and explicit read neither picks nor defaults or auto-applies",async()=>{
 const h=fixture();assert.equal(h.calls.length,0);assert.equal(h.picks,0);assert.equal(await h.panel.prepareEvidence(),false);assert.equal(await h.panel.apply("direct"),false)
 assert.equal(await h.read(),true);assert.equal(h.panel.inspect().choice,null);assert.equal(h.calls.length,1);assert.equal(h.picks,0)
 const s=h.panel.inspect();s.preview.local.title="mutated";assert.equal(h.panel.inspect().preview.local.title,"title")
})
test("download consent, explicit fresh target and another explicit read are separate steps",async()=>{
 const h=fixture();h.panel.confirmDownload("true");assert.equal(await h.panel.prepareEvidence(),false)
 h.panel.confirmDownload(true);assert.equal(await h.panel.prepareEvidence(),true);assert.equal(h.picks,0);assert.equal(h.panel.inspect().preview,null)
 assert.equal(await h.panel.saveEvidence(),true);assert.equal(h.picks,1);assert.equal(h.calls.filter(c=>c[0]==="inspect").length,0);assert.equal(h.panel.inspect().fileSaved,true)
 assert.equal(await h.panel.readCurrent(),true);assert.equal(h.panel.inspect().choice,null);assert.equal(h.calls.filter(c=>c[0].includes("Copies")).length,0)
})
for(const action of ["names","direct"])test(`workspace ${action} requires choice and strict action-specific confirmation`,async()=>{
 const h=fixture();await h.read();h.panel.confirm(action,true);assert.equal(await h.panel.apply(action),false)
 h.panel.choose(CLOUD);if(action==="names")h.panel.setName(TAG,"新名称")
 h.panel.confirm(action,"true");assert.equal(await h.panel.apply(action),false);h.panel.confirm(action,true);assert.equal(await h.panel.apply(action),true)
 assert.equal(h.panel.inspect().preview,null);assert.equal(await h.panel.apply(action),false);assert.match(h.panel.inspect().notice,/未|尚未/)
 assert.equal(h.calls.filter(c=>["prepareCopies","resolveDirect"].includes(c[0])).length,1)
})
for(const stage of ["prepared","started","confirmed"])test(`workspace archived ${stage} uses original plan only and never chains stages`,async()=>{
 const h=fixture();h.preview.directChoices=[];h.preview.independentChoices=[];h.preview.plan={id:PLAN,choice:CLOUD,stage,names:[{from:TAG,name:"persisted"}]};await h.read()
 assert.equal(h.panel.choose(KEEP),false);assert.equal(h.panel.choose(CLOUD),true);assert.equal(h.panel.can("names"),false);assert.equal(h.panel.setName(TAG,"replacement"),false)
 const action=stage==="confirmed"?"handoff":"publish";h.panel.confirm(action,true);assert.equal(await h.panel.apply(action),true)
 const call=h.calls.find(c=>c[0]===(action==="handoff"?"handoffCopies":"publishCopies"));assert.equal(call[2],PLAN)
 assert.equal(h.calls.filter(c=>c[0].includes("Copies")).length,1);assert.equal(h.panel.inspect().preview,null)
})
for(const block of ["shared_images","current_state_changed","stale_plan","historical_handoff"])test(`workspace blocker ${block} exposes no mutation`,async()=>{
 const h=fixture();h.preview.blockers=[block];await h.read();h.panel.choose(CLOUD);h.panel.setName(TAG,"new")
 for(const action of ["names","publish","handoff","direct"]){assert.equal(h.panel.can(action),false);h.panel.confirm(action,true);assert.equal(await h.panel.apply(action),false)}
 assert.equal(h.calls.length,1)
})
test("unsaved names survive same choice, attempted choice/file switch and cancelled close",async()=>{
 const h=fixture();await h.select();assert.equal(h.panel.choose(CLOUD),true);assert.equal(h.panel.inspect().names[0].name,"明确新名称")
 assert.equal(h.panel.choose(KEEP),false);assert.equal(await h.read(),false);assert.equal(await h.panel.readCurrent(),true);assert.equal(h.panel.inspect().names[0].name,"明确新名称");assert.equal(h.panel.inspect().confirmedAction,null)
 h.panel.requestClose();assert.equal(await h.panel.apply("names"),false);assert.equal(h.panel.confirmClose(false),false);assert.equal(h.panel.inspect().names[0].name,"明确新名称")
 h.panel.discardNames(false);assert.equal(h.panel.inspect().names[0].name,"明确新名称");h.panel.discardNames(true);assert.equal(h.panel.choose(KEEP),true)
})
test("name changes and confirm-one-action cannot authorize another action",async()=>{
 const h=fixture();await h.select();h.panel.setName(TAG,"changed");assert.equal(await h.panel.apply("names"),false)
 h.panel.confirm("names",true);assert.equal(await h.panel.apply("direct"),false);assert.equal(await h.panel.apply("purge"),false)
 assert.equal(h.panel.setName(PLAN,"bad"),false);assert.equal(h.panel.setName(TAG,"x".repeat(33)),false)
})
for(const action of ["cancel","expire","dispose","close"])for(const stage of ["read","picker","action"])test(`workspace ${action} during ${stage} rejects stale success without extra work`,async()=>{
 const pending=gate(),h=fixture({inspect:stage==="read"?()=>pending.promise:undefined,pick:stage==="picker"?()=>pending.promise:undefined,action:stage==="action"?()=>pending.promise:undefined});let work
 if(stage==="read")work=h.read()
 if(stage==="picker"){h.panel.confirmDownload(true);await h.panel.prepareEvidence();work=h.panel.saveEvidence()}
 if(stage==="action"){await h.select();work=h.panel.apply("names")}
 assert.equal(h.panel.inspect().busy,true)
 if(action==="close"){h.panel.requestClose();h.panel.confirmClose(true)}else h.panel[action]()
 assert.equal(h.panel.inspect().busy,true);assert.equal(await h.panel.readCurrent(),false)
 pending.resolve(stage==="read"?h.preview:stage==="picker"?h.target:{ok:true,outcome:"names_prepared",cloudSynced:false});assert.equal(await work,false)
 assert.equal(h.panel.inspect().busy,false);assert.equal(h.panel.inspect().preview,null);assert.match(h.panel.inspect().notice,/不会.*撤销/)
 if(stage==="picker")assert.ok(h.targetCancelled>0)
})
for(const mode of ["false","wrong-outcome","cloud-claim","throw"])test(`workspace invalid result ${mode} cannot claim success or retry automatically`,async()=>{
 const h=fixture({action:async()=>{if(mode==="throw")throw Error("private token secret");return{ok:mode!=="false",outcome:mode==="wrong-outcome"?"tags_confirmed":"names_prepared",cloudSynced:mode==="cloud-claim"}}});await h.select()
 assert.equal(await h.panel.apply("names"),false);assert.equal(h.panel.inspect().preview,null);assert.doesNotMatch(h.panel.inspect().error,/private|token|secret/);assert.equal(h.panel.inspect().names[0].name,"明确新名称");assert.equal(h.calls.filter(c=>c[0]==="prepareCopies").length,1)
})
for(const mode of ["source","choice","block","count","tag","plan"])test(`workspace invalid preview ${mode} cannot authorize actions`,async()=>{
 const h=fixture();if(mode==="source")h.preview.sourceId=PLAN;if(mode==="choice")h.preview.directChoices=["purge"];if(mode==="block")h.preview.blockers=["toString"]
 if(mode==="count")h.preview.cloudMediaCount=-1;if(mode==="tag")h.preview.local.tags[0].id="bad";if(mode==="plan")h.preview.plan={id:PLAN,choice:CLOUD,stage:"unknown",names:[]}
 assert.equal(await h.read(),false);assert.equal(h.panel.inspect().preview,null);assert.equal(h.calls.length,1)
})
test("workspace projects render-safe previews and does not retain injected tokens or bytes",async()=>{
 const h=fixture();h.preview.ownerUserId="private-owner";h.preview.local.blobBase64="private-image";h.preview.cloud.tags[0].token="private-token"
 assert.equal(await h.read(),true);assert.doesNotMatch(JSON.stringify(h.panel.inspect()),/private-owner|private-image|private-token|blobBase64/)
})
test("workspace forced context expiry keeps names visible but locks all actions",async()=>{
 const h=fixture();await h.select();h.panel.expire();assert.equal(h.panel.inspect().names[0].name,"明确新名称");assert.equal(h.panel.inspect().expired,true)
 assert.equal(await h.panel.apply("names"),false);h.panel.confirm("names",true);assert.equal(await h.panel.prepareEvidence(),false);assert.equal(h.panel.setName(TAG,"new"),false)
 h.panel.requestClose();assert.equal(h.panel.confirmClose(true),true);assert.deepEqual(h.panel.inspect().names,[])
})
for(const stage of ["read","download","save","action"])test(`workspace synchronous expiry on ${stage} busy notification starts no late side effect`,async()=>{
 const h=fixture();if(stage==="save"){h.panel.confirmDownload(true);await h.panel.prepareEvidence()}if(stage==="action")await h.select()
 const before=h.calls.length,picks=h.picks,off=h.panel.subscribe(()=>{if(h.panel.inspect().busy&&!h.panel.inspect().expired)h.panel.expire()})
 const result=stage==="read"?h.read():stage==="download"?(h.panel.confirmDownload(true),h.panel.prepareEvidence()):stage==="save"?h.panel.saveEvidence():h.panel.apply("names")
 assert.equal(await result,false);off();assert.equal(h.calls.length,before);assert.equal(h.picks,picks)
})
test("workspace component is internal, explicit events only and has no DB or sync writes",()=>{
 const base=path.resolve(__dirname,"../src"),ui=fs.readFileSync(path.join(base,"components/schedules/ScheduleResourceWorkspacePanel.vue"),"utf8")
 assert.match(ui,/flush: "sync"/);assert.match(ui,/onBeforeUnmount/);assert.match(ui,/取消关闭，保留输入/);assert.match(ui,/当前没有可确认的操作/);assert.doesNotMatch(ui,/v-html|runSync|fetch\(|db\.|localStorage|setInterval/)
 for(const f of ["App.vue","router/index.ts","views/ScheduleView.vue"]){const file=path.join(base,f);if(fs.existsSync(file))assert.doesNotMatch(fs.readFileSync(file,"utf8"),/ScheduleResourceWorkspacePanel|createInternalResourceWorkspace/)}
})

function pickerEnvironment(options={}){
 let text=options.nonempty?"existing":"",writes=0,aborts=0,closes=0,picks=0
 const raw={name:"selected.json",getFile:async()=>({size:new Blob([text]).size,text:async()=>text}),createWritable:async()=>{if(options.beforeStream)await options.beforeStream();return{write:async value=>{writes++;text=value},close:async()=>{closes++},abort:async()=>{aborts++}}}}
 return{raw,environment:{isSecureContext:options.secure!==false,showSaveFilePicker:async()=>{picks++;if(options.cancel)throw Error("cancel");return raw}},stats:()=>({text,writes,aborts,closes,picks})}
}
test("workspace picker is inert until called and returns a single-use guarded empty file",async()=>{
 const h=pickerEnvironment(),api=loadTS("io/scheduleResourceWorkspacePicker.ts");assert.equal(h.stats().picks,0)
 const target=await api.pickResourceWorkspaceEvidence(h.environment);assert.equal(target.name,"selected.json");assert.equal(h.stats().writes,0)
 const stream=await target.handle.createWritable({keepExistingData:false});await stream.write("physical");await stream.close();assert.equal((await target.handle.getFile()).size,8)
 await assert.rejects(()=>target.handle.createWritable({keepExistingData:false}));target.cancel();assert.equal(h.stats().text,"physical");assert.equal(h.stats().aborts,0)
 await assert.rejects(()=>target.handle.getFile())
})
for(const mode of ["insecure","missing-picker","cancel","nonempty"])test(`workspace picker ${mode} writes nothing and never overwrites`,async()=>{
 const h=pickerEnvironment({secure:mode!=="insecure",cancel:mode==="cancel",nonempty:mode==="nonempty"});if(mode==="missing-picker")delete h.environment.showSaveFilePicker
 await assert.rejects(()=>loadTS("io/scheduleResourceWorkspacePicker.ts").pickResourceWorkspaceEvidence(h.environment));assert.equal(h.stats().writes,0);if(mode==="nonempty")assert.equal(h.stats().text,"existing")
})
test("workspace picker cancellation during stream creation aborts the late stream",async()=>{
 const wait=gate(),h=pickerEnvironment({beforeStream:()=>wait.promise}),target=await loadTS("io/scheduleResourceWorkspacePicker.ts").pickResourceWorkspaceEvidence(h.environment)
 const work=target.handle.createWritable({keepExistingData:false});target.cancel();wait.resolve();await assert.rejects(work);assert.equal(h.stats().aborts,1);assert.equal(h.stats().writes,0)
})
test("workspace picker cancellation of active writer cannot delete or rewrite the saved file",async()=>{
 const h=pickerEnvironment(),target=await loadTS("io/scheduleResourceWorkspacePicker.ts").pickResourceWorkspaceEvidence(h.environment),stream=await target.handle.createWritable({keepExistingData:false})
 await stream.write("already written");target.cancel();await assert.rejects(()=>stream.write("other"));await assert.rejects(()=>stream.close());assert.equal(h.stats().text,"already written");assert.equal(h.stats().aborts,1)
})
test("workspace transport composition is inert and keeps distinct review/image/publication/presence methods",async()=>{
 const calls=[],mock=label=>(...args)=>{calls.push([label,...args]);return Promise.resolve(label)},mocks={"./scheduleCloudResourceImageTransport":{createScheduleCloudResourceImageTransport:()=>({review:mock("review"),image:mock("image")})},"./scheduleTagPublicationTransport":{createScheduleTagPublicationTransport:()=>({publish:mock("publish")}),createScheduleTagHandoffTransport:()=>({checkTags:mock("readonly")})}}
 const api=loadTS("api/scheduleResourceWorkspaceTransport.ts",mocks).createScheduleResourceWorkspaceTransport();assert.equal(calls.length,0)
 const lease={ownerUserId:"fixed",generation:"epoch",tokenGeneration:1},signal={},body={original:true}
 assert.equal(await api.review(ID,lease),"review");assert.equal(await api.image(ID,TAG,"original",{},lease,signal),"image");assert.equal(await api.publish(ID,body,lease,signal),"publish");assert.equal(await api.checkTags(ID,body,lease,signal),"readonly")
 assert.equal(calls[2][2],body);assert.equal(calls[2][3],lease);assert.equal(calls[3][4],signal)
})

test("workspace failed naming retains editable names on explicit same-file recheck, never auto-retries",async()=>{
 const h=fixture({action:async()=>({ok:false,outcome:"not_confirmed",cloudSynced:false})});await h.select();assert.equal(await h.panel.apply("names"),false)
 assert.equal(h.panel.inspect().names[0].name,"明确新名称");assert.equal(await h.panel.readCurrent(),true);assert.equal(h.panel.inspect().names[0].name,"明确新名称");assert.equal(h.panel.inspect().choice,CLOUD)
 assert.equal(h.panel.inspect().confirmedAction,null);assert.equal(h.panel.setName(TAG,"修改后名称"),true);assert.equal(h.calls.filter(c=>c[0]==="prepareCopies").length,1)
})
test("workspace recheck identifies already persisted matching names without auto-publication or silent replacement",async()=>{
 const h=fixture();await h.select();h.preview.plan={id:PLAN,choice:CLOUD,stage:"prepared",names:[{from:TAG,name:"明确新名称"}]}
 assert.equal(await h.panel.readCurrent(),true);assert.deepEqual(h.panel.inspect().names,[]);assert.equal(h.panel.inspect().choice,null);assert.match(h.panel.inspect().notice,/已找回.*持久/);assert.equal(h.calls.filter(c=>c[0].includes("Copies")).length,0)
})
test("workspace incompatible recheck preserves old name text but cannot attach it to another plan",async()=>{
 const h=fixture();await h.select();h.preview.plan={id:PLAN,choice:CLOUD,stage:"confirmed",names:[{from:TAG,name:"another name"}]}
 assert.equal(await h.panel.readCurrent(),true);assert.equal(h.panel.inspect().names[0].name,"明确新名称");assert.equal(h.panel.inspect().choice,null);assert.equal(await h.panel.apply("names"),false)
})
