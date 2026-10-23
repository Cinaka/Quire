const {test}=require('node:test'),assert=require('node:assert/strict')
const {SerialImageDecoder,preflightImages,selectExportImagePlan}=require('../src/shared/exportImageResources.ts'),fixtures=import('../tools/print-lab/resource-fixtures.mjs'),code=c=>e=>e.code===c,immediate=()=>new Promise(setImmediate)
async function plan(){return preflightImages([{id:'m',blob:(await fixtures).fixtureBlob('png')}])}
test('DOM image and bitmap explicitly requested native decodes use same slot',async()=>{
 const p=await plan(),q=new SerialImageDecoder();let resume;const work=q.verifyDomImage(p,{load:()=>new Promise(r=>resume=r),discard(){},assertCurrent:async()=>{}});await immediate();assert(q.busy);await assert.rejects(q.run(p),code('DECODER_BUSY'));resume({width:512,height:768});await work;assert(!q.busy)
})
test('bitmap slot also rejects DOM request without invoking load',async()=>{
 const p=await plan(),q=new SerialImageDecoder();let resume,calls=0;const work=q.run(p,{decode:()=>new Promise(r=>resume=r)});await immediate();await assert.rejects(q.verifyDomImage(p,{load:async()=>{calls++;return{width:512,height:768}},discard(){},assertCurrent:async()=>{}}),code('DECODER_BUSY'));assert.equal(calls,0);resume({width:512,height:768,close(){}});await work
})
test('DOM cancellation holds native slot until late settlement, discard idempotent cleanup hook',async()=>{
 const p=await plan(),q=new SerialImageDecoder(),c=new AbortController();let resume,discard=0;const work=q.verifyDomImage(p,{signal:c.signal,load:()=>new Promise(r=>resume=r),discard(){discard++},assertCurrent:async()=>{}});await immediate();c.abort();await assert.rejects(work,code('CANCELLED'));assert(q.busy);assert.equal(discard,1);resume({width:512,height:768});await immediate();assert(!q.busy);assert.equal(discard,2)
})
test('DOM timeout, invalid dimensions, native failure and final identity failure do not pass',async()=>{
 const p=await plan();for(const kind of ['dimensions','native','identity']){const q=new SerialImageDecoder();let discards=0,n=0;await assert.rejects(q.verifyDomImage(p,{load:async()=>{if(kind==='native')throw Error('native');return{width:kind==='dimensions'?1:512,height:768}},discard(){discards++},assertCurrent:async()=>{if(kind==='identity'&&++n===2)throw Object.assign(Error('OWNER_CHANGED'),{code:'OWNER_CHANGED'})}}));assert(discards>0);assert(!q.busy)}
 const q=new SerialImageDecoder();let resume;await assert.rejects(q.verifyDomImage(p,{load:()=>new Promise(r=>resume=r),discard(){},assertCurrent:async()=>{},timeoutMs:10}),code('DECODE_TIMEOUT'));assert(q.busy);resume({width:512,height:768});await immediate();assert(!q.busy)
})
test('single image plan must derive from branded aggregate, no forged plan or unknown ID',async()=>{
 const p=await plan(),selected=selectExportImagePlan(p,'m');assert.equal(selected.items[0],p.items[0]);assert.equal(selected.pixels,p.pixels);assert(Object.isFrozen(selected.items));assert.throws(()=>selectExportImagePlan({...p},'m'),code('UNVERIFIED_IMAGE_PLAN'));assert.throws(()=>selectExportImagePlan(p,'other'),code('EXPORT_LAYOUT_IMAGE_MISSING'))
 const q=new SerialImageDecoder();await assert.rejects(q.verifyDomImage({...selected},{load:async()=>({width:512,height:768}),discard(){},assertCurrent:async()=>{}}),code('UNVERIFIED_IMAGE_PLAN'))
})
