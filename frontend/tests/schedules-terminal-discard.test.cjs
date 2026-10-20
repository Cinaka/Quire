const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path')
const {ID,OTHER_ID,AT,content,schedule,terminal,entry,intent,setup}=require('./schedules-data-harness.cjs')
const SERVER='2026-10-08T10:00:02.000Z',LATER='2026-10-08T10:00:01.123456Z',ARCHIVE='scheduleConflictArchive'
const FINISH='finish-cloud-purged',HANDOFF='handoff-cleared-tombstone'
const all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
function sourceWire(r){return {id:r.id,remind_date:r.remindDate,title:r.title,content:r.content,content_text:r.contentText,status:r.status,converted_entry_id:r.convertedEntryId,converted_at:r.convertedAt,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
function entryWire(r){return {id:r.id,from_schedule_id:r.fromScheduleId,entry_date:r.entryDate,sort_order:r.sortOrder,title:r.title,content:r.content,content_text:r.contentText,mood:r.mood,weather:r.weather,tag_ids:r.tagIds,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
async function fixture(choice=FINISH){
  const h=setup();h.mocks['@/api/tokenStore']=h.tokens
  const source=terminal(),stub=entry({title:'',content:null,contentText:'',isDeleted:1,deletedAt:AT}),first=intent({ownerUserId:'account-a'})
  const remoteSource=terminal({title:'云端终态来源',dirty:0,updatedAt:SERVER,serverUpdatedAt:SERVER})
  const remoteEntry=entry({title:'云端已删正文',content:content('保存在文件'),isDeleted:1,deletedAt:AT,clientUpdatedAt:LATER,dirty:0,updatedAt:SERVER,serverUpdatedAt:SERVER})
  const reply={read_only:true,reviewable:true,reason:'terminal_review',receipt_known:true,first_entry_date:'2026-10-07',first_entry_deleted:false,
    schedule:sourceWire(remoteSource),entry:choice===FINISH?null:entryWire(remoteEntry),entry_state:choice===FINISH?'purged':'deleted'}
  await h.db.meta.put({key:'ownerUserId',value:'account-a'});await h.db.meta.put({key:'ownerGeneration',value:'epoch'})
  await h.db.schedules.put(source);await h.db.entries.put(stub);await h.db.meta.put({key:'scheduleConversions',value:[first]})
  await h.db.meta.put({key:'pendingPurges',value:[ID,OTHER_ID]})
  const candidates=[{scheduleId:ID,kind:'conversion-entry',localEntry:stub,serverEntry:choice===FINISH?null:remoteEntry},{scheduleId:OTHER_ID,kind:'keep-other'}]
  await h.db.meta.put({key:'scheduleConflicts',value:candidates})
  const options={},calls=[],transport={async review(id,lease){calls.push({id,lease:structuredClone(lease)});if(options.get)await options.get(h,calls.length);return reply}}
  const repo=h.load('db/scheduleTerminalConflictRepo.ts'),resolver=repo.createInternalScheduleTerminalDiscardResolver(transport)
  let bytes='',writes=0,closes=0,aborts=0
  const file={async getFile(){return {size:new Blob([bytes]).size,async text(){return options.badReadback?'{}':bytes}}},
    async createWritable(o){assert.equal(JSON.stringify(o),JSON.stringify({keepExistingData:false,mode:'exclusive'}));return {
      async write(text){writes++;if(options.write)await options.write(h);bytes=text},async close(){closes++;if(options.close)await options.close(h)},async abort(){aborts++}}}}
  return Object.assign(h,{choice,source,stub,first,remoteSource,remoteEntry,reply,options,calls,transport,repo,resolver,file,candidates,
    bytes:()=>bytes,setBytes:value=>bytes=value,stats:()=>({writes,closes,aborts})})
}
for(const choice of [FINISH,HANDOFF])test(`${choice} requires physical evidence then converges only the existing purge request`,async()=>{
  const h=await fixture(choice),other=intent({scheduleId:OTHER_ID,source:schedule({id:OTHER_ID}),entry:entry({id:OTHER_ID,fromScheduleId:OTHER_ID}),ownerUserId:'account-a'})
  await h.db.meta.put({key:'scheduleConversions',value:[h.first,other]});await h.db.meta.put({key:'lastSyncAt',value:'P2 cursor'});await h.db.meta.put({key:'scheduleLastSyncAt',value:'P4 cursor'})
  const before=all(h);assert.equal(h.calls.length,0);const r=await h.resolver.review(ID);assert.equal(JSON.stringify(r.choices),JSON.stringify([choice]));assert.equal(all(h),before)
  h.options.close=async()=>{assert.equal(all(h),before)}
  const out=await h.resolver.resolve(r.reviewId,choice,true,h.file);assert.equal(out.applied,true);assert.equal(out.cloudSynced,false)
  assert.equal(out.localIntentStatus,'superseded_by_explicit_existing_purge')
  const row=await h.db.entries.get(ID)
  if(choice===FINISH){assert.equal(row,undefined);assert.equal((await h.db.meta.get('pendingPurges')).value.includes(ID),false)}
  else {assert.equal(row.title,'');assert.equal(row.content,null);assert.equal(row.isDeleted,1);assert.equal(row.dirty,1)
    assert.ok(row.clientUpdatedAt>LATER);assert.equal(row.serverUpdatedAt,SERVER);assert.equal((await h.db.meta.get('pendingPurges')).value.includes(ID),true)}
  assert.equal((await h.db.meta.get('pendingPurges')).value.includes(OTHER_ID),true)
  const source=await h.db.schedules.get(ID);assert.equal(source.status,'converted');assert.equal(source.convertedEntryId,ID);assert.equal(source.dirty,0)
  assert.equal(JSON.stringify((await h.db.meta.get('scheduleConversions')).value),JSON.stringify([other]))
  assert.equal(JSON.stringify((await h.db.meta.get('scheduleConflicts')).value),JSON.stringify([h.candidates[1]]))
  assert.equal((await h.db.meta.get('lastSyncAt')).value,'P2 cursor');assert.equal((await h.db.meta.get('scheduleLastSyncAt')).value,'P4 cursor')
  const archive=(await h.db.meta.get(ARCHIVE)).value;assert.equal(archive.length,1);assert.equal(archive[0].kind,'terminal-existing-purge-resolution')
  const codec=h.load('shared/scheduleConflictEvidenceFile.ts'),e=codec.parseConflictEvidenceFile(h.bytes());assert.equal(e.format,'terminal-discard-evidence')
  assert.equal(e.localEntry.content,null);assert.equal(e.intentions[0].entry.title,h.first.entry.title);assert.equal(e.pendingPurges.includes(ID),true)
  for(const key of ['ownerUserId','tokenGeneration','generation','Bearer'])assert.equal(h.bytes().includes(key),false)
  const held=await h.load('db/scheduleStateRepo.ts').protectedConversions();assert.equal(held.entryIds.has(ID),false);assert.equal(held.entryIds.has(OTHER_ID),true)
  assert.equal(h.calls.length,3);assert.deepEqual(h.stats(),{writes:1,closes:1,aborts:0})
  assert.equal((await h.resolver.resolve(r.reviewId,choice,true,h.file)).applied,false)
})
test('already missing local diary can finish known cloud absence without adding any diary row',async()=>{
  const h=await fixture();await h.db.entries.delete(ID);const r=await h.resolver.review(ID)
  assert.equal((await h.resolver.resolve(r.reviewId,FINISH,true,h.file)).applied,true);assert.equal(h.stores.entries.rows.size,0)
  assert.equal(JSON.parse(h.bytes()).localEntry,null)
})
for(const mode of ['active-local','deleted-with-content','missing-local-on-deleted','active-cloud','receipt-unknown','no-purge','no-intent','media','protected-media','tags','foreign-link','duplicate-link','p2-conflict','draft','source-restore','unknown-candidate','unknown-local'])test(`discard ${mode} remains protected with no file or diary changes`,async()=>{
  const h=await fixture(mode==='missing-local-on-deleted'?HANDOFF:FINISH)
  if(mode==='active-local')await h.db.entries.put(entry())
  if(mode==='deleted-with-content')await h.db.entries.put(entry({isDeleted:1,deletedAt:AT}))
  if(mode==='missing-local-on-deleted')await h.db.entries.delete(ID)
  if(mode==='active-cloud'){h.reply.entry=entryWire(entry());h.reply.entry_state='active'}
  if(mode==='receipt-unknown'){h.reply.receipt_known=false;h.reply.reviewable=false;h.reply.reason='receipt_unknown';h.reply.first_entry_date=null;h.reply.first_entry_deleted=null}
  if(mode==='no-purge')await h.db.meta.put({key:'pendingPurges',value:[OTHER_ID]})
  if(mode==='no-intent')await h.db.meta.put({key:'scheduleConversions',value:[]})
  if(mode==='media')await h.db.media.put({id:OTHER_ID,entryId:ID,blob:new Blob(['bytes'])})
  if(mode==='protected-media')await h.db.meta.put({key:'scheduleConversions',value:[{...h.first,protectedMediaIds:[OTHER_ID]}]})
  if(mode==='tags')await h.db.entries.put({...h.stub,tagIds:[OTHER_ID]})
  if(mode==='foreign-link')await h.db.entries.put({...h.stub,fromScheduleId:OTHER_ID})
  if(mode==='duplicate-link')await h.db.entries.put(entry({id:OTHER_ID,fromScheduleId:ID}))
  if(mode==='p2-conflict')await h.db.meta.put({key:'conflicts',value:[{entryId:ID,local:h.stub}]})
  if(mode==='draft')await h.db.meta.put({key:'draft',value:{unsaved:'keep'}})
  if(mode==='source-restore')await h.db.schedules.put({...h.source,isDeleted:1,deletedAt:AT})
  if(mode==='unknown-candidate')await h.db.meta.put({key:'scheduleConflicts',value:[{scheduleId:ID,kind:'future'}]})
  if(mode==='unknown-local')await h.db.entries.put({...h.stub,futureField:'do not strip'})
  const before=all(h),r=await h.resolver.review(ID);assert.equal(r.choices.length,0)
  assert.equal((await h.resolver.resolve(r.reviewId,h.choice,true,h.file)).applied,false);assert.equal(all(h),before);assert.equal(h.stats().writes,0)
})
for(const mode of ['truthy','false','file','choice','review'])test(`discard missing ${mode} authorization never starts more requests`,async()=>{
  const h=await fixture(),r=await h.resolver.review(ID),before=all(h)
  const out=await h.resolver.resolve(mode==='review'?r.reviewId+1:r.reviewId,mode==='choice'?HANDOFF:FINISH,mode==='truthy'?'yes':mode==='false'?false:true,mode==='file'?undefined:h.file)
  assert.equal(out.applied,false);assert.equal(h.calls.length,1);assert.equal(h.stats().writes,0);assert.equal(all(h),before)
})
for(const choice of [FINISH,HANDOFF])for(const mode of ['file-exists','close-failure','bad-readback','cancel','account','relogin','epoch','edit','purge-cancel','candidate','cloud'])test(`${choice} file boundary ${mode} retains current state and original conversion protection`,async()=>{
  const h=await fixture(choice),r=await h.resolver.review(ID);if(mode==='file-exists')h.setBytes('existing');if(mode==='bad-readback')h.options.badReadback=true
  let after;h.options.close=async()=>{
    if(mode==='close-failure')throw new Error('private token')
    if(mode==='cancel')h.resolver.cancel()
    if(mode==='account')h.user('account-b')
    if(mode==='relogin'){h.user('account-b');h.user('account-a')}
    if(mode==='epoch')await h.db.meta.put({key:'ownerGeneration',value:'restored'})
    if(mode==='edit')await h.db.entries.put({...h.stub,title:'new protected edit'})
    if(mode==='purge-cancel')await h.db.meta.put({key:'pendingPurges',value:[OTHER_ID]})
    if(mode==='candidate')await h.db.meta.put({key:'scheduleConflicts',value:[...h.candidates,{scheduleId:ID,kind:'future'}]})
    if(mode==='cloud')h.reply.schedule.title='changed proof'
    after=all(h)
  }
  const before=all(h),out=await h.resolver.resolve(r.reviewId,choice,true,h.file);assert.equal(out.applied,false);assert.equal(all(h),after??before)
  assert.equal((await h.db.meta.get('scheduleConversions')).value.length,1);assert.equal(await h.db.meta.get(ARCHIVE),undefined)
})
for(const choice of [FINISH,HANDOFF])for(const point of (choice===FINISH?['archive','baseline','source','entry','queue','candidate','purges']:['archive','baseline','source','entry','queue','candidate']))test(`${choice} transaction ${point} failure rolls back all local changes`,async()=>{
  const h=await fixture(choice),r=await h.resolver.review(ID),before=all(h)
  const store=point==='source'?h.db.schedules:point==='entry'?h.db.entries:h.db.meta,operation=point==='entry'&&choice===FINISH?'delete':'put',original=store[operation]
  const key={archive:ARCHIVE,baseline:`scheduleServerState:${ID}`,queue:'scheduleConversions',candidate:'scheduleConflicts',purges:'pendingPurges'}[point]
  store[operation]=async row=>{if(key===undefined || row.key===key)throw new Error('injected transaction failure');return original(row)}
  assert.equal((await h.resolver.resolve(r.reviewId,choice,true,h.file)).applied,false);assert.equal(all(h),before)
})
for(const phase of [1,2,3])test(`discard request ${phase} cancel prevents late review or commit`,async()=>{
  const h=await fixture();h.options.get=async(_,n)=>{if(n===phase)h.resolver.cancel()};const before=all(h),r=await h.resolver.review(ID)
  const out=phase===1?r:await h.resolver.resolve(r.reviewId,FINISH,true,h.file);assert.equal(phase===1?out.ready:out.applied,false);assert.equal(all(h),before)
})
for(const mode of ['account','relogin','epoch','source'])test(`discard first session cannot rebind after ${mode}`,async()=>{
  const h=await fixture();await h.resolver.review(ID)
  if(mode==='account')h.user('account-b');if(mode==='relogin'){h.user('account-b');h.user('account-a')};if(mode==='epoch')await h.db.meta.put({key:'ownerGeneration',value:'new'})
  assert.equal((await h.resolver.review(mode==='source'?OTHER_ID:ID)).ready,false);assert.equal(h.calls.length,1)
})
for(const choice of [FINISH,HANDOFF])test(`${choice} two independent resolvers cannot archive or consume the same intention twice`,async()=>{
  const h=await fixture(choice),other=h.repo.createInternalScheduleTerminalDiscardResolver(h.transport),a=await h.resolver.review(ID),b=await other.review(ID)
  assert.equal((await h.resolver.resolve(a.reviewId,choice,true,h.file)).applied,true);const before=all(h)
  assert.equal((await other.resolve(b.reviewId,choice,true,h.file)).applied,false);assert.equal(all(h),before);assert.equal((await h.db.meta.get(ARCHIVE)).value.length,1)
})
for(const field of ['format','meaning','choice','unknown','pendingPurges','receipt','local-content'])test(`discard evidence rejects ${field} tampering or laundering`,async()=>{
  const h=await fixture(),r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,FINISH,true,h.file)).applied,true)
  const codec=h.load('shared/scheduleConflictEvidenceFile.ts'),e=JSON.parse(h.bytes());assert.equal(codec.serializeConflictEvidenceFile(e),h.bytes())
  if(field==='format')e.format='terminal-source-tombstone-evidence'
  if(field==='meaning')e.meaning='explicit_choice_not_first_intent_confirmation'
  if(field==='choice')e.choice=HANDOFF
  if(field==='unknown')e.privateToken='do not strip'
  if(field==='pendingPurges')e.pendingPurges=[ID,123]
  if(field==='receipt')e.cloudReview.receiptKnown=false
  if(field==='local-content')e.localEntry.title='cannot discard a later edit'
  assert.throws(()=>codec.parseConflictEvidenceFile(JSON.stringify(e)))
})
test('finished cloud absence retains stable source identity and repeated conversion cannot regenerate a diary',async()=>{
  const h=await fixture(),r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,FINISH,true,h.file)).applied,true)
  const repo=h.load('db/scheduleConversionRepo.ts');const before=all(h)
  const out=await repo.convertLocalSchedule(ID,{expectedClientUpdatedAt:AT})
  assert.equal(out.created,false);assert.equal(out.entryState,'purged');assert.equal(all(h),before)
})
test('discard path has no formal mount, automatic sync or remote write method',()=>{
  for(const file of ['repo/index.ts','router/index.ts','api/sync.ts','db/scheduleSyncRepo.ts'])assert.equal(fs.readFileSync(path.join(__dirname,'../src',file),'utf8').includes('createInternalScheduleTerminalDiscardResolver'),false)
  const text=fs.readFileSync(path.join(__dirname,'../src/shared/scheduleTerminalDiscard.ts'),'utf8');assert.equal(text.includes('.post('),false)
})
for(const choice of [FINISH,HANDOFF])test(`${choice} ordinary P2 sends only an authorized cleared tombstone or no diary at all`,async()=>{
  const h=await fixture(choice),r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,choice,true,h.file)).applied,true)
  const sent=[];h.mocks['@/api/mappers']={fromWireEntry:r=>r,fromWireTag:r=>r,mediaPatchFromWire:r=>r,toWireEntry:r=>r,toWireTag:r=>r,toWireMediaMetaPush:r=>r}
  h.mocks['@/api/endpoints']={uploadMedia:async()=>{throw new Error('no media')},pushBatch:async body=>{sent.push(structuredClone(body));return {serverTime:SERVER,entries:body.entries.map(row=>({id:row.id,status:'applied'})),tags:[],mediaMeta:[]}},pullChanges:async()=>({serverTime:SERVER,syncUntil:SERVER,cursorId:'',hasMore:false,entries:[],tags:[],mediaMeta:[]})}
  await h.load('api/sync.ts').runSync();const rows=sent.flatMap(body=>body.entries)
  assert.equal(rows.length,choice===HANDOFF?1:0)
  if(choice===HANDOFF){assert.equal(rows[0].content,null);assert.equal(rows[0].title,'');assert.equal(rows[0].isDeleted,1);assert.equal(rows[0].fromScheduleId,ID)}
  assert.equal(await h.db.entries.get(ID),undefined);assert.equal(h.stores.entries.rows.size,0)
})
for(const point of ['archive','baseline','source','entry','queue','candidate','purges'])test(`discard cancellation after ${point} write rolls back all local changes`,async()=>{
  const h=await fixture(),r=await h.resolver.review(ID),before=all(h)
  const store=point==='source'?h.db.schedules:point==='entry'?h.db.entries:h.db.meta,operation=point==='entry'?'delete':'put',original=store[operation]
  const key={archive:ARCHIVE,baseline:`scheduleServerState:${ID}`,queue:'scheduleConversions',candidate:'scheduleConflicts',purges:'pendingPurges'}[point]
  let fired=false;store[operation]=async row=>{const out=await original(row);if(!fired&&(key===undefined||row.key===key)){fired=true;h.resolver.cancel()};return out}
  assert.equal((await h.resolver.resolve(r.reviewId,FINISH,true,h.file)).applied,false);assert.equal(fired,true);assert.equal(all(h),before)
})
for(const mode of ['newer-source','same-source-proof','newer-diary'])test(`discard ${mode} known watermark cannot be downgraded`,async()=>{
  const h=await fixture(HANDOFF)
  if(mode==='newer-source')await h.db.schedules.put({...h.source,serverUpdatedAt:'2026-10-08T10:00:03.000Z'})
  if(mode==='newer-diary')await h.db.entries.put({...h.stub,serverUpdatedAt:'2026-10-08T10:00:03.000001Z'})
  if(mode==='same-source-proof')await h.db.meta.put({key:`scheduleServerState:${ID}`,value:{ownerUserId:'account-a',generation:'epoch',source:{...h.remoteSource,title:'contradiction'}}})
  const before=all(h),r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,HANDOFF,true,h.file)).applied,false);assert.equal(all(h),before)
})
for(const phase of [1,2,3])test(`discard network failure at request ${phase} preserves state and sanitizes errors`,async()=>{
  const h=await fixture();h.options.get=async(_,n)=>{if(n===phase)throw new Error('Bearer private credential')};const before=all(h),r=await h.resolver.review(ID)
  const out=phase===1?r:await h.resolver.resolve(r.reviewId,FINISH,true,h.file);assert.equal(phase===1?out.ready:out.applied,false);assert.equal(all(h),before);assert.equal(JSON.stringify(out).includes('credential'),false)
})
for(const key of ['scheduleConflictArchive','scheduleConflicts','pendingPurges','conflicts','scheduleConversions'])test(`discard malformed ${key} does not reach cloud or erase metadata`,async()=>{
  const h=await fixture();await h.db.meta.put({key,value:'keep broken metadata'});const before=all(h)
  assert.equal((await h.resolver.review(ID)).ready,false);assert.equal(h.calls.length,0);assert.equal(all(h),before)
})
test('discard cancellation during file write keeps busy until the outstanding write settles',async()=>{
  const h=await fixture(),r=await h.resolver.review(ID);let release,opened
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>opened=resolve)
  h.options.write=async()=>{opened();await gate};const out=h.resolver.resolve(r.reviewId,FINISH,true,h.file);await started;h.resolver.cancel()
  assert.equal((await h.resolver.review(ID)).reason,'busy');assert.equal((await h.resolver.resolve(r.reviewId,FINISH,true,h.file)).reason,'busy')
  release();assert.equal((await out).applied,false);assert.equal((await h.db.meta.get('scheduleConversions')).value.length,1)
})
