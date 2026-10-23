const {test}=require('node:test'),assert=require('node:assert/strict')
const {createExportDocument,collectExportFontText}=require('../src/shared/exportDocument.ts')
const {createExportReview}=require('../src/shared/exportReviewPolicy.ts')
const code=c=>e=>e.code===c
function value(nodes=[],diagnostics=[],media=[],images=[]){
 const snapshot={entries:[{id:'e',entryDate:'2026-10-21',title:'<script>青简🌿</script>',mood:'晴',weather:'雨',tags:[{id:'t',name:'日常'}],content:{nodes,mediaIds:media.map(m=>m.id),warnings:[]}}],media,diagnostics,completeOutputReady:false}
 const review=createExportReview(snapshot,[])
 return {snapshot,review,images:{items:images},degradedConfirmed:!!diagnostics.length,contentMode:diagnostics.length?'degraded':'full',completeOutputReady:false}
}
test('plain presentation retains escaped-as-text title, metadata and stable source paths; no raw fields',()=>{
 const v=value([{kind:'element',tag:'ol',start:3,children:[{kind:'element',tag:'li',children:[{kind:'text',text:'字 与 emoji 🌿'}]}]}]);v.snapshot.owner='secret';v.snapshot.entries[0].dirty=1
 const d=createExportDocument(v),list=d.entries[0].nodes[0]
 assert.equal(list.start,3);assert.deepEqual(list.children[0].children[0].source,{entryId:'e',path:[0,0,0]});assert.equal(d.entries[0].title,v.snapshot.entries[0].title)
 assert.equal(d.completeOutputReady,false);assert(!JSON.stringify(d).includes('secret'));assert(!('dirty' in d.entries[0]));assert(Object.isFrozen(list.children))
 v.snapshot.entries[0].content.nodes[0].start=99;assert.equal(list.start,3)
})
test('paragraphs, code, br, unsupported notice and exact Unicode preserved without HTML',()=>{
 const nodes=[{kind:'text',text:'<img src=x onerror=evil()>\n空　字🌿'},{kind:'notice',text:'未知版本'},{kind:'element',tag:'pre',children:[{kind:'text',text:'a'.repeat(10000)}]},{kind:'element',tag:'br',children:[]}]
 const d=createExportDocument(value(nodes));assert.equal(d.entries[0].nodes[0].text,nodes[0].text);assert.equal(d.entries[0].nodes[2].children[0].text.length,10000)
 assert(collectExportFontText(d).includes('🌿'));assert(collectExportFontText(d).includes('目'))
})
test('diagnosed missing image becomes in-place placeholder with alt/title and reasons, not omitted',()=>{
 const v=value([{kind:'image',mediaId:'m',alt:'原图说明',title:'图名'}],[{code:'IMAGE_MISSING',entryId:'e',resourceId:'m'}],[{id:'m',blob:null,thumbnailOnly:false}])
 const d=createExportDocument(v),n=d.entries[0].nodes[0];assert.equal(n.kind,'placeholder');assert.equal(n.alt,'原图说明');assert.equal(n.title,'图名');assert.equal(n.reasons.length,1);assert.equal(d.entries[0].issues.length,1)
 assert(collectExportFontText(d).includes('缺'));assert(Object.isFrozen(n.reasons));assert(!JSON.stringify(d).includes('blob'))
})
test('available thumbnail retains dimensions AND explicit thumbnail diagnostic',()=>{
 const v=value([{kind:'image',mediaId:'m',alt:'a',title:'b'}],[{code:'IMAGE_THUMBNAIL_ONLY',entryId:'e',resourceId:'m'}],[{id:'m',blob:new Blob(['x']),thumbnailOnly:true}],[{id:'m',width:20,height:30,blob:new Blob(['x'])}])
 const d=createExportDocument(v);assert.equal(d.entries[0].nodes[0].kind,'image');assert.equal(d.entries[0].nodes[0].thumbnailOnly,true);assert.equal(d.entries[0].nodes[0].height,30);assert.equal(d.entries[0].issues[0].code,'IMAGE_THUMBNAIL_ONLY')
})
test('missing tags and unsupported content retained as paper diagnostics, warnings remain visible data',()=>{
 const v=value([{kind:'notice',text:'兼容正文'}],[{code:'CONTENT_UNSUPPORTED',entryId:'e'},{code:'TAG_MISSING',entryId:'e',resourceId:'tag'}]);v.snapshot.entries[0].content.warnings=['保留安全文字']
 const d=createExportDocument(v);assert.equal(d.entries[0].issues.length,2);assert.deepEqual(d.entries[0].warnings,['保留安全文字']);assert(collectExportFontText(d).includes('签'))
})
test('full/empty/unconfirmed refuse construction; undiagnosed image cannot silently disappear',()=>{
 const v=value([{kind:'image',mediaId:'m',alt:'',title:''}],[],[{id:'m',blob:null,thumbnailOnly:false}]);assert.throws(()=>createExportDocument(v),code('EXPORT_DOCUMENT_UNDIAGNOSED_MEDIA'))
 const bad=value([],[{code:'CONTENT_UNSUPPORTED',entryId:'e'}]);bad.contentMode='full';assert.throws(()=>createExportDocument(bad),code('EXPORT_FULL_CONTENT_BLOCKED'));bad.contentMode='degraded';bad.degradedConfirmed=false;assert.throws(()=>createExportDocument(bad),code('EXPORT_DEGRADED_CONFIRMATION_REQUIRED'))
 v.snapshot.entries=[];v.review=createExportReview(v.snapshot,[]);assert.throws(()=>createExportDocument(v),code('EXPORT_EMPTY_SELECTION'))
})
test('font text bounded; huge fanout does not use unbounded argument spread',()=>{
 const d=createExportDocument(value([{kind:'element',tag:'p',children:Array.from({length:150000},()=>({kind:'text',text:'a'}))}]))
 assert(collectExportFontText(d).includes('a'));const large=value([{kind:'text',text:'a'.repeat(6*1024**2)}]);assert.throws(()=>collectExportFontText(createExportDocument(large)),code('EXPORT_FONT_TEXT_LIMIT'))
})
test('shared image repeated in multiple positions is not deduplicated out of the book',()=>{
 const node={kind:'image',mediaId:'m',alt:'a',title:''},v=value([node,node],[],[{id:'m',blob:new Blob(['x']),thumbnailOnly:false}],[{id:'m',width:10,height:20}]);const d=createExportDocument(v)
 assert.equal(d.entries[0].nodes.length,2);assert.deepEqual(d.entries[0].nodes[1].source.path,[1])
})
test('controlled model rejects arbitrary element names and invalid list starts even if caller errs',()=>{
 for(const node of [{kind:'element',tag:'script',children:[]},{kind:'element',tag:'ol',start:0,children:[]},{kind:'element',tag:'p',start:3,children:[]}])assert.throws(()=>createExportDocument(value([node])),code('EXPORT_DOCUMENT_INVALID_NODE'))
})
test('structural depth/fanout guard refuses entire document rather than truncating content',()=>{
 let node={kind:'text',text:'end'};for(let i=0;i<130;i++)node={kind:'element',tag:'p',children:[node]};assert.throws(()=>createExportDocument(value([node])),code('EXPORT_DOCUMENT_LIMIT'))
 const wide={kind:'element',tag:'p',children:Array.from({length:200001},()=>({kind:'text',text:'a'}))};assert.throws(()=>createExportDocument(value([wide])),code('EXPORT_DOCUMENT_LIMIT'))
})
test('custom sanitized cover title and all generated cover characters join final font text before loading',()=>{
 const d=createExportDocument(value([]),{title:' /篆\n青\\简 '});assert.equal(d.bookTitle,'篆 青 简');const chars=collectExportFontText(d);for(const x of '篆本机已保存内容的编排快照部分图片以占位呈现篇续')assert(chars.includes(x));assert(Object.isFrozen(d));assert.throws(()=>createExportDocument(value([]),{title:'字'.repeat(121)}),code('EXPORT_BOOK_TITLE_LIMIT'))
})
