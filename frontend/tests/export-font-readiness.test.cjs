const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {selectExportFontShards,prepareExportFonts}=require('../src/shared/exportFontReadiness.ts'),{EXPORT_FONT_CATALOG}=require('../src/shared/exportFontCatalog.ts')
const {ExportSnapshotError}=require('../src/shared/exportSnapshot.ts'),code=c=>e=>e.code===c
const immediate=()=>new Promise(setImmediate)
function fixture(){let load=async()=>{},active=0,peak=0;const made=[],added=new Set(),removed=[]
 const host={create(family,file,range){const face={family,file,range,async load(){active++;peak=Math.max(peak,active);try{await load(face)}finally{active--}}};made.push(face);return face},add(f){added.add(f)},remove(f){added.delete(f);removed.push(f)}}
 return {host,made,added,removed,set load(v){load=v},get peak(){return peak}}
}
test('catalog exactly matches all 114 P5 unicode ranges, actual cmap and files; no new assets',()=>{
 const root=path.resolve(__dirname,'../src'),css=fs.readFileSync(path.join(root,'styles/notebook-fonts.css'),'utf8'),manifest=JSON.parse(fs.readFileSync(path.join(root,'assets/fonts/notebook/manifest.json')))
 assert.equal(EXPORT_FONT_CATALOG.length,114)
 const faces=[...css.matchAll(/(wenkai-\w+\.woff2).*?unicode-range:\s*([^;]+);/gs)]
 assert.equal(faces.length,114)
 for(const [i,face] of faces.entries()){
  const row=EXPORT_FONT_CATALOG[i];assert.equal(row.file,face[1]);const ranges=face[2].split(',').map(r=>{const a=r.trim().replace('U+','').split('-');return [parseInt(a[0],16),parseInt(a.at(-1),16)]});assert.deepEqual(row.ranges,ranges)
  const shard=manifest.shards.find(s=>s.file===row.file),cps=row.ranges.flatMap(([lo,hi])=>Array.from({length:hi-lo+1},(_,j)=>lo+j));assert.deepEqual(cps,shard.codepoints);assert.equal(fs.statSync(path.join(root,'assets/fonts/notebook',row.file)).size,shard.bytes)
 }
})
test('only actual used public shards selected; unsupported emoji counted, not sent anywhere',()=>{
 const p=selectExportFontShards('青简🌿青简\n');assert(p.shards.length>0&&p.shards.length<114);assert.equal(p.uncoveredScalars,1);assert.equal(selectExportFontShards(' ').shards.length,1);assert.equal(selectExportFontShards('\n\t').shards.length,0)
})
test('load before registration; unique family and at most four concurrent loads; release idempotent',async()=>{
 const f=fixture();f.load=async()=>{assert.equal(f.added.size,0);await immediate()};const text=EXPORT_FONT_CATALOG.map(s=>String.fromCodePoint(s.ranges[0][0])).join('')
 const a=await prepareExportFonts(text,'wenkai',{host:f.host,assertCurrent:async()=>{}});assert.equal(a.shardCount,114);assert(f.peak<=4);assert.equal(f.added.size,114)
 const b=await prepareExportFonts('青','wenkai',{host:fixture().host,assertCurrent:async()=>{}});assert.notEqual(a.family,b.family);b.release();a.release();a.release();assert.equal(f.added.size,0);assert.equal(f.removed.length,114)
})
test('native font failure rejects with no automatic system fallback or registered faces',async()=>{
 const f=fixture();f.load=async()=>{throw Error('native')};await assert.rejects(prepareExportFonts('青简','wenkai',{host:f.host,assertCurrent:async()=>{}}),code('EXPORT_FONT_LOAD_FAILED'));assert.equal(f.added.size,0)
 const system=await prepareExportFonts('青简','system',{host:f.host,assertCurrent:async()=>{}});assert.equal(system.family,'serif');assert.equal(system.shardCount,0);assert.equal(system.mode,'system');system.release()
})
test('cancellation during raw load never registers late faces',async()=>{
 const f=fixture(),c=new AbortController();let resume;f.load=()=>new Promise(r=>resume=r);const work=prepareExportFonts('青','wenkai',{host:f.host,signal:c.signal,assertCurrent:async()=>{}});await immediate();c.abort();await assert.rejects(work,code('CANCELLED'));resume();await immediate();assert.equal(f.added.size,0)
})
test('timeout cannot publish late font; retry has different private family',async()=>{
 const f=fixture();let resume;f.load=()=>new Promise(r=>resume=r);await assert.rejects(prepareExportFonts('青','wenkai',{host:f.host,assertCurrent:async()=>{},timeoutMs:10}),code('EXPORT_FONT_TIMEOUT'));resume();await immediate();assert.equal(f.added.size,0)
 f.load=async()=>{};const lease=await prepareExportFonts('青','wenkai',{host:f.host,assertCurrent:async()=>{}});assert.notEqual(f.made[0].family,f.made.at(-1).family);lease.release()
})
test('identity failure after raw load and partial host registration both clean all added faces',async()=>{
 const f=fixture();let calls=0;await assert.rejects(prepareExportFonts('青','wenkai',{host:f.host,assertCurrent:async()=>{if(++calls===2)throw new ExportSnapshotError('OWNER_CHANGED')}}),code('OWNER_CHANGED'));assert.equal(f.added.size,0)
 const g=fixture(),add=g.host.add;g.host.add=f=>{add(f);throw Error('host')};await assert.rejects(prepareExportFonts('青','wenkai',{host:g.host,assertCurrent:async()=>{}}),code('EXPORT_FONT_LOAD_FAILED'));assert.equal(g.added.size,0)
})
test('already aborted, invalid mode and work budget rejected before requests',async()=>{
 const f=fixture(),c=new AbortController();c.abort();await assert.rejects(prepareExportFonts('青','wenkai',{host:f.host,signal:c.signal,assertCurrent:async()=>{}}),code('CANCELLED'))
 await assert.rejects(prepareExportFonts('青','auto',{host:f.host,assertCurrent:async()=>{}}),code('EXPORT_INVALID_FONT_MODE'));assert.throws(()=>selectExportFontShards('x'.repeat(6*1024**2+1)),code('EXPORT_FONT_TEXT_LIMIT'));assert.equal(f.made.length,0)
})
test('browser adapter references existing URL assets only; no CSS swap/CDN/document.fonts.ready claim',()=>{
 const s=fs.readFileSync(path.resolve(__dirname,'../src/print/exportFontBrowser.ts'),'utf8');assert(s.includes('import.meta.glob<string>'));assert(s.includes('document.fonts.delete'));assert(!s.includes('notebook-fonts.css'));assert(!s.includes('fonts.ready'));assert(!s.includes('https://'))
})
