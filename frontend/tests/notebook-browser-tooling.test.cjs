const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path')
const {replacement,testOrigin}=require('./notebook-browser/isolation.ts')
const root=path.resolve(__dirname,'..')
for(const source of ['./schema','./scheduleHostContext','@/api/tokenStore']) test(`browser tooling replaces only exact notebook adapter dependency ${source}`,()=>{
  assert.equal(replacement(source,`${root}/src/db/notebookReadRepo.ts`,root),`${root}/tests/notebook-browser/store.ts`)
  assert.equal(replacement(source,`${root}/src/db/entryRepo.ts`,root),undefined)
  assert.equal(replacement(source,undefined,root),undefined)
  assert.equal(replacement(source,`${root}/tests/notebook-browser/store.ts`,root),undefined)
})
test('real schema import, unrelated imports and query-bearing importers are not redirected',()=>{
  assert.equal(replacement('../../src/db/schema',`${root}/tests/notebook-browser/store.ts`,root),undefined)
  assert.equal(replacement('@/shared/types',`${root}/src/db/notebookReadRepo.ts`,root),undefined)
  assert.equal(replacement('./schema',`${root}/src/db/notebookReadRepo.ts?unknown`,root),undefined)
})
test('browser tooling normalizes Windows separators without broadening importer boundary',()=>{
  assert.equal(replacement('./schema','C:\\Quire\\src\\db\\notebookReadRepo.ts','C:\\Quire'), 'C:/Quire/tests/notebook-browser/store.ts')
})
test('origin gate accepts only exact loopback HTTP test port',()=>{
  assert(testOrigin({protocol:'http:',hostname:'127.0.0.1',port:'5183'}))
  for(const change of [{port:'5173'},{port:'5181'},{port:'5182'},{hostname:'localhost'},{hostname:'example.com'},{protocol:'https:'}]) assert(!testOrigin({protocol:'http:',hostname:'127.0.0.1',port:'5183',...change}))
})
test('test boot imports business modules only after explicit click and installs IDB guard',()=>{
  const s=fs.readFileSync(path.join(__dirname,'notebook-browser/boot.ts'),'utf8')
  assert(s.indexOf('await import("./run")')>s.indexOf('button.addEventListener("click"'))
  assert(s.includes('testOrigin(location)'));assert(s.includes('name.startsWith("quire-p5-readcheck-")'))
  assert(s.includes('indexedDB.deleteDatabase = () => { throw'))
  assert(!/from\s+["'](?:vue|dexie|.*store)/.test(s))
})
test('test server has strict independent port and no proxy/build output',()=>{
  const s=fs.readFileSync(path.join(root,'vite.notebook-browser.config.ts'),'utf8')
  assert(s.includes('port: 5183, strictPort: true'));assert(s.includes('host: "127.0.0.1"'))
  assert(!/\bproxy\s*:|\boutDir\s*:/.test(s))
})

test('Vite alias-expanded auth path still redirects only for the notebook adapter',()=>{
  for(const source of [`${root}/src/api/tokenStore`,`${root}/src/api/tokenStore.ts`]) {
    assert.equal(replacement(source,`${root}/src/db/notebookReadRepo.ts`,root),`${root}/tests/notebook-browser/store.ts`)
    assert.equal(replacement(source,`${root}/src/api/session.ts`,root),undefined)
  }
})
