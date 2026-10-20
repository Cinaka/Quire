const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path')
const {ID,OTHER_ID,AT,content,schedule,terminal,entry,intent,setup}=require('./schedules-data-harness.cjs')
const SERVER='2026-10-08T10:00:02.000Z', ARCHIVE='scheduleConflictArchive'
const all=h=>JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v])=>[k,[...v.rows.values()]])))
function wireSource(r){return {id:r.id,remind_date:r.remindDate,title:r.title,content:r.content,content_text:r.contentText,status:r.status,
  converted_entry_id:r.convertedEntryId,converted_at:r.convertedAt,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
function wireEntry(r){return {id:r.id,from_schedule_id:r.fromScheduleId,entry_date:r.entryDate,sort_order:r.sortOrder,title:r.title,content:r.content,
  content_text:r.contentText,mood:r.mood,weather:r.weather,tag_ids:r.tagIds,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER}}
async function fixture(){
  const h=setup();h.mocks['@/api/tokenStore']=h.tokens
  const source=terminal({title:'本机首次来源'}),diary=entry({title:'本机后来日记'}),first=intent({ownerUserId:'account-a'})
  const remote=terminal({title:'另一设备来源',isDeleted:1,deletedAt:AT,dirty:0,serverUpdatedAt:SERVER,updatedAt:SERVER})
  const remoteDiary=entry({title:'云端当前日记',dirty:0,serverUpdatedAt:SERVER,updatedAt:SERVER})
  const reply={read_only:true,reviewable:true,reason:'terminal_review',receipt_known:true,first_entry_date:'2026-10-07',first_entry_deleted:false,
    schedule:wireSource(remote),entry:wireEntry(remoteDiary),entry_state:'active'}
  await h.db.meta.put({key:'ownerUserId',value:'account-a'});await h.db.meta.put({key:'ownerGeneration',value:'epoch'})
  await h.db.schedules.put(source);await h.db.entries.put(diary);await h.db.meta.put({key:'scheduleConversions',value:[first]})
  const candidates=[{scheduleId:ID,kind:'conversion-ack',reason:'source_deleted',firstIntent:first,serverSchedule:remote,serverEntry:remoteDiary},
    {scheduleId:OTHER_ID,kind:'other-keep'}]
  await h.db.meta.put({key:'scheduleConflicts',value:candidates})
  const calls=[],options={}
  const transport={async review(id,lease){calls.push({id,lease:structuredClone(lease)});if(options.get)await options.get(h,calls.length);return reply}}
  const repo=h.load('db/scheduleTerminalConflictRepo.ts'),resolver=repo.createInternalScheduleSourceTombstoneResolver(transport)
  let bytes='',writes=0,closes=0,aborts=0
  const file={async getFile(){if(options.getFile)await options.getFile(h);return {size:new Blob([bytes]).size,async text(){return options.readbackBad?'{}':bytes}}},
    async createWritable(o){assert.equal(JSON.stringify(o),JSON.stringify({keepExistingData:false,mode:'exclusive'}));if(options.open)await options.open(h)
      return {async write(text){writes++;if(options.write)await options.write(h);bytes=text},async close(){closes++;if(options.close)await options.close(h)},async abort(){aborts++}}}}
  return Object.assign(h,{source,diary,first,remote,remoteDiary,reply,candidates,calls,options,resolver,transport,repo,file,
    bytes:()=>bytes,setBytes:value=>bytes=value,stats:()=>({writes,closes,aborts})})
}
test('source tombstone construction and review are inert/read-only until separate file confirmation',async()=>{
  const h=await fixture(),before=all(h);assert.equal(h.calls.length,0)
  const r=await h.resolver.review(ID);assert.equal(r.sourceDeletionEnabled,true);assert.equal(r.localIntentStatus,'retained_not_confirmed')
  assert.equal(r.cloudSynced,false);assert.equal(all(h),before);assert.equal(h.stats().writes,0)
})
for(const state of ['active','local-deleted','cloud-deleted','both-deleted'])test(`source-only ${state} preserves diary bytes and original intent/candidates`,async()=>{
  const h=await fixture()
  if(['local-deleted','both-deleted'].includes(state))await h.db.entries.put({...h.diary,isDeleted:1,deletedAt:AT})
  if(['cloud-deleted','both-deleted'].includes(state)){h.reply.entry.deleted_at=AT;h.reply.entry_state='deleted'}
  const diary=JSON.stringify(await h.db.entries.get(ID)),queue=JSON.stringify((await h.db.meta.get('scheduleConversions')).value),candidates=JSON.stringify((await h.db.meta.get('scheduleConflicts')).value)
  await h.db.meta.put({key:'lastSyncAt',value:'P2 untouched'});await h.db.meta.put({key:'scheduleLastSyncAt',value:'P4 untouched'})
  const r=await h.resolver.review(ID);assert.equal(r.sourceDeletionEnabled,true)
  const out=await h.resolver.resolve(r.reviewId,true,h.file);assert.equal(out.applied,true);assert.equal(out.diaryChanged,false);assert.equal(out.cloudSynced,false)
  assert.equal(JSON.stringify(await h.db.entries.get(ID)),diary);assert.equal(h.stores.entries.rows.size,1)
  assert.equal(JSON.stringify((await h.db.meta.get('scheduleConversions')).value),queue);assert.equal(JSON.stringify((await h.db.meta.get('scheduleConflicts')).value),candidates)
  const source=await h.db.schedules.get(ID);assert.equal(source.isDeleted,1);assert.equal(source.convertedEntryId,ID);assert.equal(source.dirty,0)
  assert.equal((await h.db.meta.get('lastSyncAt')).value,'P2 untouched');assert.equal((await h.db.meta.get('scheduleLastSyncAt')).value,'P4 untouched')
  const archive=(await h.db.meta.get(ARCHIVE)).value;assert.equal(archive.length,1);assert.equal(archive[0].kind,'terminal-source-tombstone')
  const codec=h.load('shared/scheduleConflictEvidenceFile.ts'),evidence=codec.parseConflictEvidenceFile(h.bytes())
  assert.equal(evidence.format,'terminal-source-tombstone-evidence');assert.equal(evidence.meaning,'source_only_not_diary_or_intent_confirmation')
  assert.equal(evidence.localSource.isDeleted,0);assert.equal(evidence.cloudReview.schedule.isDeleted,1)
  assert.equal(evidence.intentions[0].entry.title,h.first.entry.title)
  for(const key of ['ownerUserId','tokenGeneration','generation','Bearer'])assert.equal(h.bytes().includes(key),false)
  assert.equal((await h.load('db/scheduleStateRepo.ts').protectedConversions()).entryIds.has(ID),true)
  assert.deepEqual(h.stats(),{writes:1,closes:1,aborts:0});assert.equal(h.calls.length,3)
  assert.equal((await h.resolver.resolve(r.reviewId,true,h.file)).applied,false)
})
for(const mode of ['no-confirm','truthy-confirm','no-file','stale-review'])test(`source deletion rejects ${mode} before file/network side effects`,async()=>{
  const h=await fixture(),r=await h.resolver.review(ID),before=all(h)
  const out=await h.resolver.resolve(mode==='stale-review'?r.reviewId+1:r.reviewId,mode==='no-confirm'?false:mode==='truthy-confirm'?'yes':true,mode==='no-file'?undefined:h.file)
  assert.equal(out.applied,false);assert.equal(h.calls.length,1);assert.equal(h.stats().writes,0);assert.equal(all(h),before)
})
for(const mode of ['local-source-deleted','cloud-source-active','both-source-deleted','purged','missing-local','unknown-receipt','no-intent','pending-purge','p2-conflict','draft','unknown-candidate','local-tag','cloud-tag','media','pending-source'])test(`source deletion ${mode} stays protected and cannot recreate/restore diaries`,async()=>{
  const h=await fixture()
  if(['local-source-deleted','both-source-deleted'].includes(mode))await h.db.schedules.put({...h.source,isDeleted:1,deletedAt:AT})
  if(['local-source-deleted','cloud-source-active'].includes(mode))h.reply.schedule.deleted_at=null
  if(mode==='purged'){h.reply.entry=null;h.reply.entry_state='purged'}
  if(mode==='missing-local')await h.db.entries.delete(ID)
  if(mode==='unknown-receipt'){h.reply.receipt_known=false;h.reply.reviewable=false;h.reply.reason='receipt_unknown';h.reply.first_entry_date=null;h.reply.first_entry_deleted=null}
  if(mode==='no-intent')await h.db.meta.put({key:'scheduleConversions',value:[]})
  if(mode==='pending-purge')await h.db.meta.put({key:'pendingPurges',value:[ID]})
  if(mode==='p2-conflict')await h.db.meta.put({key:'conflicts',value:[{entryId:ID,local:h.diary}]})
  if(mode==='draft')await h.db.meta.put({key:'draft',value:{text:'unsaved'}})
  if(mode==='unknown-candidate')await h.db.meta.put({key:'scheduleConflicts',value:[{scheduleId:ID,kind:'future'}]})
  if(mode==='local-tag')await h.db.entries.put({...h.diary,tagIds:[OTHER_ID]})
  if(mode==='cloud-tag')h.reply.entry.tag_ids=[OTHER_ID]
  if(mode==='media')await h.db.media.put({id:OTHER_ID,entryId:ID,blob:new Blob(['keep'])})
  if(mode==='pending-source')await h.db.schedules.put(schedule())
  const before=all(h),r=await h.resolver.review(ID);assert.equal(r.sourceDeletionEnabled,false)
  assert.equal((await h.resolver.resolve(r.reviewId,true,h.file)).applied,false);assert.equal(h.stats().writes,0);assert.equal(all(h),before)
})
for(const mode of ['nonempty','close-fail','bad-readback','account','relogin','epoch','edit','candidate','purge','cancel','cloud-change'])test(`source evidence boundary ${mode} never commits stale source acceptance`,async()=>{
  const h=await fixture(),r=await h.resolver.review(ID)
  if(mode==='nonempty')h.setBytes('existing evidence')
  if(mode==='bad-readback')h.options.readbackBad=true
  let after
  h.options.close=async()=>{
    if(mode==='close-fail')throw new Error('private failure')
    if(mode==='account')h.user('account-b')
    if(mode==='relogin'){h.user('account-b');h.user('account-a')}
    if(mode==='epoch')await h.db.meta.put({key:'ownerGeneration',value:'restored'})
    if(mode==='edit')await h.db.entries.put({...h.diary,title:'keep concurrent edit'})
    if(mode==='candidate')await h.db.meta.put({key:'scheduleConflicts',value:[...h.candidates,{scheduleId:ID,kind:'future'}]})
    if(mode==='purge')await h.db.meta.put({key:'pendingPurges',value:[ID]})
    if(mode==='cancel')h.resolver.cancel()
    if(mode==='cloud-change')h.reply.schedule.title='new cloud'
    after=all(h)
  }
  const before=all(h),out=await h.resolver.resolve(r.reviewId,true,h.file);assert.equal(out.applied,false)
  assert.equal(all(h),after??before);assert.equal((await h.db.schedules.get(ID)).isDeleted,0);assert.equal(await h.db.meta.get(ARCHIVE),undefined)
})
for(const mode of ['account','relogin','epoch','source'])test(`source session pins first context across ${mode} review`,async()=>{
  const h=await fixture();assert.equal((await h.resolver.review(ID)).sourceDeletionEnabled,true)
  if(mode==='account')h.user('account-b')
  if(mode==='relogin'){h.user('account-b');h.user('account-a')}
  if(mode==='epoch')await h.db.meta.put({key:'ownerGeneration',value:'restored'})
  const out=await h.resolver.review(mode==='source'?OTHER_ID:ID);assert.equal(out.ready,false);assert.equal(h.calls.length,1)
})
for(const table of ['meta','schedules'])test(`source-only ${table} transaction failure rolls back archive, baseline and source`,async()=>{
  const h=await fixture(),r=await h.resolver.review(ID),before=all(h);h.options.close=async()=>h.failNext(table)
  assert.equal((await h.resolver.resolve(r.reviewId,true,h.file)).applied,false);assert.equal(all(h),before)
})
test('two independent source resolvers converge to one source-only archive without consuming the intent',async()=>{
  const h=await fixture(),other=h.repo.createInternalScheduleSourceTombstoneResolver(h.transport)
  const a=await h.resolver.review(ID),b=await other.review(ID)
  assert.equal((await h.resolver.resolve(a.reviewId,true,h.file)).applied,true)
  const before=all(h);assert.equal((await other.resolve(b.reviewId,true,h.file)).applied,false);assert.equal(all(h),before)
  assert.equal((await h.db.meta.get(ARCHIVE)).value.length,1)
})
test('source-only acceptance leaves diary choice as a second independent explicit operation',async()=>{
  const h=await fixture(),resolver=h.repo.createInternalScheduleTerminalConflictResolver(h.transport)
  assert.equal((await resolver.review(ID)).choices.length,0)
  const r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,true,h.file)).applied,true)
  const review=await resolver.review(ID);assert.equal(review.choices.length,2)
  assert.equal((await h.load('db/scheduleStateRepo.ts').protectedConversions()).entryIds.has(ID),true)
  const exported=[];assert.equal((await resolver.resolve(review.reviewId,'cloud-source-keep-diary',true,async value=>exported.push(value))).applied,true)
  assert.equal(exported.length,1);assert.equal((await h.db.schedules.get(ID)).isDeleted,1)
  assert.equal((await h.db.entries.get(ID)).title,h.diary.title);assert.equal((await h.db.entries.get(ID)).dirty,1)
  assert.equal((await h.db.meta.get('scheduleConversions')).value.length,0);assert.equal((await h.db.meta.get(ARCHIVE)).value.length,2)
})
for(const field of ['format','meaning','choice','unknown','receipt','deletion'])test(`tombstone evidence rejects ${field} laundering and keeps original fields`,async()=>{
  const h=await fixture(),r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,true,h.file)).applied,true)
  const codec=h.load('shared/scheduleConflictEvidenceFile.ts'),e=JSON.parse(h.bytes())
  assert.equal(codec.serializeConflictEvidenceFile(e),h.bytes())
  if(field==='format')e.format='terminal-text-conflict-evidence'
  if(field==='meaning')e.meaning='explicit_choice_not_first_intent_confirmation'
  if(field==='choice')e.choice='cloud-source-use-diary'
  if(field==='unknown')e.privateToken='never export'
  if(field==='receipt')e.cloudReview.receiptKnown=false
  if(field==='deletion'){e.cloudReview.schedule.isDeleted=0;e.cloudReview.schedule.deletedAt=null}
  assert.throws(()=>codec.parseConflictEvidenceFile(JSON.stringify(e)))
})
test('source path remains internal with no formal mount, network writes, purge or queue removal',()=>{
  for(const file of ['repo/index.ts','router/index.ts','api/sync.ts','db/scheduleSyncRepo.ts'])assert.equal(fs.readFileSync(path.join(__dirname,'../src',file),'utf8').includes('createInternalScheduleSourceTombstoneResolver'),false)
  const text=fs.readFileSync(path.join(__dirname,'../src/shared/scheduleSourceTombstone.ts'),'utf8');assert.equal(text.includes('.post('),false)
})
for(const phase of [1,2,3])test(`source read-only request ${phase} network failure cannot mutate or expose raw errors`,async()=>{
  const h=await fixture();h.options.get=async(_,n)=>{if(n===phase)throw new Error('Bearer private credentials')}
  const before=all(h),r=await h.resolver.review(ID)
  const out=phase===1?r:await h.resolver.resolve(r.reviewId,true,h.file)
  assert.equal(phase===1?out.ready:out.applied,false);assert.equal(JSON.stringify(out).includes('private credentials'),false);assert.equal(all(h),before)
})
for(const phase of [1,2,3])test(`source request ${phase} cancellation suppresses late apply and stale review`,async()=>{
  const h=await fixture();h.options.get=async(_,n)=>{if(n===phase)h.resolver.cancel()}
  const before=all(h),r=await h.resolver.review(ID),out=phase===1?r:await h.resolver.resolve(r.reviewId,true,h.file)
  assert.equal(phase===1?out.ready:out.applied,false);assert.equal(all(h),before)
})
for(const phase of ['archive','baseline','source'])test(`source cancellation after ${phase} write rolls back the whole transaction`,async()=>{
  const h=await fixture(),r=await h.resolver.review(ID),before=all(h)
  const store=phase==='source'?h.db.schedules:h.db.meta,put=store.put;let fired=false
  store.put=async row=>{const out=await put(row)
    if(!fired && (phase==='source' || phase==='archive' && row.key===ARCHIVE || phase==='baseline' && row.key===`scheduleServerState:${ID}`)) {fired=true;h.resolver.cancel()}
    return out}
  assert.equal((await h.resolver.resolve(r.reviewId,true,h.file)).applied,false);assert.equal(fired,true);assert.equal(all(h),before)
})
for(const mode of ['newer-source','newer-baseline','same-watermark-contradiction'])test(`source ${mode} never overwrites a known cloud proof`,async()=>{
  const h=await fixture()
  if(mode==='newer-source')await h.db.schedules.put({...h.source,serverUpdatedAt:'2026-10-08T10:00:03.000Z'})
  else {const remote=structuredClone(h.remote)
    if(mode==='newer-baseline')remote.updatedAt=remote.serverUpdatedAt='2026-10-08T10:00:03.000Z';else remote.title='conflicting same watermark'
    await h.db.meta.put({key:`scheduleServerState:${ID}`,value:{ownerUserId:'account-a',generation:'epoch',source:remote}})}
  const before=all(h),r=await h.resolver.review(ID);assert.equal((await h.resolver.resolve(r.reviewId,true,h.file)).applied,false);assert.equal(all(h),before)
})
test('source operation stays single-flight after cancellation until an already opened file settles',async()=>{
  const h=await fixture(),r=await h.resolver.review(ID);let release,opened
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>opened=resolve)
  h.options.write=async()=>{opened();await gate}
  const out=h.resolver.resolve(r.reviewId,true,h.file);await started;h.resolver.cancel()
  assert.equal((await h.resolver.review(ID)).reason,'busy');assert.equal((await h.resolver.resolve(r.reviewId,true,h.file)).reason,'busy')
  release();assert.equal((await out).applied,false);assert.equal((await h.db.schedules.get(ID)).isDeleted,0)
  assert.equal((await h.resolver.review(ID)).sourceDeletionEnabled,true)
})
for(const key of ['scheduleConflictArchive','scheduleConflicts','pendingPurges','conflicts','scheduleConversions'])test(`source malformed ${key} is not erased or treated as empty`,async()=>{
  const h=await fixture();await h.db.meta.put({key,value:'keep broken metadata'});const before=all(h)
  assert.equal((await h.resolver.review(ID)).ready,false);assert.equal(h.calls.length,0);assert.equal(all(h),before)
})
test('source acceptance refuses foreign or duplicated conversion intentions before cloud access',async()=>{
  for(const mode of ['foreign','duplicate']){const h=await fixture();await h.db.meta.put({key:'scheduleConversions',value:mode==='foreign'?[{...h.first,ownerUserId:'account-b'}]:[h.first,h.first]})
    const before=all(h);assert.equal((await h.resolver.review(ID)).ready,false);assert.equal(h.calls.length,0);assert.equal(all(h),before)}
})
