// Static architecture guards, NOT a browser acceptance substitute.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const read=p=>fs.readFileSync(path.join(__dirname,'../src',p),'utf8')
test('formal ListView owns one shared query and imports book lazily',()=>{const s=read('views/ListView.vue');assert.equal((s.match(/= useEntryList\(/g)||[]).length,1);assert(s.includes('defineAsyncComponent(() => import("@/components/notebook/NotebookBook.vue"))'));assert(!/import\s+NotebookBook\s+from/.test(s));assert(s.includes('...route.query'));assert(s.includes('!queryError && !filterError && items.length'))})
test('only the verified public factory opens a reader, with no login/claim/sync/write side effects',()=>{const s=read('db/notebookSessionRepo.ts');assert(s.includes('get<{ id: string }>("/auth/me", undefined, subject)'));assert(s.includes('navigator.onLine'));assert(!/\b(?:runSync|claimLocalData|resetLocalForNewOwner|put|add|update|delete)\s*\(/.test(s));assert(s.includes('db.transaction("r", db.meta'));assert(s.includes('subscribeTokenContext'));assert(s.includes('scheduleExpiry'));assert(s.includes('liveQuery(readNotebookOwner)'))})
test('reader edit preflights live port and refuses P4 converted target shortcut',()=>{const s=read('views/ListView.vue');const block=s.slice(s.indexOf('async function editFromBook'),s.indexOf('const tags ='));assert(block.includes('await port.readEntry(id)'));assert(block.includes('await port.assertCurrent()'));assert(block.includes('!canOpenScheduleDiaryContent(entry.content)'));assert(block.indexOf('entry.fromScheduleId !== null')<block.indexOf('await open(id, port)'));assert(s.includes("router.push('/schedules')"));assert(s.includes('await expectedPort.assertCurrent()'))})
test('editor keeps flush-first navigation and deletion returns to scoped list capsule',()=>{const s=read('views/EntryEditView.vue');const back=s.slice(s.indexOf('async function back'),s.indexOf('onBeforeRouteUpdate(',s.indexOf('async function back')));assert(back.indexOf('await flush()')<back.indexOf('hasNotebookEditReturn'));assert(s.includes('void router.replace(hasNotebookEditReturn(routeId.value) ? "/list" : "/")'));assert(s.includes('onBeforeRouteLeave(async () => {\n  await flush()'))})
test('book owns keyboard listener, reduced motion is explicit, no window key grab',()=>{const s=read('components/notebook/NotebookBook.vue');assert(s.includes('host.value?.addEventListener("keydown"'));assert(!s.includes('window.addEventListener("keydown"'));assert(s.includes('prefers-reduced-motion: reduce'));assert(s.includes('transition: none'));assert(s.includes('getSelection()'));assert(s.includes('event.defaultPrevented'))})
test('auth cancellation is explicit and legacy claim/two syncs stay behind submit',()=>{const s=read('views/AuthView.vue');assert(s.includes('cancelNotebookLogin()'));assert(s.includes('取消，返回原列表'));assert(s.includes('returningToList ? "/list" : "/"'));const fn=s.slice(s.indexOf('function cancelToList'),s.indexOf('const email'));assert(!fn.includes('runSync'));assert(!fn.includes('claimLocalData'))})
test('normal list is not forcibly redirected when notebook identity fails', () => {
  const source = read('bootstrap.ts'), vm = require('node:vm')
  // Run both actual callback bodies, not just count a phrase in a relocated file.
  for (const handler of ['setUnauthorizedHandler', 'onRemoteLogout']) {
    const match = source.match(new RegExp(`\\b${handler}\\(\\(\\) => \\{([\\s\\S]*?)\\n\\}\\)`))
    assert.ok(match, `${handler} callback missing`)
    for (const name of ['auth', 'list', 'home', 'entry-edit', undefined]) {
      const redirects = [], router = {
        currentRoute: { value: { name } }, push: target => { redirects.push(target.name) },
      }
      vm.runInNewContext(`(() => {${match[1]}\n})()`, { router })
      assert.deepEqual(redirects, ['auth', 'list'].includes(name) ? [] : ['auth'], `${handler}: ${name}`)
    }
  }
})
test('startup gate loads notebook/auth wiring only after UUID32 readiness', () => {
  const source = read('main.ts')
  const gate = source.indexOf('const ready = await prepareUuid32Storage(')
  const lazy = source.indexOf('await import("./bootstrap")')
  assert.ok(gate >= 0 && lazy > gate)
  assert.match(source.slice(gate, lazy), /if \(!ready\) \{[^}]*return/)
  assert.doesNotMatch(source, /import\s+[^;\n]*from\s+["']\.\/bootstrap["']/)
  assert.doesNotMatch(source, /\b(?:createApp|runSync|scheduleSync|runMediaMaintenance)\s*\(|router\.currentRoute/)
})
test('return capsules never persist into storage or a database',()=>{const s=read('shared/notebookReturn.ts');assert(!/\b(?:localStorage|sessionStorage|indexedDB)\b|db\./.test(s));assert(s.includes('before.ownerUserId !== scope.ownerUserId'));assert(s.includes('before.subject !== scope.subject'))})

test('scope changes refresh metadata IDs before publishing a new account reader',()=>{const s=read('views/ListView.vue');const a=s.indexOf('if (scopeKey !== listScopeKey)');const b=s.indexOf('readPort.value = candidate');assert(a>=0&&a<b);assert(s.slice(a,b).includes('items.value = []'));assert(s.slice(a,b).includes('tagIds.value = []'));assert(s.slice(a,b).includes('await reload(); await loadTags(); await candidate.assertCurrent()'))})
test('a current tombstone requests fresh shared results instead of keeping a dead page',()=>{assert(read('components/notebook/NotebookReadingPane.vue').includes('emit("unavailable")'));assert(read('components/notebook/NotebookBook.vue').includes('@unavailable="emit(\'refresh\')"'));assert(read('views/ListView.vue').includes('@refresh="refreshUnavailable"'))})

test('unavailable page retry is bounded per anchor/filter version',()=>{const s=read('views/ListView.vue');assert(s.includes('key === missingRefreshKey'));assert(s.includes('missingRefreshKey = key'))})
