const {test}=require('node:test'),assert=require('node:assert/strict')
const {normalizeExportBookTitle,settleExportToc,mapExportPages}=require('../src/shared/exportBookRules.ts')
const code=c=>e=>e.code===c
for(const n of [1,3,4,5,8,12,99,100,299,300])for(const mode of ['a5','spread','booklet'])test(`mapping ${mode}/${n} has exactly one of every logical page`,()=>{
 const m=mapExportPages(n,mode),numbers=m.faces.flatMap(f=>f.panels).filter(n=>n!==null).sort((a,b)=>a-b);assert.deepEqual(numbers,Array.from({length:n},(_,i)=>i+1));assert.equal(m.blankPanels,mode==='a5'?0:mode==='spread'?n%2:Math.ceil(n/4)*4-n);assert(Object.isFrozen(m.faces[0].panels))
})
test('8 page booklet order differs from sequential spreads; sheet/side explicit',()=>{
 const b=mapExportPages(8,'booklet');assert.deepEqual(b.faces.map(f=>f.panels),[[8,1],[2,7],[6,3],[4,5]]);assert.deepEqual(b.faces.map(f=>[f.sheet,f.side]),[[1,'front'],[1,'back'],[2,'front'],[2,'back']]);assert.deepEqual(mapExportPages(8,'spread').faces.map(f=>f.panels),[[1,2],[3,4],[5,6],[7,8]])
})
test('mapping rejects bad count and mode',()=>{for(const n of [0,-1,301,1.2,NaN])assert.throws(()=>mapExportPages(n,'a5'));assert.throws(()=>mapExportPages(1,'wrong'),code('EXPORT_OUTPUT_MODE_INVALID'))})
test('cover title is text, path/control stripped, empty defaults, too long rejected',()=>{assert.equal(normalizeExportBookTitle(' /青\n简\\ '),'青 简');assert.equal(normalizeExportBookTitle(''),'青简');assert.equal(normalizeExportBookTitle('<img>'),'<img>');assert.throws(()=>normalizeExportBookTitle('a'.repeat(121)),code('EXPORT_BOOK_TITLE_LIMIT'))})
test('TOC uses full body length, cover offset, immutable starts and converged labels',async()=>{
 const starts=Object.freeze([1,4,10]);let calls=0;const r=await settleExportToc(starts,12,async labels=>{assert(Object.isFrozen(labels));return {pageCount:3,value:++calls}});assert.equal(calls,2);assert.deepEqual(r.labels,[5,8,14]);assert.equal(r.value,2);assert.deepEqual(starts,[1,4,10])
})
test('TOC total budget accounts for trailing pages, not just last title',async()=>{await assert.rejects(settleExportToc([1],299,async()=>({pageCount:1})),code('EXPORT_PAGE_LIMIT'))})
test('TOC exact 300 pages succeeds, bad starts/count rejected',async()=>{
 const r=await settleExportToc([1],298,async()=>({pageCount:1}));assert.equal(r.labels[0],3)
 for(const s of [[],[2],[1,1],[1,3]])await assert.rejects(settleExportToc(s,2,async()=>({pageCount:1})),code('EXPORT_TOC_STARTS_INVALID'))
 await assert.rejects(settleExportToc([1],1,async()=>({pageCount:0})),code('EXPORT_TOC_COUNT_INVALID'))
})
test('TOC cycles and nonconvergence are distinct finite stops',async()=>{
 let n=0;await assert.rejects(settleExportToc([1],1,async()=>({pageCount:++n%2?2:1})),code('EXPORT_TOC_CYCLE'));n=1;await assert.rejects(settleExportToc([1],1,async()=>({pageCount:++n})),code('EXPORT_TOC_ITERATION_LIMIT'))
})
test('TOC late measurement and final identity await cannot publish',async()=>{
 const c=new AbortController();await assert.rejects(settleExportToc([1],1,async()=>{c.abort();return {pageCount:1}},{signal:c.signal}),code('CANCELLED'))
 await assert.rejects(settleExportToc([1],1,async()=>({pageCount:1}),{assertCurrent:async()=>{throw Object.assign(Error(),{code:'STALE'})}}),code('STALE'))
 let now=0;await assert.rejects(settleExportToc([1],1,async()=>{now=20001;return {pageCount:1}},{now:()=>now}),code('EXPORT_TOC_TIMEOUT'))
})
