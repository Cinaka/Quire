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

function tagPublicationHTTP(options={}) {
 let owner="account-a",generation=0,requestHook;const calls=[]
 const tokens={accessTokenSubject:()=>owner,tokenGeneration:()=>generation,getAccessToken:()=>"fixed-token"}
 const input={plan_id:MEDIA,confirmed:true,marker:"original"}
 const http={interceptors:{request:{use:fn=>requestHook=fn},response:{use:()=>{}}},async post(url,body,config){
   config.headers={};requestHook(config);calls.push({url,body,config});await options.during?.({switchOwner:()=>{owner="account-b";generation++},relogin:()=>generation++,input},config,body)
   return {status:options.status??200,data:options.raw??JSON.stringify({code:0,message:"ok",data:{presence:"only"}})}
 }}
 const axios={create:()=>http},api=loadTS("api/request.ts",{axios:{default:axios,...axios},"./tokenStore":tokens},{AbortController})
 return {api,calls,input,run:(changes={})=>api.postPinnedScheduleIndependentTags(changes.id??ID,changes.body??input,changes.lease??lease,changes.signal??new AbortController().signal)}
}
test("tag publication HTTP is fixed-account, bounded, detached JSON and create-only path",async()=>{
 const h=tagPublicationHTTP({during:async h=>{h.input.marker="changed"}});assert.equal((await h.run()).presence,"only");assert.equal(h.calls.length,1)
 const c=h.calls[0];assert.equal(c.url,`/schedules/${ID}/independent-tags`);assert.equal(c.body.marker,"original");assert.equal(c.config._syncOwner,"account-a");assert.equal(c.config._tokenGeneration,0)
 assert.equal(c.config.headers.Authorization,"Bearer fixed-token");assert.equal(c.config.maxContentLength,128*1024);assert.equal(c.config.responseType,"text")
})
for(const mode of ["id","owner","generation","aborted","large-body"])test(`tag publication HTTP invalid ${mode} starts no network`,async()=>{
 const h=tagPublicationHTTP(),changes={}
 if(mode==="id")changes.id="https://other/private"
 if(mode==="owner")changes.lease={...lease,ownerUserId:""}
 if(mode==="generation")changes.lease={...lease,tokenGeneration:-1}
 if(mode==="aborted"){const c=new AbortController();c.abort();changes.signal=c.signal}
 if(mode==="large-body")changes.body={huge:"x".repeat(2*1024*1024)}
 await assert.rejects(h.run(changes));assert.equal(h.calls.length,0)
})
for(const raw of ["{","null","[]",JSON.stringify({code:409,message:"not confirmed",data:{}}),JSON.stringify({code:0,message:"ok",data:{},extra:true}),"x".repeat(128*1024+1),JSON.stringify({code:0,message:"ok",data:"汉".repeat(50000)})])test(`tag publication HTTP rejects bad/oversize envelope (${raw.length})`,async()=>{
 await assert.rejects(tagPublicationHTTP({raw}).run())
})
for(const mode of ["owner","relogin","cancel","progress"])test(`tag publication HTTP late ${mode} cannot return a confirmation`,async()=>{
 const controller=new AbortController(),h=tagPublicationHTTP({during:async(h,config)=>{
   if(mode==="owner")h.switchOwner();if(mode==="relogin")h.relogin();if(mode==="cancel")controller.abort();if(mode==="progress")config.onDownloadProgress({loaded:128*1024+1})
 }})
 await assert.rejects(h.run({signal:controller.signal}));assert.equal(h.calls.length,1)
 if(mode==="cancel"||mode==="progress")assert.equal(h.calls[0].config.signal.aborted,true)
})
test("tag publication HTTP never treats a non-200 response as presence confirmation",async()=>{await assert.rejects(tagPublicationHTTP({status:409}).run())})
test("tag publication transport factory is inert and preserves fixed lease, original body and signal",async()=>{
 const calls=[],body={confirmed:true},signal=new AbortController().signal,mocks={"./request":{getPinnedScheduleResourceReview:async(...args)=>{calls.push(["get",...args]);return "wire"},postPinnedScheduleIndependentTags:async(...args)=>{calls.push(["post",...args]);return "presence"}}}
 const transport=loadTS("api/scheduleTagPublicationTransport.ts",mocks).createScheduleTagPublicationTransport();assert.equal(calls.length,0)
 assert.equal(await transport.review(ID,lease),"wire");assert.equal(await transport.publish(ID,body,lease,signal),"presence")
 assert.equal(calls[1][1],ID);assert.equal(calls[1][2],body);assert.equal(calls[1][3],lease);assert.equal(calls[1][4],signal)
})
