const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {compileExportFlows,sliceExportFlow,assertExportPageCoverage}=require('../src/shared/exportFragments.ts')
const source={entryId:'e',path:[0]},t=text=>({kind:'text',text,source}),documentOf=nodes=>({entries:[{id:'e',entryDate:'2026-10-21',title:'题',mood:null,weather:null,tags:[],issues:[],warnings:[],nodes}]})
const options={check(){},yieldControl:async()=>{}},flat=nodes=>nodes.flatMap(n=>n.kind==='text'?[n]:flat(n.children??[])),code=c=>e=>e.code===c
test('grapheme boundaries never split emoji/ZWJ/combining accents; slices exactly reconstruct text',async()=>{
 const text='空　字 Á 🌿👨‍👩‍👧‍👦\nEND',flow=(await compileExportFlows(documentOf([t(text)]),options))[0],start=flow.nodes.at(-1).start,end=flow.units
 const parts=[];for(let i=start;i<end;i++)parts.push(flat(sliceExportFlow(flow,i,i+1))[0].text)
 assert.equal(parts.join(''),text);assert(parts.includes('Á'));assert(parts.includes('👨‍👩‍👧‍👦'));assert(parts.includes('\n'))
})
test('nested ordered-list numbering and marks survive slices; source path stable',async()=>{
 const nodes=[{kind:'element',tag:'ol',start:3,source,children:[{kind:'element',tag:'li',source,children:[{kind:'element',tag:'strong',source,children:[t('一二三四五六')]}]},{kind:'element',tag:'li',source,children:[t('第4项')]}]}]
 const f=(await compileExportFlows(documentOf(nodes),options))[0],list=f.nodes.at(-1),li=list.children[0],slice=sliceExportFlow(f,li.start+2,list.end).at(-1)
 assert.equal(slice.listStart,3);assert.equal(slice.children[0].listValue,3);assert.equal(slice.children[1].listValue,4);assert(slice.children[0].continued);assert.equal(slice.children[0].children[0].tag,'strong');assert.deepEqual(flat([slice])[0].source,source)
})
test('image is one indivisible unit; caption and diagnosed placeholder remain text units',async()=>{
 const image={kind:'image',mediaId:'m',width:200,height:1000,alt:'长图',title:'图注',thumbnailOnly:false,source},placeholder={kind:'placeholder',mediaId:'n',alt:'缺图',title:'原位',reasons:['本机缺失'],source}
 const f=(await compileExportFlows(documentOf([image,placeholder]),options))[0],figure=f.nodes.at(-2),pic=figure.children[0]
 assert.equal(pic.end-pic.start,1);assert.equal(sliceExportFlow(f,pic.start,pic.end).at(-1).children[0].kind,'image');assert(flat(sliceExportFlow(f,figure.start,f.units)).map(n=>n.text).join('').includes('【图片占位】原位；缺图；本机缺失'))
})
test('hard breaks and empty structures have explicit units; no silent loss',async()=>{
 const f=(await compileExportFlows(documentOf([{kind:'element',tag:'br',children:[],source},{kind:'element',tag:'p',children:[],source},t('')]),options))[0]
 for(const n of f.nodes.slice(-3))assert.equal(n.end-n.start,1)
})
test('all metadata, warnings and diagnostic reasons are accounted, separate negative source namespace',async()=>{
 const d=documentOf([t('正文')]);Object.assign(d.entries[0],{mood:'🌿',weather:'晴',tags:['日常'],issues:[{reason:'缺标签'}],warnings:['未知格式']});const f=(await compileExportFlows(d,options))[0]
 const txt=flat(sliceExportFlow(f,0,f.units)).map(n=>n.text).join('');for(const s of ['2026-10-21','题','晴','🌿','#日常','缺标签','未知格式','正文'])assert(txt.includes(s));assert(f.nodes[0].source.path[0]<0)
})
test('coverage detects gaps, overlap, omissions, wrong entry, extra pages and order',async()=>{
 const f=(await compileExportFlows(documentOf([t('ab')]),options))[0],ok=[{entryId:'e',from:0,to:3},{entryId:'e',from:3,to:f.units}];assertExportPageCoverage([f],ok)
 for(const bad of [ok.slice(0,1),[{entryId:'e',from:1,to:f.units}],[{entryId:'e',from:0,to:3},{entryId:'e',from:2,to:f.units}],[{entryId:'x',from:0,to:f.units}],[...ok,...ok]])assert.throws(()=>assertExportPageCoverage([f],bad),code('EXPORT_PAGE_COVERAGE_FAILED'))
})
test('forged/unbounded ranges rejected before DOM work',async()=>{
 const f=(await compileExportFlows(documentOf([t('ab')]),options))[0];for(const [a,b]of [[-1,1],[1,1],[0,f.units+1],[0,1.2]])assert.throws(()=>sliceExportFlow(f,a,b),code('EXPORT_INVALID_FRAGMENT_RANGE'));assert.throws(()=>sliceExportFlow({...f},0,1),code('EXPORT_INVALID_FRAGMENT_RANGE'))
})
test('cooperative cancellation during segmentation stops instead of returning a partial flow',async()=>{
 let stopped=false,yields=0;await assert.rejects(compileExportFlows(documentOf([t('a'.repeat(5000))]),{check(){if(stopped)throw Object.assign(Error('CANCELLED'),{code:'CANCELLED'})},async yieldControl(){yields++;stopped=true}}),code('CANCELLED'));assert.equal(yields,1)
})
test('private grapheme index has explicit allocation budget',async()=>{
 await assert.rejects(compileExportFlows(documentOf([t('a'.repeat(8*1024**2))]),options),code('EXPORT_FRAGMENT_MEMORY_LIMIT'))
})
test('new layout tools are isolated, click-gated, no auto printing/DB/private file access',()=>{
 const root=path.resolve(__dirname,'..'),boot=fs.readFileSync(path.join(__dirname,'export-layout-browser/boot.mjs'),'utf8'),config=fs.readFileSync(path.join(root,'vite.export-layout.config.mjs'),'utf8'),css=fs.readFileSync(path.join(root,'src/print/exportA5.css'),'utf8')
 assert(boot.includes("location.port==='5186'"));assert(boot.includes('indexedDB.open=()=>'));assert(boot.includes("start.addEventListener('click'"));assert(config.includes('strictPort:true'));assert(!/window\.print|fetch\(|localStorage|showOpenFilePicker/.test(boot));assert(!/overflow\s*:\s*hidden/.test(css));assert(css.includes('@page quire-a5'));assert(!/@page\s*\{/.test(css))
})
test('pathological single grapheme rejected before giant atomic DOM layout',async()=>{
 await assert.rejects(compileExportFlows(documentOf([t('A'+'\u0301'.repeat(8192))]),options),code('EXPORT_GRAPHEME_LIMIT'))
})

test('every sliced descendant has its own interval, without retaining raw flow children',async()=>{
 const nodes=[{kind:'element',tag:'blockquote',source,children:[{kind:'element',tag:'strong',source,children:[t('一二三四')]},{kind:'element',tag:'br',source,children:[]}]}, {kind:'image',mediaId:'m',width:200,height:1000,alt:'图',title:'注',thumbnailOnly:false,source}]
 const f=(await compileExportFlows(documentOf(nodes),options))[0], raw=[]
 function originals(ns){for(const n of ns){raw.push(n);originals(n.children??[])}}originals(f.nodes)
 const before=JSON.stringify(f)
 function verify(ns){for(const n of ns){assert(!raw.includes(n));assert(Object.isFrozen(n));assert(Number.isSafeInteger(n.from));assert(Number.isSafeInteger(n.to));assert(n.to>n.from);assert.equal(n.continued,n.from>n.start);if(n.children){assert(Object.isFrozen(n.children));verify(n.children)}}}
 verify(sliceExportFlow(f,0,f.units))
 for(let i=0;i<f.units;i++)verify(sliceExportFlow(f,i,i+1))
 assert.equal(JSON.stringify(f),before)
})
