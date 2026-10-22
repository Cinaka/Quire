const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const root=path.resolve(__dirname,'..')
const read=p=>fs.readFileSync(path.join(root,p),'utf8')
test('read adapter exposes only r transactions and local get/bulkGet, no cloud media path',()=>{
  const source=read('src/db/notebookReadRepo.ts')
  assert(source.includes('db.transaction("r"'))
  assert(!/\b(?:fetch|put|update|add|delete|modify|getThumb|ensureOriginal)\s*\(/.test(source))
  assert(!source.includes('remoteUrl'));assert(!source.includes('cloudMediaRepo'))
})
test('components use public type boundary, no db/editor/upload or arbitrary HTML props',()=>{
  for(const name of fs.readdirSync(path.join(root,'src/components/notebook'))){
    const source=read(`src/components/notebook/${name}`)
    assert(!source.includes('@/db/'),name);assert(!source.includes('v-html'),name)
    assert(!source.includes('v-bind="node'),name);assert(!source.includes('DiaryEditor'),name)
  }
})
test('public factory is verified only; no raw lease constructor in public repo',()=>{
  const source=read('src/repo/index.ts')
  assert(source.includes('export type { NotebookReadPort'))
  assert(!source.includes('createLocalNotebookReadPort'))
  assert(source.includes('createVerifiedNotebookReadPort'))
})
test('font declarations remain local to notebook lazy component, not global import',()=>{
  const paper=read('src/components/notebook/NotebookPaper.vue')
  assert(paper.includes('@/styles/notebook-fonts.css'))
  assert(!read('src/styles/notebook-fonts.css').includes('https://'))
})
test('shared projection is platform independent and does not mutate business content',()=>{
  const source=read('src/shared/notebookContent.ts')
  assert(!/\b(?:window|document|fetch|Blob|URL)\b/.test(source))
  assert(!source.includes('@/db/'));assert(!source.includes('tiptap/'));assert(!source.includes('vue'))
})
