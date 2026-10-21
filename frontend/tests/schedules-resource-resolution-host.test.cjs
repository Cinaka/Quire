const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path')
const {setup}=require('./schedules-data-harness.cjs')
const spec={enabled:true,dailyOrigin:'http://localhost:5173',testOrigin:'http://127.0.0.1:5181'}
const KEEP='cloud-source-keep-diary',CLOUD='cloud-source-use-diary',plain=x=>JSON.parse(JSON.stringify(x))
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
const all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
function harness(){let token='';const window={location:{origin:spec.testOrigin,pathname:'/p4-resource-acceptance.html'}}
 const h=setup({}, {URL,window,localStorage:{getItem:()=>token},crypto:crypto.webcrypto,__QUIRE_P4_RESOURCE_ACCEPTANCE__:true})
 h.identity=h.load('resource-acceptance/identity.ts');h.mocks['./identity']=h.identity
 const tokens={accessTokenSubject:h.identity.resourceAccessTokenSubject,tokenGeneration:h.identity.resourceTokenGeneration,getAccessToken:h.identity.resourceGetAccessToken}
 h.mocks['@/api/tokenStore']=tokens;h.mocks['./tokenStore']=tokens
 h.barrier=h.load('resource-acceptance/barrier.ts');h.mocks['./barrier']=h.barrier
 h.mocks['./schema'].waitForScheduleResourceBytes=h.barrier.waitForResourceAcceptanceTransaction;h.mocks['@/db/schema'].waitForScheduleResourceBytes=h.barrier.waitForResourceAcceptanceTransaction
 h.db.name='quire-p4-resource-acceptance';h.model=h.load('resource-acceptance/model.ts');h.runtime=h.load('resource-acceptance/runtime.ts');h.resolution=h.load('resource-acceptance/resolution.ts')
 h.token=value=>{token=value};h.window=window;h.activate=()=>h.identity.activateResourceIdentity(spec)
 h.file=()=>{const text=h.model.resourceFixtureMaterial();return {size:new Blob([text]).size,text:async()=>text}}
 h.seed=async()=>{h.activate();await h.runtime.initializeResourceAcceptance(spec);await h.runtime.seedResourceAcceptance(spec)}
 h.complete=async()=>{await h.seed();const s=h.runtime.createResourceAcceptanceSession(spec,()=>{});try{const review=await s.port.prepare(h.model.RESOURCE_SOURCE_ID,[h.model.RESOURCE_MEDIA_ID],h.file());assert.equal(review.ready,true);assert.equal((await s.port.repair(review.reviewId,true)).repaired,true)}finally{s.close()}}
 h.session=changed=>h.resolution.createResourceResolutionAcceptanceSession(spec,changed??(()=>{}))
 h.native=()=>{let committed='',staged='',writes=0,closes=0;return {name:'fixture-evidence.json',get text(){return committed},stats:()=>({writes,closes}),async getFile(){return {size:new Blob([committed]).size,text:async()=>committed}},async createWritable(options){assert.equal(options.mode,'exclusive');assert.equal(options.keepExistingData,false);return {async write(text){writes++;staged=text},async close(){closes++;committed=staged},async abort(){}}}}}
 h.panel=(session,file)=>{const io=h.load('io/scheduleResourceSavePicker.ts'),panel=h.load('shared/scheduleResourceConflictPanel.ts').createScheduleResourceConflictPanel(session.port,h.model.RESOURCE_SOURCE_ID,async()=>io.createResourceConflictSaveTarget(file,file.name));return panel}
 h.prepare=async(panel,choice=CLOUD)=>{assert.equal(await panel.review(),true);panel.choose(choice);assert.equal(await panel.pickFile(),true);panel.confirm(true)}
 return h
}
for(const choice of [KEEP,CLOUD])test(`existing repaired fixture composes real resolver and saved file, ${choice}, refresh-like reader persists once`,async()=>{
 const h=harness();await h.complete();const before=await h.resolution.inspectResourceAcceptanceLifecycle(spec);assert.equal(before.stage,'protected');assert.equal(before.archiveCount,1)
 const session=h.session(),file=h.native(),panel=h.panel(session,file)
 try{await h.prepare(panel,choice);assert.notEqual(panel.inspect().preview.local.title,panel.inspect().preview.cloud.title);assert.equal(await panel.resolve(),true)
 const state=await h.resolution.inspectResourceAcceptanceLifecycle(spec);assert.equal(state.stage,'resolved');assert.equal(state.intentionCount,0);assert.equal(state.candidateCount,0);assert.equal(state.mediaRows,1);assert.equal(state.archiveCount,1);assert.equal(state.handoffArchiveCount,1)
 assert.equal(state.choice,choice);assert.equal(state.entryDirty,choice===KEEP?1:0);assert.equal(state.entryTitle,choice===KEEP?h.model.resourceFixtureRows().entry.title:'验收：模拟云端当前图片日记')
 assert.equal(file.stats().writes,1);assert.equal(file.stats().closes,1);assert.equal((await h.resolution.readResourceAcceptanceSavedFile(spec,await file.getFile())).handoffConfirmed,true)
 const stored=all(h);session.close();h.identity.deactivateResourceIdentity();h.activate();await h.runtime.initializeResourceAcceptance(spec)
 const fresh=h.load('resource-acceptance/resolution.ts');assert.deepEqual(plain(await fresh.inspectResourceAcceptanceLifecycle(spec)),plain(state));assert.equal(all(h),stored)
 const again=h.session();try{assert.equal((await again.port.review(h.model.RESOURCE_SOURCE_ID)).ready,false)}finally{again.close()}
 await assert.rejects(h.runtime.seedResourceAcceptance(spec));assert.equal(all(h),stored)
 }finally{panel.dispose();session.close()}
})
test('construction is inert and missing media cannot reach review or evidence preservation',async()=>{
 const h=harness();await h.seed();const before=all(h),s=h.session();let called=0
 try{assert.equal(all(h),before);assert.equal((await s.port.review(h.model.RESOURCE_SOURCE_ID)).ready,false)
 assert.equal((await s.port.resolve(1,CLOUD,true,async()=>{called++})).applied,false);assert.equal(called,0);assert.equal(all(h),before)
 }finally{s.close()}
})
for(const mode of ['wrong-source','unknown-meta','other-entry','changed-local','credential','wrong-db','inactive'])test(`repaired fixture ${mode} refuses without preserving or writing`,async()=>{
 const h=harness();await h.complete()
 if(mode==='unknown-meta')await h.db.meta.put({key:'unknown',value:'retain'})
 if(mode==='other-entry')await h.db.entries.put({...h.model.resourceFixtureRows().entry,id:'019a0300-1234-7000-8000-000000000007'})
 if(mode==='changed-local')await h.db.entries.update(h.model.RESOURCE_SOURCE_ID,{title:'private unexpected'})
 const before=all(h),s=h.session()
 try{if(mode==='credential')h.token('never-remove-me');if(mode==='wrong-db')h.db.name='quire';if(mode==='inactive')h.identity.deactivateResourceIdentity()
 const r=await s.port.review(mode==='wrong-source'?'019a0300-1234-7000-8000-000000000007':h.model.RESOURCE_SOURCE_ID);assert.equal(r.ready,false);assert.equal(all(h),before)
 }finally{s.close()}
})
for(const mode of ['fingerprint','file','before','extra-key'])test(`corrupt protected repair audit ${mode} cannot authorize a later handoff`,async()=>{
 const h=harness();await h.complete();const rows=(await h.db.meta.get('scheduleResourceRepairs')).value
 if(mode==='fingerprint')rows[0].fileFingerprint='0'.repeat(64)
 if(mode==='file')rows[0].fileEvidence.state.entry.title='different'
 if(mode==='before')rows[0].before.state.entry.title='different'
 if(mode==='extra-key')rows[0].unknown='retain'
 await h.db.meta.put({key:'scheduleResourceRepairs',value:rows});const before=all(h),s=h.session()
 try{await assert.rejects(h.resolution.inspectResourceAcceptanceLifecycle(spec));assert.equal((await s.port.review(h.model.RESOURCE_SOURCE_ID)).ready,false);assert.equal(all(h),before)}finally{s.close()}
})
for(const action of ['cancel','close'])for(const point of ['proof','transaction'])test(`${action} at isolated ${point} pause prevents handoff; saved bytes survive transaction cancellation`,{timeout:15000},async()=>{
 const h=harness();await h.complete();const reached=gate(),s=h.session(p=>{if(p)reached.resolve()}),file=h.native(),panel=h.panel(s,file)
 try{await h.prepare(panel);s.pauseNext(point);const pending=panel.resolve()
 await reached.promise;const original=all(h);if(action==='close'){panel.close();s.close()}else panel.cancel()
 assert.equal(await pending,false);assert.equal(all(h),original)
 const state=await h.resolution.inspectResourceAcceptanceLifecycle(spec);assert.equal(state.stage,'protected');assert.equal(state.intentionCount,1);assert.equal(state.candidateCount,1);assert.equal(state.handoffArchiveCount,0)
 if(point==='transaction'){assert.ok(file.text.length);assert.equal((await h.resolution.readResourceAcceptanceSavedFile(spec,await file.getFile())).handoffConfirmed,false)}else assert.equal(file.text,'')
 }finally{panel.dispose();s.close()}
})
for(const mode of ['token','deactivate'])test(`${mode} while paused at simulated proof cannot resume into preview or file writes`,async()=>{
 const h=harness();await h.complete();const reached=gate(),s=h.session(p=>{if(p)reached.resolve()})
 try{s.pauseNext('proof');const pending=s.port.review(h.model.RESOURCE_SOURCE_ID);await reached.promise;const before=all(h)
 if(mode==='token')h.token('retain-real-token');else h.identity.deactivateResourceIdentity();s.release()
 assert.equal((await pending).ready,false);assert.equal(all(h),before)
 }finally{s.close()}
})
test('repair and resolution cannot own the isolated transaction hook concurrently',async()=>{
 const h=harness();await h.complete();const repair=h.runtime.createResourceAcceptanceSession(spec,()=>{})
 try{assert.throws(()=>h.session())}finally{repair.close()}
 const resolution=h.session();try{assert.throws(()=>h.runtime.createResourceAcceptanceSession(spec,()=>{}))}finally{resolution.close()}
})
for(const mode of ['conversions','candidates','baseline','archive-choice','archive-evidence','archive-result','duplicate-archive','repairs','repair-fingerprint','repair-before','source','entry','media-meta','media-bytes','extra-meta','marker','owner'])test(`resolved reader rejects changed ${mode} and never adopts or repairs it`,async()=>{
 const h=harness();await h.complete();const s=h.session(),file=h.native(),panel=h.panel(s,file)
 try{await h.prepare(panel);assert.equal(await panel.resolve(),true);s.close()
 const id=h.model.RESOURCE_SOURCE_ID,meta=async key=>(await h.db.meta.get(key)).value,put=async(key,value)=>h.db.meta.put({key,value})
 if(mode==='conversions')await put('scheduleConversions',[h.model.resourceFixtureRows().intention])
 if(mode==='candidates')await put('scheduleConflicts',[h.model.resourceFixtureRows().candidate])
 if(mode==='baseline'){const row=await meta('scheduleServerState:'+id);row.source.title='changed';await put('scheduleServerState:'+id,row)}
 if(mode.startsWith('archive-')||mode==='duplicate-archive'){const rows=await meta('scheduleConflictArchive');if(mode==='archive-choice')rows[0].choice=KEEP;if(mode==='archive-evidence')rows[0].evidence.local.state.entry.title='foreign';if(mode==='archive-result')rows[0].result.title='changed';if(mode==='duplicate-archive')rows.push(plain(rows[0]));await put('scheduleConflictArchive',rows)}
 if(mode==='repairs'||mode.startsWith('repair-')){const rows=await meta('scheduleResourceRepairs');if(mode==='repairs')rows[0].ownerUserId='different';if(mode==='repair-fingerprint')rows[0].fileFingerprint='0'.repeat(64);if(mode==='repair-before')rows[0].before.state.entry.title='different';await put('scheduleResourceRepairs',rows)}
 if(mode==='source')await h.db.schedules.update(id,{title:'changed'})
 if(mode==='entry')await h.db.entries.update(id,{dirty:1})
 if(mode==='media-meta')await h.db.media.update(h.model.RESOURCE_MEDIA_ID,{remoteUrl:'https://private.example'})
 if(mode==='media-bytes')await h.db.media.update(h.model.RESOURCE_MEDIA_ID,{blob:new Blob([new Uint8Array(68)],{type:'image/png'})})
 if(mode==='extra-meta')await put('unknown','retain')
 if(mode==='marker')await put('p4AcceptanceOrigin',{unknown:true})
 if(mode==='owner')await put('ownerUserId','foreign-owner')
 const before=all(h);await assert.rejects(h.resolution.inspectResourceAcceptanceLifecycle(spec));await assert.rejects(h.resolution.readResourceAcceptanceSavedFile(spec,await file.getFile()));assert.equal(all(h),before)
 }finally{panel.dispose();s.close()}
})
for(const mode of ['fixture-material','oversized','truncated','wrong-choice','different-export','corrupt-image','private-local'])test(`explicit saved-file reopen ${mode} cannot confirm this handoff or change state`,async()=>{
 const h=harness();await h.complete();const s=h.session(),native=h.native(),panel=h.panel(s,native)
 try{await h.prepare(panel);assert.equal(await panel.resolve(),true);s.close();let text=native.text
 if(mode==='fixture-material')text=h.model.resourceFixtureMaterial()
 if(mode==='truncated')text=text.slice(0,-20)
 if(!['fixture-material','oversized','truncated'].includes(mode)){const value=JSON.parse(text);if(mode==='wrong-choice')value.choice=KEEP;if(mode==='different-export')value.exportedAt='2026-10-17T10:00:00.000Z';if(mode==='corrupt-image')value.local.media[0].blobBase64=h.model.RESOURCE_PNG.replace('iVBOR','aVBOR');if(mode==='private-local')value.local.state.entry.title='private';text=JSON.stringify(value)}
 const file={size:mode==='oversized'?65537:new Blob([text]).size,text:async()=>text},before=all(h)
 await assert.rejects(h.resolution.readResourceAcceptanceSavedFile(spec,file));assert.equal(all(h),before)
 }finally{panel.dispose();s.close()}
})
test('explicit saved-file reopen performs one physical read; token changes during it refuse without credential cleanup',async()=>{
 const h=harness();await h.complete();const s=h.session(),file=h.native(),panel=h.panel(s,file)
 try{await h.prepare(panel);assert.equal(await panel.resolve(),true);s.close();let reads=0;const physical={size:new Blob([file.text]).size,text:async()=>{reads++;return file.text}}
 assert.equal((await h.resolution.readResourceAcceptanceSavedFile(spec,physical)).verified,true);assert.equal(reads,1)
 const before=all(h);physical.text=async()=>{h.token('preserve-token');return file.text};await assert.rejects(h.resolution.readResourceAcceptanceSavedFile(spec,physical));assert.equal(all(h),before)
 }finally{panel.dispose();s.close()}
})
test('closing during host preflight never starts a late resolver request',async()=>{
 const h=harness();await h.complete();const pendingRead=gate(),started=gate(),original=h.db.schedules.toArray
 let paused=false;h.db.schedules.toArray=async()=>{if(!paused){paused=true;started.resolve();await pendingRead.promise}return original()}
 const s=h.session(),before=all(h);const pending=s.port.review(h.model.RESOURCE_SOURCE_ID);await started.promise;s.close();pendingRead.resolve()
 assert.equal((await pending).ready,false);assert.equal(all(h),before)
})
test('new page mounts only explicit exclusive sessions and wires native save, read-only reopen, cancellation and truthful counts',()=>{
 const text=fs.readFileSync(path.join(__dirname,'../src/resource-acceptance/ResourceAcceptancePage.vue'),'utf8')
 for(const word of ['openResolution','closeResolution','pickResourceConflictSaveTarget','fileSavingSupported','readSavedFile','armResolution','inspectResourceAcceptanceLifecycle'])assert.match(text,new RegExp(word))
 assert.match(text,/v-if="resolutionSession"/);assert.match(text,/:port="resolutionSession.port"/);assert.match(text,/@close="closeResolution"/);assert.match(text,/1\/1\/0\/0/)
 assert.doesNotMatch(text,/onMounted|fetch\(|axios|db\.|v-html|<img/)
 assert.match(text,/pageRevision\+\+/);assert.match(text,/alive = false/);assert.match(text,/input.value = ""/)
 const source=fs.readFileSync(path.join(__dirname,'../src/resource-acceptance/resolution.ts'),'utf8');assert.doesNotMatch(source,/fetch\(|axios|\.clear\(|\.delete\(|createScheduleCloudResourceTransport/)
 assert.doesNotThrow(()=>require('node:module').stripTypeScriptTypes(text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]))
})
