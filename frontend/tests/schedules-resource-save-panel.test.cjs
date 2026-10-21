const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path")
const {loadTS}=require("./schedules-harness.cjs")
const KEEP="cloud-source-keep-diary",CLOUD="cloud-source-use-diary",plain=x=>JSON.parse(JSON.stringify(x))
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const load=file=>loadTS(file,{}, {atob,btoa,crypto:crypto.webcrypto})
async function fixture(){const model=load("resource-acceptance/model.ts"),local=JSON.parse(model.resourceFixtureMaterial()),wire=await model.resourceFixtureProof(),cloud=load("shared/scheduleCloudResources.ts").parseScheduleCloudResourceReview(wire,model.RESOURCE_SOURCE_ID)
 const h={id:model.RESOURCE_SOURCE_ID,local,wire,cloud,calls:[],saved:[],cancelled:0,targetCancelled:0,picks:0}
 h.evidence=choice=>({app:"quire",format:"terminal-matched-resource-conflict-evidence",formatVersion:1,exportedAt:"2026-10-16T10:00:00.000Z",scheduleId:h.id,choice,local:plain(local),cloud:plain(wire),meaning:"explicit_choice_not_first_intent_confirmation"})
 h.response={ready:true,reason:"explicit_matched_resource_choices",reviewId:7,choices:[KEEP,CLOUD],local,server:cloud,sourcePolicy:"accept-cloud-terminal"}
 h.target={name:"test-evidence.json",async preserve(value){h.saved.push(plain(value));if(h.save)await h.save(value)},cancel(){h.targetCancelled++}}
 h.port={async review(id){h.calls.push(["review",id]);return h.review?h.review(id):h.response},async resolve(id,choice,confirmed,preserve){h.calls.push(["resolve",id,choice,confirmed]);if(h.resolve)return h.resolve(id,choice,confirmed,preserve);await preserve(h.evidence(choice));return{applied:true,reason:choice===KEEP?"local_diary_ready_for_p2":"cloud_diary_adopted",localIntentStatus:"superseded_by_explicit_choice"}},cancel(){h.cancelled++}}
 h.panel=load("shared/scheduleResourceConflictPanel.ts").createScheduleResourceConflictPanel(h.port,h.id,()=>{h.picks++;return h.pick?h.pick():Promise.resolve(h.target)})
 h.prepare=async(choice=CLOUD)=>{assert.equal(await h.panel.review(),true);h.panel.choose(choice);assert.equal(await h.panel.pickFile(),true);h.panel.confirm(true)}
 return h
}
test("construction and preview never choose a default, pick a file, save or resolve automatically",async()=>{
 const h=await fixture();assert.equal(h.calls.length,0);assert.equal(h.picks,0);assert.equal(await h.panel.resolve(),false)
 assert.equal(await h.panel.review(),true);assert.equal(h.panel.inspect().choice,null);assert.equal(h.saved.length,0)
 const state=h.panel.inspect();assert.match(state.preview.local.text,/隔离图片/);assert.equal(state.preview.mediaCount,1);assert.equal(state.preview.intentionCount,1)
 assert.doesNotMatch(JSON.stringify(state),/blobBase64|thumbBase64|ownerUserId|sha256/);state.preview.choices.length=0;assert.equal(h.panel.inspect().preview.choices.length,2)
})
for(const choice of [KEEP,CLOUD])test(`explicit ${choice} requires fresh file and strict checkbox; file callback runs before success`,async()=>{
 const h=await fixture();await h.panel.review();h.panel.choose(choice);assert.equal(await h.panel.resolve(),false)
 await h.panel.pickFile();assert.equal(h.panel.inspect().fileVerified,false);assert.equal(h.saved.length,0)
 h.panel.confirm("true");assert.equal(await h.panel.resolve(),false);h.panel.confirm(true);assert.equal(await h.panel.resolve(),true)
 assert.equal(h.saved.length,1);assert.equal(h.saved[0].choice,choice);assert.equal(h.panel.inspect().fileVerified,true);assert.equal(h.panel.inspect().preview,null)
 assert.equal(await h.panel.resolve(),false);assert.match(h.panel.inspect().notice,/未启动同步/)
})
for(const mode of ["ticket","policy","source-id","choices","enabled","missing-local"])test(`malformed preview ${mode} cannot authorize a file or resolve`,async()=>{
 const h=await fixture();if(mode==="ticket")h.response.reviewId=0;if(mode==="policy")h.response.sourcePolicy="keep-local-source"
 if(mode==="source-id")h.response.local.scheduleId="019a0300-1234-7000-8000-000000000001"
 if(mode==="choices")h.response.choices=[CLOUD];if(mode==="enabled")h.response.server.resolutionEnabled=true;if(mode==="missing-local")delete h.response.local
 assert.equal(await h.panel.review(),false);h.panel.choose(CLOUD);assert.equal(await h.panel.pickFile(),false);assert.equal(await h.panel.resolve(),false);assert.equal(h.picks,0)
})
test("unmatched resources stay read-only and expose no file/confirmation route",async()=>{
 const h=await fixture();h.response.local.completeLocalResources=false;h.response.local.missingMediaIds=h.response.local.mediaIds;h.response.local.media=[];h.response.choices=[]
 assert.equal(await h.panel.review(),true);assert.equal(h.panel.inspect().preview.choices.length,0);h.panel.choose(CLOUD);assert.equal(await h.panel.pickFile(),false);assert.equal(h.picks,0)
})
test("changing choice cancels prior file but preserves the same valid review for an explicit new choice",async()=>{
 const h=await fixture();await h.prepare(CLOUD);const calls=h.calls.length,stops=h.cancelled
 h.panel.choose(KEEP);assert.equal(h.panel.inspect().fileName,"");assert.equal(h.panel.inspect().confirmed,false);assert.equal(h.targetCancelled,1)
 assert.equal(h.calls.length,calls);assert.equal(h.cancelled,stops);assert.equal(await h.panel.resolve(),false);await h.panel.pickFile();h.panel.confirm(true);assert.equal(await h.panel.resolve(),true);assert.equal(h.saved[0].choice,KEEP)
})
for(const mode of ["cancel","unsupported","bad-target"])test(`picker ${mode} never writes or resolves`,async()=>{
 const h=await fixture();await h.panel.review();h.panel.choose(CLOUD)
 h.pick=mode==="bad-target"?async()=>({name:"bad"}):async()=>{throw Error("private path permission")}
 assert.equal(await h.panel.pickFile(),false);assert.equal(h.saved.length,0);assert.equal(h.calls.length,1);assert.doesNotMatch(h.panel.inspect().error,/private path/)
})
for(const action of ["cancel","close","expire","dispose"])for(const stage of ["review","picker","preserve"])test(`${action} during ${stage} rejects late success and cancels file/port`,async()=>{
 const h=await fixture(),deferred=gate(),started=gate();let pending
 if(stage==="review"){h.review=()=>deferred.promise;pending=h.panel.review()}
 else if(stage==="picker"){await h.panel.review();h.panel.choose(CLOUD);h.pick=()=>deferred.promise;pending=h.panel.pickFile()}
 else{await h.prepare();h.save=async()=>{started.resolve();await deferred.promise};pending=h.panel.resolve();await started.promise}
 assert.equal(h.panel.inspect().busy,true);h.panel[action]();assert.equal(h.panel.inspect().busy,true);assert.equal(await h.panel.review(),false)
 deferred.resolve(stage==="review"?h.response:stage==="picker"?h.target:undefined);assert.equal(await pending,false)
 assert.equal(h.panel.inspect().busy,false);assert.equal(h.panel.inspect().preview,null);assert.equal(h.panel.inspect().confirmed,false);assert.match(h.panel.inspect().notice,/(?:已|已经)提交.*不会/)
 if(stage!=="review")assert.ok(h.targetCancelled>0)
})
for(const mode of ["choice","local","cloud","skip-preserve","write-failure","false-result","wrong-reason"])test(`${mode} cannot fake a successful saved choice`,async()=>{
 const h=await fixture();await h.prepare()
 if(mode==="write-failure")h.save=async()=>{throw Error("private path disk")}
 if(mode!=="write-failure")h.resolve=async(_id,choice,_confirmed,preserve)=>{const value=h.evidence(choice)
 if(mode==="choice")value.choice=KEEP;if(mode==="local")value.local.state.entry.title="different preview";if(mode==="cloud")value.cloud.review.entry.title="different preview"
 if(mode!=="skip-preserve")await preserve(value)
 return{applied:mode!=="false-result",reason:mode==="wrong-reason"?"wrong":"cloud_diary_adopted",localIntentStatus:"superseded_by_explicit_choice"}}
 assert.equal(await h.panel.resolve(),false);assert.equal(h.panel.inspect().preview,null);assert.equal(h.panel.inspect().confirmed,false);assert.doesNotMatch(h.panel.inspect().error,/private path/)
 assert.equal(await h.panel.resolve(),false)
})
for(const stage of ["review","picker","resolve"])test(`synchronous close on ${stage} busy event starts no late request`,async()=>{
 const h=await fixture();if(stage==="picker"){await h.panel.review();h.panel.choose(CLOUD)}if(stage==="resolve")await h.prepare()
 const calls=h.calls.length,picks=h.picks;h.panel.subscribe(()=>{if(h.panel.inspect().busy&&!h.panel.inspect().closed)h.panel.close()})
 assert.equal(await(stage==="review"?h.panel.review():stage==="picker"?h.panel.pickFile():h.panel.resolve()),false)
 assert.equal(h.calls.length,calls);assert.equal(h.picks,picks)
})
function handle(options={}){let committed=options.existing??"",staged="",opens=0,closes=0,aborts=0,reads=0
 const file={name:"actual.json",get text(){return committed},stats:()=>({opens,closes,aborts,reads}),async getFile(){reads++;if(options.atRead)await options.atRead(reads);return{size:new Blob([committed]).size,async text(){if(options.atText)await options.atText();return options.corrupt?committed+"x":committed}}},async createWritable(config){opens++;assert.equal(config.keepExistingData,false);assert.equal(config.mode,"exclusive");if(options.atOpen)await options.atOpen();return{async write(text){if(options.atWrite)await options.atWrite();if(options.fail)throw Error("disk");staged=text},async close(){committed=staged;closes++;if(options.atClose)await options.atClose()},async abort(){aborts++}}}}
 return file
}
test("native picker is called synchronously from explicit handler with correct JSON filter and no download fallback",async()=>{
 const io=load("io/scheduleResourceSavePicker.ts"),file=handle();let calls=0
 const promise=io.pickResourceConflictSaveTarget({isSecureContext:true,showSaveFilePicker(options){calls++;assert.equal(options.excludeAcceptAllOption,true);assert.match(options.suggestedName,/\.json$/);return Promise.resolve(file)}})
 assert.equal(calls,1);const target=await promise;assert.equal(target.name,"actual.json");assert.equal(file.stats().opens,0);target.cancel()
})
for(const environment of [{isSecureContext:false},{isSecureContext:true}])test(`unsupported save environment ${JSON.stringify(environment)} fails closed`,async()=>{
 const io=load("io/scheduleResourceSavePicker.ts");assert.equal(io.resourceEvidenceSaveAvailable(environment),false);await assert.rejects(io.pickResourceConflictSaveTarget(environment))
})
test("nonempty native target is rejected before createWritable and contents remain",async()=>{
 const io=load("io/scheduleResourceSavePicker.ts"),file=handle({existing:"private original"})
 await assert.rejects(io.pickResourceConflictSaveTarget({isSecureContext:true,showSaveFilePicker:async()=>file}));assert.equal(file.text,"private original");assert.equal(file.stats().opens,0)
})
test("real IO target writes, closes and exact-readbacks complete SHA-verified evidence once",async()=>{
 const h=await fixture(),io=load("io/scheduleResourceSavePicker.ts"),file=handle(),target=io.createResourceConflictSaveTarget(file,"test.json")
 await target.preserve(h.evidence(CLOUD));assert.equal(file.stats().closes,1);assert.ok(file.stats().reads>=3)
 const saved=JSON.parse(file.text);assert.equal(saved.choice,CLOUD);assert.equal(saved.local.media.length,1);await assert.rejects(target.preserve(h.evidence(CLOUD)))
})
for(const point of ["before","open","write","close","readback"])test(`cancel file at ${point} never claims verified completion or deletes an already committed file`,async()=>{
 const h=await fixture(),io=load("io/scheduleResourceSavePicker.ts");let target
 const options={};if(point==="open")options.atOpen=async()=>target.cancel();if(point==="write")options.atWrite=async()=>target.cancel();if(point==="close")options.atClose=async()=>target.cancel();if(point==="readback")options.atText=async()=>target.cancel()
 const file=handle(options);target=io.createResourceConflictSaveTarget(file);if(point==="before")target.cancel()
 await assert.rejects(target.preserve(h.evidence(CLOUD)));if(["close","readback"].includes(point))assert.ok(file.text.length>0);else assert.equal(file.text,"")
 if(["open","write"].includes(point))assert.ok(file.stats().aborts>0)
 await assert.rejects(target.preserve(h.evidence(CLOUD)))
})
for(const mode of ["write-failure","corrupt-readback","nonempty-after-selection"])test(`real file ${mode} never returns a successful preserve callback`,async()=>{
 const h=await fixture(),io=load("io/scheduleResourceSavePicker.ts"),file=handle({fail:mode==="write-failure",corrupt:mode==="corrupt-readback",existing:mode==="nonempty-after-selection"?"keep":""}),target=io.createResourceConflictSaveTarget(file)
 await assert.rejects(target.preserve(h.evidence(CLOUD)));if(mode==="nonempty-after-selection")assert.equal(file.text,"keep")
})
test("new Vue component is injected, explicit-choice, escaped-text and cancel-wired, not a real render",()=>{
 const text=fs.readFileSync(path.join(__dirname,"../src/components/schedules/ScheduleResourceConflictPanel.vue"),"utf8")
 assert.match(text,/port: ResourceConflictPanelPort/);assert.match(text,/pickFile: \(\) => Promise/);assert.match(text,/fileSavingSupported: boolean/)
 for(const method of ["review","pickFile","resolve","cancel","close","expire","dispose"])assert.match(text,new RegExp(`panel\\.${method}\\(`))
 assert.doesNotMatch(text,/@\/db|@\/io|@\/api|v-html|<img|fetch\(|localStorage|showSaveFilePicker/)
 assert.doesNotThrow(()=>require("node:module").stripTypeScriptTypes(text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]))
})
