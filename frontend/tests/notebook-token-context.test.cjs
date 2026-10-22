// Real tokenStore with a fake storage/window; no real JWT signature/auth server verification.
const {test}=require('node:test'),assert=require('node:assert/strict')
const storage=new Map(),listeners={}
global.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}
global.window={addEventListener:(name,cb)=>listeners[name]=cb}
const t=require('../src/api/tokenStore.ts'),token=(sub,exp=999999)=>`x.${Buffer.from(JSON.stringify({sub,exp})).toString('base64url')}.x`
test('token refresh emits event without changing generation; logout start increments before token removal',()=>{
 t.setAccessToken(token('A'));const g=t.tokenGeneration();let seen=0,subject='';const stop=t.subscribeTokenContext(()=>{seen++;subject=t.accessTokenSubject()});t.setAccessToken(token('A',9999999));assert.equal(t.tokenGeneration(),g);assert.equal(seen,1);t.invalidateTokenContext();assert.equal(t.tokenGeneration(),g+1);assert.equal(subject,'A');assert.equal(seen,2);t.clearAccessToken();assert.equal(subject,'');stop();const count=seen;t.setAccessToken(token('B'));assert.equal(seen,count)
})
test('remote token switch notifies immediately; listener exceptions do not retain another reader',()=>{let seen=0;t.subscribeTokenContext(()=>{throw Error('consumer')});const stop=t.subscribeTokenContext(()=>seen++);const g=t.tokenGeneration();listeners.storage({key:t.ACCESS_TOKEN_KEY,newValue:token('C')});assert.equal(t.accessTokenSubject(),'C');assert.equal(t.tokenGeneration(),g+1);assert.equal(seen,1);stop()})
