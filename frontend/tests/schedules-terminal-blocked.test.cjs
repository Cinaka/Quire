const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path')
const {ID,OTHER_ID,AT,content,schedule,terminal,entry,intent,setup}=require('./schedules-data-harness.cjs')
const SERVER='2026-10-08T10:00:02.000Z',TAG='019a0300-1234-7000-8000-000000000003'
const all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
const image=id=>({schemaVersion:1,doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'当前含图正文'}]},{type:'image',attrs:{src:`local://media/${id}`}}]}})
function sourceWire(r){return {id:r.id,remind_date:r.remindDate,title:r.title,content:r.content,content_text:r.contentText,status:r.status,converted_entry_id:r.convertedEntryId,converted_at:r.convertedAt,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
function entryWire(r){return {id:r.id,from_schedule_id:r.fromScheduleId,entry_date:r.entryDate,sort_order:r.sortOrder,title:r.title,content:r.content,content_text:r.contentText,mood:r.mood,weather:r.weather,tag_ids:r.tagIds,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
async function fixture(){
  const h=setup();h.mocks['@/api/tokenStore']=h.tokens
  const source=terminal(),diary=entry({title:'当前本机日记'}),first=intent({ownerUserId:'account-a'})
  const remote=terminal({title:'当前云端来源',dirty:0,updatedAt:SERVER,serverUpdatedAt:SERVER}),remoteEntry=entry({title:'当前云端日记',dirty:0,updatedAt:SERVER,serverUpdatedAt:SERVER})
  const reply={read_only:true,reviewable:false,reason:'receipt_unknown',receipt_known:false,first_entry_date:null,first_entry_deleted:null,schedule:sourceWire(remote),entry:entryWire(remoteEntry),entry_state:'active'}
  await h.db.meta.put({key:'ownerUserId',value:'account-a'});await h.db.meta.put({key:'ownerGeneration',value:'epoch'})
  await h.db.schedules.put(source);await h.db.entries.put(diary);await h.db.meta.put({key:'scheduleConversions',value:[first]})
  await h.db.meta.put({key:'scheduleConflicts',value:[{scheduleId:ID,kind:'conversion-transport',stage:'convert',reason:'receipt_unknown',firstIntent:first,serverSchedule:remote,serverEntry:remoteEntry,firstEntryDate:null,firstEntryDeleted:null},{scheduleId:OTHER_ID,kind:'other-keep'}]})
  const options={},calls=[],transport={async review(id,lease){calls.push({id,lease:structuredClone(lease)});if(options.get)await options.get(h,calls.length);return reply}}
  const observer=h.load('db/scheduleTerminalBlockedRepo.ts').createInternalTerminalBlockedObserver(transport),codec=h.load('shared/scheduleTerminalBlockers.ts'),io=h.load('io/scheduleTerminalBlockedFile.ts')
  let bytes='',writes=0,closes=0,aborts=0
  const file={async getFile(){if(options.getFile)await options.getFile(h);return {size:new Blob([bytes]).size,async text(){return options.badReadback?'{}':bytes}}},async createWritable(o){assert.equal(JSON.stringify(o),JSON.stringify({keepExistingData:false,mode:'exclusive'}));return {async write(text){writes++;if(options.write)await options.write(h);bytes=text},async close(){closes++;if(options.close)await options.close(h)},async abort(){aborts++}}}}
  return Object.assign(h,{source,diary,first,remote,remoteEntry,reply,options,calls,transport,observer,codec,io,file,bytes:()=>bytes,setBytes:v=>bytes=v,stats:()=>({writes,closes,aborts})})
}
async function addImage(h){
  await h.db.entries.put({...h.diary,content:image(OTHER_ID),tagIds:[TAG]})
  await h.db.media.put({id:OTHER_ID,entryId:ID,blob:new Blob(['local original bytes'],{type:'image/png'}),thumbBlob:new Blob(['thumbnail'],{type:'image/webp'}),mime:'image/png',width:2,height:3,size:20,sortOrder:0,remoteUrl:'https://private.invalid?token=secret',thumbRemoteUrl:'https://private.invalid?signature=secret',createdAt:AT,dirty:1,orphanedAt:null})
  await h.db.tags.put({id:TAG,name:'本机标签',color:'green',createdAt:AT,dirty:1})
}
test('unknown receipt observation saves current local evidence and cloud observation without confirmation or any DB write',async()=>{
  const h=await fixture(),before=all(h);assert.equal(h.calls.length,0)
  const r=await h.observer.review(ID);assert.equal(r.ready,true);assert.ok(r.blocks.includes('receipt_unknown'));assert.equal(r.resolutionEnabled,false);assert.equal(r.localIntentStatus,'not_checked');assert.equal(h.stats().writes,0)
  const out=await h.observer.save(r.reviewId,true,h.file);assert.equal(out.saved,true);assert.equal(out.cloudResourcesIncluded,false);assert.equal(out.cloudSynced,false);assert.equal(all(h),before)
  assert.equal(h.calls.length,3);assert.deepEqual(h.stats(),{writes:1,closes:1,aborts:0})
  const e=await h.io.readTerminalBlockedFile({size:new Blob([h.bytes()]).size,text:async()=>h.bytes()})
  assert.equal(e.server.receiptKnown,false);assert.equal(e.server.firstEntryDate,null);assert.equal(e.server.firstEntryDeleted,null)
  assert.equal(e.local.state.intentions[0].entry.title,h.first.entry.title);assert.equal(e.local.state.entry.title,h.diary.title)
  assert.equal(e.meaning,'observation_not_receipt_ack_or_restore');assert.equal(e.resolutionEnabled,false)
  assert.equal((await h.load('db/scheduleStateRepo.ts').protectedConversions()).entryIds.has(ID),true)
  for(const key of ['ownerUserId','tokenGeneration','generation','Bearer'])assert.equal(h.bytes().includes(key),false)
  assert.equal((await h.observer.save(r.reviewId,true,h.file)).saved,false)
})
test('observer preserves real local images/thumbnails and tag definitions but never claims cloud bytes',async()=>{
  const h=await fixture();await addImage(h);h.reply.entry.content=image(OTHER_ID);h.reply.entry.tag_ids=[TAG]
  const before=all(h),r=await h.observer.review(ID);assert.equal(r.ready,true);assert.ok(r.blocks.includes('resources_need_review'))
  assert.equal((await h.observer.save(r.reviewId,true,h.file)).saved,true);assert.equal(all(h),before)
  const e=h.codec.parseTerminalBlockedEvidence(h.bytes());assert.equal(e.cloudMediaIds[0],OTHER_ID);assert.equal(e.cloudTagIds[0],TAG)
  assert.equal(Buffer.from(e.local.media[0].blobBase64,'base64').toString(),'local original bytes')
  assert.equal(Buffer.from(e.local.media[0].thumbBase64,'base64').toString(),'thumbnail');assert.equal(e.local.tags[0].name,'本机标签')
  assert.equal(e.cloudResourcesIncluded,false);assert.equal(h.bytes().includes('https://private.invalid'),false);assert.equal(h.bytes().includes('signature=secret'),false)
})
for(const missing of ['image','tag','placeholder'])test(`observer ${missing} gap is explicit and save cannot masquerade as complete backup`,async()=>{
  const h=await fixture();await addImage(h)
  if(missing==='image')await h.db.media.delete(OTHER_ID)
  if(missing==='tag')await h.db.tags.delete(TAG)
  if(missing==='placeholder'){const m=await h.db.media.get(OTHER_ID);await h.db.media.put({...m,blob:new Blob([])})}
  const before=all(h),r=await h.observer.review(ID);assert.equal(r.ready,true);assert.equal(r.completeLocalResources,false);assert.ok(r.blocks.includes('local_resources_missing'))
  const out=await h.observer.save(r.reviewId,true,h.file);assert.equal(out.saved,true);assert.equal(out.completeLocalResources,false);assert.equal(all(h),before)
  const e=h.codec.parseTerminalBlockedEvidence(h.bytes());assert.equal((missing==='tag'?e.local.missingTagIds:e.local.missingMediaIds)[0],missing==='tag'?TAG:OTHER_ID)
})
for(const state of ['active','deleted','purged'])test(`unknown receipt ${state} remains unknown even when current diary state is observable`,async()=>{
  const h=await fixture();if(state==='deleted'){h.reply.entry.deleted_at=AT;h.reply.entry_state='deleted'}
  if(state==='purged'){h.reply.entry=null;h.reply.entry_state='purged'}
  const before=all(h),r=await h.observer.review(ID);assert.equal(r.ready,true);assert.ok(r.blocks.includes('receipt_unknown'))
  if(state!=='active')assert.ok(r.blocks.includes(`cloud_entry_${state}`))
  assert.equal((await h.observer.save(r.reviewId,true,h.file)).saved,true);assert.equal(all(h),before)
  assert.equal(h.codec.parseTerminalBlockedEvidence(h.bytes()).server.receiptKnown,false)
})
for(const mode of ['pending-cloud','missing-local','source-delete','purge','no-first-intent','duplicate-link','pending-local'])test(`observer explains ${mode} without treating a name as a diagnosis`,async()=>{
  const h=await fixture();let expected
  if(mode==='pending-cloud'){h.reply.schedule=sourceWire(schedule());h.reply.entry=null;h.reply.entry_state='unknown';h.reply.reason='not_terminal';expected='cloud_not_terminal'}
  if(mode==='missing-local'){await h.db.entries.delete(ID);expected='local_entry_missing'}
  if(mode==='source-delete'){h.reply.schedule.deleted_at=AT;expected='source_deletion_differs'}
  if(mode==='purge'){await h.db.meta.put({key:'pendingPurges',value:[ID]});expected='existing_purge'}
  if(mode==='no-first-intent'){await h.db.meta.put({key:'scheduleConversions',value:[]});expected='first_intent_missing'}
  if(mode==='duplicate-link'){await h.db.entries.put(entry({id:OTHER_ID,fromScheduleId:ID}));expected='local_identity'}
  if(mode==='pending-local'){await h.db.schedules.put(schedule());expected='local_source_not_terminal'}
  const before=all(h),r=await h.observer.review(ID);assert.equal(r.ready,true);assert.ok(r.blocks.includes(expected));assert.equal(r.resolutionEnabled,false)
  assert.equal((await h.observer.save(r.reviewId,true,h.file)).saved,true);assert.equal(all(h),before)
})
for(const mode of ['draft','schedule-draft','bad-candidate','bad-queue','foreign-queue','bad-purges','unknown-content','bad-media'])test(`observer unsupported ${mode} retains original library instead of dumping unsafe raw fields`,async()=>{
  const h=await fixture()
  if(mode==='draft')await h.db.meta.put({key:'draft',value:{unsaved:'keep'}})
  if(mode==='schedule-draft')await h.db.meta.put({key:'scheduleDraft',value:{unsaved:'keep'}})
  if(mode==='bad-candidate')await h.db.meta.put({key:'scheduleConflicts',value:[{scheduleId:ID,kind:'future',privateToken:'secret'}]})
  if(mode==='bad-queue')await h.db.meta.put({key:'scheduleConversions',value:'keep broken'})
  if(mode==='foreign-queue')await h.db.meta.put({key:'scheduleConversions',value:[{...h.first,ownerUserId:'account-b'}]})
  if(mode==='bad-purges')await h.db.meta.put({key:'pendingPurges',value:'keep broken'})
  if(mode==='unknown-content')await h.db.entries.put({...h.diary,content:{schemaVersion:999,doc:{type:'doc'}}})
  if(mode==='bad-media'){await addImage(h);const m=await h.db.media.get(OTHER_ID);await h.db.media.put({...m,privateToken:'keep in library'})}
  const before=all(h),r=await h.observer.review(ID);assert.equal(r.ready,false);assert.equal(r.reason,'observation_unconfirmed_keep_library');assert.equal(h.calls.length,0);assert.equal(all(h),before)
})
for(const mode of ['file','truthy','false','review'])test(`observation missing ${mode} consent cannot read/write a file or send more requests`,async()=>{
  const h=await fixture(),r=await h.observer.review(ID),before=all(h)
  const out=await h.observer.save(mode==='review'?r.reviewId+1:r.reviewId,mode==='truthy'?'yes':mode==='false'?false:true,mode==='file'?undefined:h.file)
  assert.equal(out.saved,false);assert.equal(h.calls.length,1);assert.equal(h.stats().writes,0);assert.equal(all(h),before)
})
for(const mode of ['exists','close','readback','account','relogin','epoch','diary','source','queue','candidate','media','cloud','cancel'])test(`observation file boundary ${mode} cannot report a verified stale save or release protection`,async()=>{
  const h=await fixture();if(mode==='media')await addImage(h)
  const r=await h.observer.review(ID);assert.equal(r.ready,true);if(mode==='exists')h.setBytes('existing');if(mode==='readback')h.options.badReadback=true
  let after;h.options.close=async()=>{
    if(mode==='close')throw new Error('private token')
    if(mode==='account')h.user('account-b')
    if(mode==='relogin'){h.user('account-b');h.user('account-a')}
    if(mode==='epoch')await h.db.meta.put({key:'ownerGeneration',value:'restored'})
    if(mode==='diary')await h.db.entries.put({...h.diary,title:'new edit'})
    if(mode==='source')await h.db.schedules.put({...h.source,title:'new source'})
    if(mode==='queue')await h.db.meta.put({key:'scheduleConversions',value:[{...h.first,queuedAt:SERVER}]})
    if(mode==='candidate')await h.db.meta.put({key:'scheduleConflicts',value:[]})
    if(mode==='media'){const m=await h.db.media.get(OTHER_ID);await h.db.media.put({...m,blob:new Blob(['different same bytes'])})}
    if(mode==='cloud')h.reply.entry.title='changed cloud'
    if(mode==='cancel')h.observer.cancel()
    after=all(h)
  }
  const before=all(h),out=await h.observer.save(r.reviewId,true,h.file);assert.equal(out.saved,false);assert.equal(out.resolutionEnabled,false);assert.equal(all(h),after??before)
})
for(const mode of ['account','relogin','epoch','source'])test(`observer first context never rebinds after ${mode}`,async()=>{
  const h=await fixture();await h.observer.review(ID)
  if(mode==='account')h.user('account-b');if(mode==='relogin'){h.user('account-b');h.user('account-a')};if(mode==='epoch')await h.db.meta.put({key:'ownerGeneration',value:'new'})
  assert.equal((await h.observer.review(mode==='source'?OTHER_ID:ID)).ready,false);assert.equal(h.calls.length,1)
})
for(const phase of [1,2,3])for(const mode of ['network','cancel'])test(`observer ${mode} at read-only request ${phase} cannot leak raw error or produce late success`,async()=>{
  const h=await fixture();h.options.get=async(_,n)=>{if(n===phase){if(mode==='cancel')h.observer.cancel();else throw new Error('Bearer private credentials')}}
  const before=all(h),r=await h.observer.review(ID),out=phase===1?r:await h.observer.save(r.reviewId,true,h.file)
  assert.equal(phase===1?out.ready:out.saved,false);assert.equal(all(h),before);assert.equal(JSON.stringify(out).includes('credentials'),false)
})
for(const field of ['meaning','enabled','cloud-complete','first-date','unknown','local-complete','cloud-refs','server-field'])test(`blocked evidence refuses ${field} tampering and false authority`,async()=>{
  const h=await fixture(),r=await h.observer.review(ID);assert.equal((await h.observer.save(r.reviewId,true,h.file)).saved,true)
  const e=JSON.parse(h.bytes());assert.equal(h.codec.serializeTerminalBlockedEvidence(e),h.bytes())
  if(field==='meaning')e.meaning='confirmed';if(field==='enabled')e.resolutionEnabled=true;if(field==='cloud-complete')e.cloudResourcesIncluded=true
  if(field==='first-date')e.server.firstEntryDate='2026-10-07';if(field==='unknown')e.privateToken='secret'
  if(field==='local-complete'){e.local.completeLocalResources=false};if(field==='cloud-refs')e.cloudMediaIds=[OTHER_ID];if(field==='server-field')e.server.privateToken='secret'
  assert.throws(()=>h.codec.parseTerminalBlockedEvidence(JSON.stringify(e)))
})
for(const field of ['schedule','entry'])test(`observer unknown nested cloud ${field} fields cannot be silently dropped into evidence`,async()=>{
  const h=await fixture();h.reply[field].privateToken='secret';const before=all(h)
  assert.equal((await h.observer.review(ID)).ready,false);assert.equal(all(h),before);assert.equal(h.stats().writes,0)
})
test('observer cancel keeps busy until an outstanding file closes; no metadata or protection changes',async()=>{
  const h=await fixture(),r=await h.observer.review(ID);let release,opened;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>opened=resolve)
  h.options.write=async()=>{opened();await gate};const before=all(h),pending=h.observer.save(r.reviewId,true,h.file);await started;h.observer.cancel()
  assert.equal((await h.observer.review(ID)).reason,'busy');release();assert.equal((await pending).saved,false);assert.equal(all(h),before)
})
test('observer exports no resolver, queue-removal, media download, sync or formal registration',()=>{
  const h=setup();h.mocks['@/api/tokenStore']=h.tokens;const factory=h.load('db/scheduleTerminalBlockedRepo.ts').createInternalTerminalBlockedObserver({review:async()=>{throw Error('unexpected')}})
  assert.equal(JSON.stringify(Object.keys(factory).sort()),JSON.stringify(['cancel','review','save']))
  for(const file of ['repo/index.ts','router/index.ts','api/sync.ts','db/scheduleSyncRepo.ts'])assert.equal(fs.readFileSync(path.join(__dirname,'../src',file),'utf8').includes('createInternalTerminalBlockedObserver'),false)
  const repo=fs.readFileSync(path.join(__dirname,'../src/db/scheduleTerminalBlockedRepo.ts'),'utf8');for(const text of ['.put(','.delete(','.post(','fetch(','runSync('])assert.equal(repo.includes(text),false)
})
for(const reason of ['invalid_state','identity_conflict'])test(`server ${reason} report is explained but never authorized as a new identity`,async()=>{
  const h=await fixture();h.reply.reason=reason;h.reply.entry=null;h.reply.entry_state='unknown'
  const before=all(h),r=await h.observer.review(ID);assert.equal(r.ready,true);assert.ok(r.blocks.includes('cloud_invalid_identity'))
  assert.equal((await h.observer.save(r.reviewId,true,h.file)).saved,true);assert.equal(all(h),before)
})
test('blocked file cannot be laundered through an existing actionable conflict or local-resource codec',async()=>{
  const h=await fixture(),r=await h.observer.review(ID);assert.equal((await h.observer.save(r.reviewId,true,h.file)).saved,true)
  assert.throws(()=>h.load('shared/scheduleConflictEvidenceFile.ts').parseConflictEvidenceFile(h.bytes()))
  assert.throws(()=>h.load('shared/scheduleResourceEvidence.ts').parseScheduleResourceEvidence(h.bytes()))
})
test('blocked file refuses deep or overlarge structures before business validation',async()=>{
  const h=await fixture();assert.throws(()=>h.codec.parseTerminalBlockedEvidence(''))
  assert.throws(()=>h.codec.parseTerminalBlockedEvidence('{broken'))
  let nested={};for(let n=0;n<80;n++)nested={nested};assert.throws(()=>h.codec.parseTerminalBlockedEvidence(JSON.stringify(nested)))
})
test('observer cannot label a known first receipt as unknown or derive one from the current diary',async()=>{
  const h=await fixture();h.reply.first_entry_date='2026-10-07';const before=all(h)
  assert.equal((await h.observer.review(ID)).ready,false);assert.equal(all(h),before)
})
test('observer does not fetch external cloud images or claim their bytes were preserved',async()=>{
  const h=await fixture();h.reply.entry.content={schemaVersion:1,doc:{type:'doc',content:[{type:'image',attrs:{src:'https://private.invalid/image?token=secret'}}]}}
  const before=all(h);assert.equal((await h.observer.review(ID)).ready,false);assert.equal(h.calls.length,1);assert.equal(h.stats().writes,0);assert.equal(all(h),before)
})
