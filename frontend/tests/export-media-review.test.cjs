// Production image-review pipeline; actual public image bytes, injected decoder.
// Not real browser decoding, IndexedDB, private images or memory capacity evidence.
const {test}=require('node:test'),assert=require('node:assert/strict')
const {reviewExportImages}=require('../src/shared/exportMediaReview.ts')
const {SerialImageDecoder}=require('../src/shared/exportImageResources.ts')
const {ExportSnapshotError}=require('../src/shared/exportSnapshot.ts')
const fixtures=import('../tools/print-lab/resource-fixtures.mjs')
const next=()=>new Promise(setImmediate),code=c=>({code:c})
function options(extra={}){const closed=[],o={assertCurrent:async()=>{},decoder:new SerialImageDecoder(),decode:async()=>({width:512,height:768,close(){closed.push(true)}}),...extra};return {o,closed}}
test('all headers checked before any decode; a bad header becomes named issue, good image retained',async()=>{
 const {fixtureBlob}=await fixtures,good=fixtureBlob('png'),bad=new Blob(['bad'],{type:'image/png'});let reads=0,decode=0
 for(const b of[good,bad]){const read=b.arrayBuffer.bind(b);b.arrayBuffer=async()=>{reads++;return read()}}
 const {o,closed}=options();const original=o.decode;o.decode=async b=>{assert.equal(reads,2);decode++;return original(b)}
 const r=await reviewExportImages([{id:'good',blob:good},{id:'bad',blob:bad}],o);assert.equal(decode,1);assert.equal(closed.length,1);assert.equal(r.images.items[0].id,'good');assert.deepEqual(r.issues,[{resourceId:'bad',code:'INVALID_IMAGE_HEADER'}]);assert.equal(r.images.bytes,good.size+bad.size)
})
test('native failure is explicit, next image decoded normally; no bitmap leak or automatic retry',async()=>{
 const {fixtureBlob}=await fixtures,b=fixtureBlob('png');let attempts=0;const {o,closed}=options();const original=o.decode;o.decode=async blob=>{if(++attempts===1)throw Error('native rejection');return original(blob)}
 const r=await reviewExportImages([{id:'bad',blob:b},{id:'good',blob:b}],o);assert.equal(attempts,2);assert.equal(r.issues[0].code,'IMAGE_DECODE_FAILED');assert.equal(r.images.items[0].id,'good');assert.equal(closed.length,1);assert.equal(o.decoder.busy,false)
})
test('animation, unsupported type and oversized individual pixels yield placeholders without decoding',async()=>{
 const {fixtureBlob}=await fixtures,png=new Uint8Array(await fixtureBlob('png').arrayBuffer());new DataView(png.buffer).setUint32(16,9000)
 const {o}=options({decode:async()=>assert.fail('should not decode')});const records=[{id:'apng',blob:fixtureBlob('apng')},{id:'svg',blob:new Blob(['<svg/>'],{type:'image/svg+xml'})},{id:'huge',blob:new Blob([png],{type:'image/png'})}]
 const r=await reviewExportImages(records,o);assert.deepEqual(r.issues.map(i=>i.code),['ANIMATED_IMAGE_UNSUPPORTED','UNSUPPORTED_IMAGE_TYPE','IMAGE_DIMENSION_LIMIT']);assert.equal(r.images.items.length,0)
})
test('cumulative24MP budget stops whole job BEFORE any decode; not downgradable',async()=>{
 const {fixtureBlob}=await fixtures,b=fixtureBlob('large'),{o}=options({decode:async()=>assert.fail('decode before all budgets passed')});await assert.rejects(reviewExportImages(Array.from({length:4},(_,i)=>({id:String(i),blob:b})),o),code('TOTAL_PIXEL_LIMIT'))
})
test('bytes/count budgets stop before header reads, including images that would become placeholders',async()=>{
 const b=new Blob([new Uint8Array(12*1024**2)],{type:'image/png'});b.arrayBuffer=async()=>assert.fail('header read over global byte budget');const {o}=options();await assert.rejects(reviewExportImages(Array.from({length:6},(_,i)=>({id:String(i),blob:b})),o),code('MEDIA_BYTE_LIMIT'));await assert.rejects(reviewExportImages(Array.from({length:101},(_,i)=>({id:String(i),blob:new Blob(['x'],{type:'image/png'})})),o),code('IMAGE_COUNT_LIMIT'))
})
test('same ID deduped, conflicting bytes rejected; IDs/Blobs detached before first await',async()=>{
 const {fixtureBlob}=await fixtures,b=fixtureBlob('png'),record={id:'old',blob:b},{o}=options();o.assertCurrent=async()=>{record.id='new';record.blob=new Blob(['bad'])};const r=await reviewExportImages([record,{id:'old',blob:b}],o);assert.equal(r.images.items.length,1);assert.equal(r.images.items[0].id,'old');await assert.rejects(reviewExportImages([{id:'x',blob:b},{id:'x',blob:new Blob(['x'])}],options().o),code('AMBIGUOUS_IMAGE_REFERENCE'))
})
test('abort or identity failure is not misclassified as an image problem',async()=>{
 const {fixtureBlob}=await fixtures,b=fixtureBlob('png'),c=new AbortController();c.abort();await assert.rejects(reviewExportImages([{id:'x',blob:b}],options({signal:c.signal}).o),code('CANCELLED'))
 let n=0;await assert.rejects(reviewExportImages([{id:'x',blob:b}],options({assertCurrent:async()=>{if(++n===3)throw new ExportSnapshotError('EXPORT_CONTEXT_EXPIRED')}}).o),code('EXPORT_CONTEXT_EXPIRED'))
})
test('Blob allocation/read errors stop, never return a confirmed or partial review',async()=>{
 const {fixtureBlob}=await fixtures,b=fixtureBlob('png');b.arrayBuffer=async()=>{throw Error('allocation/read failure')};await assert.rejects(reviewExportImages([{id:'x',blob:b}],options().o),/allocation\/read failure/)
})
test('native timeout retains slot and disposes late bitmap; timeout is not a placeholder',async()=>{
 const {fixtureBlob}=await fixtures,b=fixtureBlob('png');let release,time=0,closed=0
 // Use a shared queue already blocked by another real pending native abstraction.
 const {preflightImages}=require('../src/shared/exportImageResources.ts'),plan=await preflightImages([{id:'x',blob:b}]),q=new SerialImageDecoder()
 const pending=q.run(plan,{timeoutMs:10,decode:()=>new Promise(r=>release=r)});await assert.rejects(pending,code('DECODE_TIMEOUT'));assert(q.busy)
 await assert.rejects(reviewExportImages([{id:'x',blob:b}],options({decoder:q}).o),code('DECODER_BUSY'))
 release({width:512,height:768,close(){closed++}});await next();assert.equal(closed,1);assert.equal(q.busy,false)
 // Separate stage-clock rejection occurs before handing bytes to a decoder.
 const {o}=options({now:()=>{time+=21000;return time}});await assert.rejects(reviewExportImages([{id:'x',blob:b}],o),code('MEDIA_PREFLIGHT_TIMEOUT'))
})
test('header work cap stops whole stage; unsupported chunk storms cannot become tolerated placeholders',async()=>{
 const {fixtureBlob}=await fixtures,first=new Uint8Array(await fixtureBlob('png').arrayBuffer()).slice(0,33),chunk=new Uint8Array(12);chunk.set(new TextEncoder().encode('tEXt'),4)
 const end=new Uint8Array(12);end.set(new TextEncoder().encode('IEND'),4);const b=new Blob([first,...Array(2050).fill(chunk),end],{type:'image/png'})
 await assert.rejects(reviewExportImages([{id:'storm',blob:b}],options().o),code('IMAGE_HEADER_WORK_LIMIT'))
})
test('actual dimensions mismatch is closed and diagnosed; pixel accounting includes rejected decodes',async()=>{
 const {fixtureBlob}=await fixtures,b=fixtureBlob('png');let closed=0;const {o}=options({decode:async()=>({width:513,height:768,close(){closed++}})})
 const r=await reviewExportImages([{id:'x',blob:b}],o);assert.equal(r.images.items.length,0);assert.equal(r.images.pixels,512*768);assert.equal(r.issues[0].code,'DECODE_DIMENSION_MISMATCH');assert.equal(closed,1)
})
