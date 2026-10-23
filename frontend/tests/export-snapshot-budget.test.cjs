const {test}=require('node:test'),assert=require('node:assert/strict')
const {createExportJsonMeter:meter,freezeExportValue,EXPORT_SNAPSHOT_LIMITS:L}=require('../src/shared/exportSnapshot.ts')
const code=c=>e=>e.code===c
for(const value of [null,true,false,0,-0,-2.3,1e25,'青简 🌿\n\t"\\\u0001\ud800\udc00\ud800X\udc00',{a:['雨',1,false],b:{}},[],Object.assign(Object.create(null),{文:'本'})]){
 test(`UTF8 JSON byte accounting ${JSON.stringify(value)}`,()=>{const m=meter(10000,1000,()=>{});m.measure(value);assert.equal(m.counts().bytes,Buffer.byteLength(JSON.stringify(value)))})
}
test('cumulative meter exact byte limit and plus-one rejection',()=>{const m=meter(8,10,()=>{});m.measure('青');m.measure('x');assert.equal(m.counts().bytes,8);assert.throws(()=>m.measure(null),code('EXPORT_JSON_BYTE_LIMIT'))})
test('real 4MiB boundary, no giant serialization copy in meter',()=>{const s='a'.repeat(L.bodyBytes-2),m=meter(L.bodyBytes,L.bodyNodes,()=>{});m.measure(s);assert.equal(m.counts().bytes,L.bodyBytes);assert.throws(()=>meter(L.bodyBytes,L.bodyNodes,()=>{}).measure(s+'a'),code('EXPORT_JSON_BYTE_LIMIT'))})
test('nodes boundary counts JSON values, not object keys',()=>{const m=meter(100000,20000,()=>{});m.measure(Array(19999).fill(null));assert.equal(m.counts().nodes,20000);assert.throws(()=>meter(100000,20000,()=>{}).measure(Array(20000).fill(null)),code('EXPORT_JSON_NODE_LIMIT'))})
test('depth64 accepts;65 rejects',()=>{let v=null;for(let i=0;i<64;i++)v=[v];meter(1000,1000,()=>{}).measure(v);assert.throws(()=>meter(1000,1000,()=>{}).measure([v]),code('EXPORT_JSON_DEPTH_LIMIT'))})
for(const value of [undefined,NaN,Infinity,()=>{},1n,new Date(),new Blob(['x']),Array(1)])test(`malformed JSON rejects ${typeof value}`,()=>assert.throws(()=>meter(1000,1000,()=>{}).measure(value),code('EXPORT_JSON_UNSUPPORTED')))
test('cycle rejects but shared non-cycle values account twice',()=>{const v={};v.x=v;assert.throws(()=>meter(1000,100,()=>{}).measure(v),code('EXPORT_JSON_CYCLE'));const x={a:1},m=meter(100,100,()=>{});m.measure([x,x]);assert.equal(m.counts().bytes,Buffer.byteLength(JSON.stringify([x,x])))})
test('accessor is never invoked',()=>{let calls=0;const v={get secret(){calls++;return 'private'}};assert.throws(()=>meter(1000,100,()=>{}).measure(v),code('EXPORT_JSON_UNSUPPORTED'));assert.equal(calls,0)})
test('checks run through long strings and can interrupt before publication',()=>{let n=0;assert.throws(()=>meter(10000,100,()=>{if(++n===4)throw Error('cancelled')}).measure('雨'.repeat(2000)),/cancelled/)})
test('iterative freezing safely handles deep projection and immutable Blob reference',()=>{const blob=new Blob(['x']);let root={blob};for(let i=0;i<3000;i++)root={child:root};freezeExportValue(root);let p=root;for(let i=0;i<3000;i++){assert(Object.isFrozen(p));p=p.child}assert(Object.isFrozen(p));assert.equal(p.blob,blob)})
