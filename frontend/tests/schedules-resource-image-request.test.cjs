const { test } = require("node:test"), assert = require("node:assert/strict")
const { loadTS } = require("./schedules-harness.cjs")
const ID = "019a0300-1234-7000-8000-000000000001", MEDIA = "019a0300-1234-7000-8000-000000000002"
const lease = { ownerUserId: "account-a", tokenGeneration: 0 }, proof = { state: "verified", size: 11, mime: "image/png", sha256: "0".repeat(64) }
function harness(options={}) {
 let owner="account-a", generation=0, interceptor; const calls=[]
 const tokens={accessTokenSubject:()=>owner,tokenGeneration:()=>generation,getAccessToken:()=>"fixed-token"}
 const http={interceptors:{request:{use:fn=>interceptor=fn},response:{use:()=>{}}},async get(url,config){
  config.headers={};interceptor(config);calls.push({url,config});if(options.during)await options.during({switch:()=>{owner="account-b";generation++}},config)
  return {status:options.status??200,data:options.raw??JSON.stringify({code:0,message:"ok",data:{expected:"payload"}})}
 }}
 const axios={create:()=>http};const api=loadTS("api/request.ts",{axios:{default:axios,...axios},"./tokenStore":tokens},{AbortController})
 return {api,calls,run:(changes={})=>api.getPinnedScheduleResourceImage(changes.id??ID,changes.mediaId??MEDIA,changes.variant??"original",changes.proof??proof,changes.lease??lease,changes.signal??new AbortController().signal)}
}
test("image request is a fixed-source protected GET with proof query and bounded text decoding",async()=>{
 const h=harness();assert.deepEqual(JSON.parse(JSON.stringify(await h.run())),{expected:"payload"});assert.equal(h.calls.length,1)
 const c=h.calls[0];assert.equal(c.url,`/schedules/${ID}/review/resources/${MEDIA}/original`)
 assert.equal(c.config._syncOwner,lease.ownerUserId);assert.equal(c.config._tokenGeneration,0);assert.equal(c.config.headers.Authorization,"Bearer fixed-token")
 assert.deepEqual(JSON.parse(JSON.stringify(c.config.params)),{expected_size:11,expected_mime:"image/png",expected_sha256:"0".repeat(64)})
 assert.equal(c.config.responseType,"text");assert.equal(c.config.transformResponse[0]("raw"),"raw");assert.equal(c.config.maxContentLength,4112)
})
for(const mode of ["id","mediaId","variant","proof-state","proof-size","proof-sha","proof-mime","lease","aborted"])test(`invalid ${mode} is refused before network`,async()=>{
 const h=harness(),changes={};if(["id","mediaId","variant"].includes(mode))changes[mode]="https://external/secret"
 if(mode.startsWith("proof-")){changes.proof={...proof};changes.proof[mode.slice(6)]={state:"missing",size:10*1024*1024+1,sha:"bad",mime:"text/html"}[mode.slice(6)];if(mode==="proof-sha"){changes.proof.sha256="bad";delete changes.proof.sha}}
 if(mode==="lease")changes.lease={...lease,tokenGeneration:-1}
 if(mode==="aborted"){const c=new AbortController();c.abort();changes.signal=c.signal}
 await assert.rejects(h.run(changes));assert.equal(h.calls.length,0)
})
for(const raw of ["{", "null", "[]", JSON.stringify({code:409,message:"stale",data:null}), JSON.stringify({code:0,message:"ok",data:{},owner:"private"}), "x".repeat(4113)])test(`malformed/oversize envelope (${raw.length}) is rejected`,async()=>{
 await assert.rejects(harness({raw}).run())
})
test("late response after an account switch cannot be returned to the caller",async()=>{
 await assert.rejects(harness({during:async h=>h.switch()}).run(),/失效/)
})
test("external cancel is linked to the actual image request signal",async()=>{
 const c=new AbortController();let stopped=false
 const h=harness({during:async(_h,config)=>{c.abort();stopped=config.signal.aborted}})
 await assert.rejects(h.run({signal:c.signal}),/失效/);assert.equal(stopped,true)
})
test("response progress over proof-bound limit aborts transfer even when content-length lies",async()=>{
 let stopped=false;const h=harness({during:async(_h,config)=>{config.onDownloadProgress({loaded:4113,total:1});stopped=config.signal.aborted}})
 await assert.rejects(h.run(),/失效/);assert.equal(stopped,true)
})
test("factory construction does not issue requests and delegates pinned image/review explicitly",async()=>{
 const calls=[],mocks={"./request":{getPinnedScheduleResourceImage:async(...args)=>{calls.push(args);return "bytes"},getPinnedScheduleResourceReview:async(...args)=>{calls.push(args);return "proof"}}}
 const factory=loadTS("api/scheduleCloudResourceImageTransport.ts",mocks).createScheduleCloudResourceImageTransport(),signal=new AbortController().signal
 assert.equal(calls.length,0);assert.equal(await factory.review(ID,lease),"proof");assert.equal(await factory.image(ID,MEDIA,"original",proof,lease,signal),"bytes")
 assert.equal(calls[1][0],ID);assert.equal(calls[1][1],MEDIA);assert.equal(calls[1][5],signal)
})
