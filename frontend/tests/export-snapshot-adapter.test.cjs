// Executes actual adapter source with injected Dexie/schema/token modules.
// Verifies wiring only: no real Dexie, IndexedDB, token transport or database isolation.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
const {stripTypeScriptTypes}=require('node:module')
const source=fs.readFileSync(require.resolve('../src/db/exportSnapshotRepo.ts'),'utf8')
function fixture(){
 const calls=[],Dexie={currentTransaction:null},meta={},tags={get:async id=>{calls.push(['tag',id]);return{id}}},media={get:async id=>{calls.push(['media',id]);return{id}}}
 const entries={get:async id=>{calls.push(['entry',id]);return{id}},where:index=>{calls.push(['where',index]);return{between:(...args)=>{calls.push(['between',...args]);return{each:async visit=>visit({id:'indexed'})}}}}}
 const db={name:"testdb",meta,entries,tags,media,transaction:async(...args)=>{calls.push(['transaction',...args.slice(0,-1)]);const old=Dexie.currentTransaction;Dexie.currentTransaction={db,mode:"readonly",storeNames:["meta","entries","tags","media"]};try{return await args.at(-1)()}finally{Dexie.currentTransaction=old}}}
 let token='header.'+Buffer.from(JSON.stringify({exp:Date.now()/1000+1000})).toString('base64url')+'.sig',observer,unsub=0
 const context={touchesExportContent:require('../src/shared/exportContentMutation.ts').touchesExportContent,Dexie,db,liveQuery:fn=>({subscribe:o=>{observer=o;calls.push(['observe',fn]);return{unsubscribe(){unsub++}}}}),readHostOwner:async()=>{calls.push(['owner']);return{ownerUserId:'A',generation:'e1'}},getAccessToken:()=>token,tokenGeneration:()=>7,accessTokenSubject:()=>'A',Date,JSON,atob,performance,createExportSnapshotCore:(io,lease)=>({io,lease})}
 let js=stripTypeScriptTypes(source).replace(/^import .*$/gm,'').replace('export function createLocalExportSnapshotPort','function createLocalExportSnapshotPort');js+='\nresult=createLocalExportSnapshotPort({ownerUserId:"A",generation:"e1",authGeneration:7})'
 vm.createContext(context);vm.runInContext(js,context)
 return{...context.result,calls,db,Dexie,setToken:t=>token=t,emit:()=>observer.next(),get unsub(){return unsub}}
}
test('forced physical read-only transaction includes meta entries tags media; no schedules or write mode',async()=>{const f=fixture();await f.io.read(async()=>{await f.io.owner();await f.io.tag('t');await f.io.media('m')});const tx=f.calls.filter(c=>c[0]==='transaction');assert.equal(tx.length,1);assert.deepEqual(tx[0],['transaction','r!',f.db.meta,f.db.entries,f.db.tags,f.db.media])})
test('outside owner reads atomic meta-only transaction; inside uses existing transaction',async()=>{const f=fixture();await f.io.owner();assert.deepEqual(f.calls.find(c=>c[0]==='transaction'),['transaction','r!',f.db.meta]);f.calls.length=0;f.Dexie.currentTransaction={db:f.db,mode:"readonly",storeNames:["meta"]};await f.io.owner();assert.equal(f.calls.filter(c=>c[0]==='transaction').length,0);for(const tx of [{db:f.db,mode:"readwrite",storeNames:["meta"]},{db:{},mode:"readonly",storeNames:["meta"]},{db:f.db,mode:"readonly",storeNames:[]}]){f.calls.length=0;f.Dexie.currentTransaction=tx;await f.io.owner();assert.equal(f.calls.filter(c=>c[0]==='transaction').length,1)}})
test('indexed inclusive active/date cursor; no default20, toArray or listRepo',async()=>{const f=fixture(),visited=[];await f.io.scan({scope:{kind:'all'},from:null,to:null},r=>visited.push(r.id));assert.deepEqual(f.calls.find(c=>c[0]==='where'),['where','[isDeleted+entryDate]']);const b=f.calls.find(c=>c[0]==='between');assert.equal(JSON.stringify(b),JSON.stringify(['between',[0,'0001-01-01'],[0,'9999-12-31'],true,true]));assert.deepEqual(visited,['indexed']);assert(!/\.toArray\(|entryRepo|\.limit\(|Dexie\.waitFor|arrayBuffer\(/.test(source))})
test('empty intersection skips scan; single ID uses exact get',async()=>{const f=fixture(),visited=[];await f.io.scan({emptyIntersection:true},()=>assert.fail());assert.equal(f.calls.length,0);await f.io.scan({scope:{kind:'entry',id:'e1'}},r=>visited.push(r.id));assert.deepEqual(f.calls,[['entry','e1']]);assert.deepEqual(visited,['e1'])})
test('adapter JWT exp gate rejects malformed/expired token',()=>{const f=fixture();assert.equal(f.io.auth().valid,true);assert.equal(f.io.auth().generation,7);for(const t of ['', 'x.invalid.x','x.'+Buffer.from('{"exp":1}').toString('base64url')+'.x']){f.setToken(t);assert.equal(f.io.auth().valid,false)}})
test('identity watcher delegates unsubscribe; session module shares singleton gate; not public repo API',()=>{const f=fixture();let events=0;const stop=f.io.observeIdentity(()=>events++,()=>{});f.emit();assert.equal(events,1);stop();assert.equal(f.unsub,1);const session=fs.readFileSync(require.resolve('../src/db/exportSessionRepo.ts'),'utf8');assert.match(session,/createVerifiedNotebookCapability\(createLocalExportSnapshotPort, failed\)/);const repo=fs.readFileSync(require.resolve('../src/repo/index.ts'),'utf8');assert(!/ExportSnapshot|exportSession/.test(repo))})
test('committed content watcher routes exact tables and unsubscribes same listener',()=>{
 const f=fixture();let on,off,changed=0,failed=0
 f.Dexie.on=(name,callback)=>{assert.equal(name,'storagemutated');if(callback)on=callback;return{unsubscribe(fn){off=fn}}}
 // Real source function is injected for wiring; not a real Dexie event test.
 // fixture's VM resolves this helper through context on the next construction.
 const stop=f.io.observeContent(()=>changed++,()=>failed++)
 on({['idb://other/entries/']: {}});on({['idb://testdb/meta/']: {}});assert.equal(changed,0);on({['idb://testdb/entries/']: {}});assert.equal(changed,1);assert.equal(failed,0);stop();assert.equal(off,on)
})
