// Deterministic reactive/IO doubles: tests real useEntryList, not a real Vue mount or IndexedDB.
const {test}=require('node:test'),assert=require('node:assert/strict'),{registerHooks}=require('node:module')
const refs=[], watchers=[], disposers=[],timers=new Map();let timerId=0,listImpl
const fake={
 ref(initial){const r={_value:initial};Object.defineProperty(r,'value',{get(){return r._value},set(v){if(v===r._value)return;r._value=v;for(const w of [...watchers])if(w.refs.includes(r))w.cb(v)}});refs.push(r);return r},
 computed(fn){return {get value(){return fn()}}},
 watch(source,cb){const w={refs:Array.isArray(source)?source:[source],cb};watchers.push(w);return()=>watchers.splice(watchers.indexOf(w),1)},
 onScopeDispose(fn){disposers.push(fn)},
 repo:{list:o=>listImpl(o)}
}
globalThis.__notebookListDouble=fake
global.window={setTimeout(fn){const id=++timerId;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)}}
registerHooks({resolve(specifier,ctx,next){
 if(specifier==='vue' && ctx.parentURL?.endsWith('/useEntryList.ts'))return{url:'data:text/javascript,export const {ref,computed,watch,onScopeDispose}=globalThis.__notebookListDouble',shortCircuit:true}
 if(specifier==='@/repo' && ctx.parentURL?.endsWith('/useEntryList.ts'))return{url:'data:text/javascript,export const entryRepo=globalThis.__notebookListDouble.repo',shortCircuit:true}
 return next(specifier,ctx)
}})
const {useEntryList}=require('../src/composables/useEntryList.ts')
const wait=()=>new Promise(setImmediate),page=(ids,total=ids.length,p=1)=>({items:ids.map(id=>({id})),total,page:p})
function reset(){for(const d of disposers.splice(0))d();watchers.length=0;refs.length=0;timers.clear()}
test('filter changes immediately clear body IDs and invalidate late reads before debounce',async()=>{
 reset();let done;listImpl=()=>new Promise(r=>done=r);const c=useEntryList();const p=c.reload();c.keyword.value='新';assert.deepEqual(c.items.value,[]);assert(c.loading.value);assert.equal(c.revision.value,1);done(page(['old']));await p;assert.deepEqual(c.items.value,[]);listImpl=async o=>page([o.keyword]);for(const fn of [...timers.values()])fn();timers.clear();await wait();assert.equal(c.items.value[0].id,'新')
})
test('all filters and sorting use one repo list query, page20 and AND tag selection unchanged',async()=>{
 reset();let last;listImpl=async o=>{last=o;return page(['a'],23)};const c=useEntryList();c.keyword.value='雨';c.order.value='entryDateAsc';c.tagIds.value=['x','y','x'];c.dateFrom.value='2026-01-01';c.dateTo.value='2026-12-31';c.hasImage.value=true;await c.reload();assert.equal(last.pageSize,20);assert.deepEqual(last.tagIds,['x','y']);assert.equal(last.keyword,'雨');assert.equal(last.order,'entryDateAsc');assert.equal(last.hasImage,true);assert.equal(c.total.value,23)
})
test('page2 appends unique IDs and propagates a visible failure without unhandled rejection',async()=>{
 reset();listImpl=async()=>page(['a'],25);const c=useEntryList();await c.reload();listImpl=async()=>page(['a','b'],25,2);await c.loadMore();assert.deepEqual(c.items.value.map(x=>x.id),['a','b']);listImpl=async()=>{throw Error('disk failed')};await c.loadMore();assert.equal(c.queryError.value,'disk failed');assert(!c.loading.value);assert.equal(c.page.value,2)
})
test('first-page failure clears stale rows, retry recovers, invalid dates do not query',async()=>{
 reset();let calls=0;listImpl=async()=>{calls++;return page(['a'])};const c=useEntryList();await c.reload();listImpl=async()=>{throw Error('failed')};await c.reload();assert.deepEqual(c.items.value,[]);assert.equal(c.queryError.value,'failed');listImpl=async()=>page(['b']);await c.reload();assert.equal(c.queryError.value,'');assert.equal(c.items.value[0].id,'b');c.dateFrom.value='2026-12-01';c.dateTo.value='2026-01-01';assert(c.filterError.value);assert.deepEqual(c.items.value,[]);assert.equal(calls,1)
})
test('dispose cancels pending debounce and late publication',async()=>{
 reset();let done;listImpl=()=>new Promise(r=>done=r);const c=useEntryList();const p=c.reload();c.keyword.value='changed';for(const d of disposers.splice(0))d();assert.equal(timers.size,0);done(page(['late']));await p;assert.deepEqual(c.items.value,[]);reset()
})
