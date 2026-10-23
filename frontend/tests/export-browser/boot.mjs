import { PREFIX, testOrigin, installDatabaseGuard } from './isolation.mjs'
import { initialize } from './context.mjs'
const start = document.querySelector('#start'), cancel = document.querySelector('#cancel'), status = document.querySelector('#status')
if (!testOrigin(location)) {
  status.textContent = '拒绝运行：仅限 http://127.0.0.1:5185/；未导入数据库或生产快照模块。'
} else {
  start.disabled = false; start.textContent = '创建随机库并核验一次'
  start.addEventListener('click', async () => {
    start.disabled = true; cancel.disabled = false
    const controller = new AbortController(), opened = [], networkAttempts = []
    const name = `${PREFIX}${crypto.randomUUID()}`
    const fetch = window.fetch, xhrOpen = XMLHttpRequest.prototype.open, beacon = navigator.sendBeacon
    let restore
    const stop = () => { controller.abort(); cancel.disabled = true; status.textContent = '正在停止并释放本次快照……' }
    cancel.addEventListener('click', stop, { once: true })
    try {
      restore = installDatabaseGuard(indexedDB, name, opened)
      window.fetch = (...args) => { networkAttempts.push('fetch'); throw Error('固定核验不允许fetch请求') }
      XMLHttpRequest.prototype.open = function () { networkAttempts.push('xhr'); throw Error('固定核验不允许XHR请求') }
      navigator.sendBeacon = function () { networkAttempts.push('beacon'); return false }
      initialize(name)
      const { run } = await import('./run.mjs')
      await run({ signal: controller.signal, opened, networkAttempts })
    } catch (error) {
      status.textContent = `未完成：${controller.signal.aborted ? '已停止，不计通过' : error.message}`
    } finally {
      restore?.(); window.fetch = fetch; XMLHttpRequest.prototype.open = xhrOpen; navigator.sendBeacon = beacon
      cancel.disabled = true; cancel.removeEventListener('click', stop)
    }
  }, { once: true })
}
