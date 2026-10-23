<template>
  <div class="export-page">
    <header class="export-head"><button type="button" @click="router.push('/settings')">返回设置</button><span>QUIRE / PRINT</span></header>
    <h1>杀青 · 打印与导出</h1>
    <p class="intro">将本机已保存的简编成纸页。先核对范围，再确认预览；不会上传、同步或补取云端图片。PDF 由浏览器的打印菜单保存，不是备份文件。</p>
    <p v-if="handoffNotice" class="notice" role="status">{{ handoffNotice }}</p>
    <label v-if="handoffNeedsConfirmation" class="check notice"><input v-model="replacementConfirmed" type="checkbox" :disabled="busy" />原入口范围不可恢复，我明确重新选择下方范围；不会沿用丢失的筛选。</label>
    <p v-if="error" class="warning" role="alert">{{ error }}</p>
    <p v-if="changed" class="warning" role="status">本机内容已有变化；这里仍是原快照，不会自动混入新内容。需要最新内容时，请重新取快照。</p>
    <section class="export-card" aria-labelledby="scope-heading">
      <h2 id="scope-heading">1 · 选择本机范围</h2>
      <fieldset :disabled="phase !== 'select' || busy || initializing">
        <label>范围<select v-model="kind"><option v-if="entryScope" value="entry">当前这一简</option><option value="day">某日</option><option value="month">某月</option><option value="year">某年</option><option value="range">起止日期（含首尾）</option><option value="all">全部本机可读简</option></select></label>
        <label v-if="kind === 'day'">日期<input v-model="day" type="date" /></label>
        <label v-if="kind === 'month'">月份<input v-model="month" type="month" /></label>
        <label v-if="kind === 'year'">年份<input v-model="year" inputmode="numeric" maxlength="4" /></label>
        <div v-if="kind === 'range'" class="fields"><label>起始日期<input v-model="from" type="date" /></label><label>结束日期<input v-model="to" type="date" /></label></div>
        <label>封面书名<input v-model="title" maxlength="240" placeholder="青简" /></label>
      </fieldset>
      <div v-if="inheritedFilters" class="filter-summary"><p><strong>与进入时的列表筛选取交集</strong>，不是只取已加载的列表行；不沿用列表排序。</p><ul><li v-if="inheritedFilters.keyword">关键词：{{ inheritedFilters.keyword }}</li><li v-if="inheritedFilters.tagIds?.length">标签：同时包含已选的 {{ inheritedFilters.tagIds.length }} 个标签</li><li v-if="inheritedFilters.dateFrom || inheritedFilters.dateTo">日期：{{ inheritedFilters.dateFrom || '不限' }} 至 {{ inheritedFilters.dateTo || '不限' }}</li><li v-if="inheritedFilters.hasImage !== undefined">{{ inheritedFilters.hasImage ? '有图片引用' : '无图片引用' }}</li></ul></div>
      <p class="small">全部仅指本机非删除、可读取的简，不代表云端完整。按日期升序、同日次序降序编排；安全草稿和编辑器未保存内容不在其中。</p>
      <p class="small">保护上限：100 简、正文 JSON 4 MiB、图片 64 MiB、300 逻辑页；超限请缩小范围，不会自动截断。</p>
      <div class="actions"><button v-if="phase === 'select'" type="button" class="primary" :disabled="busy || initializing || (handoffNeedsConfirmation && !replacementConfirmed)" @click="capture">核对范围与图片</button><button v-else type="button" :disabled="busy" @click="resetSelection">重新选择</button><button v-if="checked" type="button" :disabled="busy" @click="capture">按原范围重新取快照</button><button v-if="busy && !printing" type="button" @click="cancelWork">停止并清空</button></div>
    </section>
    <p class="progress" role="status" aria-live="polite">{{ progress }}</p>
    <section v-if="checked" class="export-card" aria-labelledby="review-heading">
      <h2 id="review-heading">2 · 核对固定快照</h2>
      <p><strong>{{ checked.snapshot.entries.length }} 简</strong> · {{ capturedRange }} · 本机快照</p>
      <p v-if="!checked.snapshot.entries.length">没有符合范围与筛选的简。请重新选择。</p>
      <template v-else>
        <p v-if="checked.review.issueCount" class="warning">存在 {{ checked.review.issueCount }} 项诊断，影响 {{ checked.review.affectedEntryCount }} 简、{{ checked.review.affectedImageCount }} 张图片。完整内容输出已阻止；不会静默省略。</p>
        <p v-else>图片检查完成，未发现需要降级确认的项目。字体和分页仍须下一步检查。</p>
        <details v-if="checked.review.issueCount"><summary>逐篇查看诊断与原因</summary><article v-for="entry in checked.review.entries" :key="entry.entryId" class="diagnostic"><h3>{{ entry.entryDate }} · {{ entry.title || '无题' }}</h3><ul><li v-for="(issue, i) in entry.issues" :key="i">{{ issue.reason }}</li></ul></article></details>
        <label class="check"><input v-model="scopeConfirmed" type="checkbox" :disabled="busy || phase === 'preview'" />我已核对上述范围、筛选及 {{ checked.snapshot.entries.length }} 简的数量。</label>
        <label v-if="checked.review.issueCount" class="check"><input v-model="degradedConfirmed" type="checkbox" :disabled="busy || phase === 'preview'" />我已查看诊断，接受兼容内容、图片占位及纸面诊断；这不是完整内容输出。</label>
        <div v-if="phase !== 'preview'" class="actions"><button type="button" class="primary" :disabled="busy || !reviewAllowed" @click="prepare('wenkai')">准备文楷预览</button><button type="button" :disabled="busy || !reviewAllowed" @click="prepare('system')">明确改用系统字体</button></div>
        <p v-if="phase !== 'preview'" class="small">字体失败不会自动换字。系统字体会重新排版，字形与页数可能不同；请重新核对预览。</p>
      </template>
    </section>
    <section v-if="phase === 'preview'" class="export-card" aria-labelledby="preview-heading">
      <h2 id="preview-heading">3 · 预览与打印</h2>
      <div class="actions" aria-label="纸张映射"><button v-for="item in modes" :key="item.value" type="button" :aria-pressed="mode === item.value" :class="{ primary: mode === item.value }" :disabled="busy" @click="switchMode(item.value)">{{ item.label }}</button></div>
      <p v-if="mapping">{{ logicalPages }} 逻辑页 · {{ tocPages }} 页目录 · {{ mapping.paperFaces }} 纸面 · {{ mapping.blankPanels }} 补白面板<br />单面 {{ mapping.singleSidedSheets }} 张 / 双面 {{ mapping.duplexSheets }} 张</p>
      <p class="small">{{ fontMode === 'wenkai' ? '文楷已准备' : '系统字体预览' }}；部分字符及 emoji 仍取决于设备字形，请检查。封面计为逻辑第 1 页、不印页码；目录指向逻辑页，不是纸面号。补白不代表日记。</p>
      <p class="small">{{ mode === 'a5' ? 'A5 纵向' : 'A4 横向' }} · 100% · 关闭系统“多合一”和页眉页脚。{{ mode === 'booklet' ? '左侧装订；双面通常从短边翻转开始，驱动不同，须少量实物试打核对。' : '双面翻转方向须结合打印机设置实物核对。' }}</p>
      <p class="small">打印内容将交给浏览器 / 系统；应用无法撤回系统已取得的内容、PDF 或纸张，请注意保存位置与共享设备。</p>
      <label class="check"><input v-model="previewConfirmed" type="checkbox" :disabled="busy" />我已检查当前字体、页码、图文与{{ mode === 'booklet' ? '折叠拼版' : '纸张映射' }}预览。</label>
      <div class="actions"><button type="button" class="primary" :disabled="busy || !previewConfirmed" @click="print">打印 / 另存 PDF</button><button type="button" :disabled="busy" @click="reprepare">重新准备字体与预览</button></div>
      <p v-if="printState === 'printing'" class="warning" role="status">已请求浏览器打印。页面会保留字体和图片；请先关闭系统对话框，再操作下面的确认。应用无法判断是否打印或保存。</p>
      <button v-if="printState === 'printing'" type="button" @click="acknowledgePrint">我已关闭对话框，返回预览</button>
      <p v-if="printState === 'returned'" role="status">打印对话框已返回。是否保存或打印，请自行核对；这里不会标记成功。</p>
      <p v-if="printState === 'acknowledged'" role="status">已按你的确认返回预览；无法判断打印或保存结果。</p>
    </section>
    <section :class="{ 'preview-measure': phase !== 'preview' || printing }" class="preview-region" aria-label="纸页预览"><p class="small">纸页保持实际尺寸；小屏可在此区域横向查看。</p><div ref="previewHost" class="preview-scroll" tabindex="0" aria-label="可横向滚动的纸页预览" /></section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue"
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router"
import { captureNotebookScope, createVerifiedExportPreflightTask } from "@/repo"
import { takeExportHandoff } from "@/shared/exportHandoff"
import { compileExportSelection, type ExportScope, type ExportFilters, type ExportSelectionRequest } from "@/shared/exportScope"
import type { ExportCheckedSnapshot } from "@/shared/exportPreflightTask"
import { createExportDocumentTask } from "@/shared/exportDocumentTask"
import type { ExportFontMode } from "@/shared/exportFontReadiness"
import type { ExportOutputMode } from "@/shared/exportBookRules"
import type { ExportPrintState } from "@/shared/exportPrintLifecycle"
import { prepareBrowserExportFonts } from "@/print/exportFontBrowser"
import { prepareExportBook } from "@/print/exportBook"
import { createBrowserExportPrinter, installExportPrintGuard } from "@/print/exportPrintBrowser"
import "@/print/exportA5.css"
const router = useRouter(), route = useRoute()
const kind = ref<ExportScope['kind']>('all'), entryScope = ref(''), day = ref(''), month = ref(''), year = ref(''), from = ref(''), to = ref(''), title = ref('青简')
const inheritedFilters = shallowRef<ExportFilters>(), handoffNotice = ref(''), error = ref(''), changed = ref(false), initializing = ref(true)
const handoffNeedsConfirmation = ref(false), replacementConfirmed = ref(false)
const phase = ref<'select' | 'capturing' | 'review' | 'layout' | 'preview'>('select'), checked = shallowRef<ExportCheckedSnapshot>()
const scopeConfirmed = ref(false), degradedConfirmed = ref(false), previewConfirmed = ref(false), printState = ref<ExportPrintState>('idle')
const mode = ref<ExportOutputMode>('a5'), fontMode = ref<ExportFontMode>('wenkai'), progress = ref('尚未读取日记。'), previewHost = ref<HTMLElement>()
const mapping = shallowRef<Awaited<ReturnType<typeof prepareExportBook>>['mapping']>(), logicalPages = ref(0), tocPages = ref(0)
const modes: {value: ExportOutputMode; label: string}[] = [{value:'a5',label:'A5 顺序页'}, {value:'spread',label:'A4 顺序双页'}, {value:'booklet',label:'A4 折叠拼版'}]
const printing = computed(() => printState.value === 'printing' || printState.value === 'checking')
const busy = computed(() => phase.value === 'capturing' || phase.value === 'layout' || printing.value)
const reviewAllowed = computed(() => !!checked.value?.snapshot.entries.length && scopeConfirmed.value && (!checked.value.review.issueCount || degradedConfirmed.value))
const capturedRange = computed(() => { const entries = checked.value?.snapshot.entries; return entries?.length ? `${entries[0]!.entryDate} 至 ${entries.at(-1)!.entryDate}` : '空范围' })
let generation = 0, unmounted = false, controller: AbortController | undefined
let preflight: Awaited<ReturnType<typeof createVerifiedExportPreflightTask>> | undefined, documentTask: ReturnType<typeof createExportDocumentTask> | undefined
let book: Awaited<ReturnType<typeof prepareExportBook>> | undefined, printer: ReturnType<typeof createBrowserExportPrinter> | undefined, guard: ReturnType<typeof installExportPrintGuard> | undefined, stopStatus: (() => void) | undefined
const isCurrent = (n: number) => !unmounted && n === generation
function clearLayout() { printer?.close(); printer = undefined; book?.release(); book = undefined; documentTask?.close(); documentTask = undefined; mapping.value = undefined; previewConfirmed.value = false; printState.value = 'idle' }
function dispose() { generation++; controller?.abort(); controller = undefined; stopStatus?.(); stopStatus = undefined; clearLayout(); preflight?.close(); preflight = undefined; checked.value = undefined; scopeConfirmed.value = false; degradedConfirmed.value = false; changed.value = false }
function resetSelection() { dispose(); phase.value = 'select'; progress.value = '尚未读取日记。'; error.value = '' }
function cancelWork() { resetSelection(); progress.value = '已停止并清空本次快照与预览。' }
function invalidated() { dispose(); inheritedFilters.value = undefined; entryScope.value = ''; title.value = '青简'; kind.value = 'all'; handoffNotice.value = ''; handoffNeedsConfirmation.value = true; replacementConfirmed.value = false; phase.value = 'select'; error.value = '账号、登录或本机宿主状态已变化。本次快照与预览已清除；请核验登录后重新读取。'; progress.value = '已停止输出；无法撤回已交给系统的打印内容。' }
function request(): ExportSelectionRequest {
  const scope: ExportScope = kind.value === 'entry' ? {kind:'entry',id:entryScope.value} : kind.value === 'day' ? {kind:'day',date:day.value} : kind.value === 'month' ? {kind:'month',month:month.value} : kind.value === 'year' ? {kind:'year',year:year.value} : kind.value === 'range' ? {kind:'range',from:from.value,to:to.value} : {kind:'all'}
  const value = {scope, ...(inheritedFilters.value ? {filters:inheritedFilters.value} : {})}; compileExportSelection(value); return value
}
function explain(cause: unknown) {
  const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : ''
  if (code.includes('FONT')) return '字体准备失败，未自动换字。可明确选择系统字体重新排版，或稍后重试。'
  if (code.includes('BOOK_TITLE')) return '封面书名最多 120 个字符，请缩短后重试。'
  if (code.includes('LIMIT') || code.includes('BUDGET')) return '本次内容超过安全保护上限；请缩小范围后重试，不会自动截断。'
  if (code.includes('TIMEOUT')) return '准备超时，尚未允许打印。请缩小范围或稍后重试。'
  if (code.includes('SCOPE') || code.includes('DATE') || code.includes('SELECTION') || code.includes('YEAR') || code.includes('MONTH')) return '请检查范围和日期：日期须有效，起始不能晚于结束。'
  if (code.includes('PRINT')) return '浏览器未能打开打印功能。请关闭可能残留的对话框，再重试；未标记为成功。'
  return '本次准备未完成，尚未允许打印。请核验当前登录、缩小范围或重新读取后重试。'
}
async function capture() {
  if (busy.value || initializing.value || (handoffNeedsConfirmation.value && !replacementConfirmed.value)) return
  let selection: ExportSelectionRequest
  try { selection = request() } catch (cause) { error.value = explain(cause); return }
  dispose(); const n = generation; controller = new AbortController(); phase.value = 'capturing'; error.value = ''; progress.value = '核验身份并读取本机已保存内容…'
  try {
    const task = await createVerifiedExportPreflightTask(() => { if (isCurrent(n)) invalidated() })
    if (!isCurrent(n)) { task.close(); return }; preflight = task
    stopStatus = task.subscribe(status => { if (!isCurrent(n)) return; if (status.state === 'closed') { invalidated(); return }; changed.value = status.changed; if (status.state === 'checking-images') progress.value = '快照已固定，正在检查图片…' })
    if (!isCurrent(n)) return
    await task.run(selection, controller?.signal); if (!isCurrent(n)) return
    const result = await task.read(); if (!isCurrent(n)) return
    checked.value = result; changed.value = result.changed; phase.value = 'review'; progress.value = '范围与图片检查完成，请核对数量及诊断。'
  } catch (cause) { if (isCurrent(n)) { dispose(); phase.value = 'select'; error.value = explain(cause); progress.value = '未生成预览。' } }
}
async function prepare(font: ExportFontMode) {
  const task = preflight, result = checked.value, host = previewHost.value
  if (busy.value || !reviewAllowed.value || !task || !result || !host) return
  clearLayout(); const n = generation; phase.value = 'layout'; error.value = ''; progress.value = '准备字体、分页与目录…'; fontMode.value = font
  const source = createExportDocumentTask(task, prepareBrowserExportFonts); documentTask = source
  try {
    const contentMode = result.review.issueCount ? 'degraded' : 'full'
    if (contentMode === 'degraded') await task.confirmDegraded(result.review)
    if (!isCurrent(n)) return
    await source.prepare(contentMode, result.review, font, controller?.signal, {title:title.value}); if (!isCurrent(n)) return
    const layout = await prepareExportBook(source, host, {signal:controller?.signal,mode:mode.value})
    if (!isCurrent(n)) { layout.release(); return }; book = layout
    await layout.assertCurrent(); if (!isCurrent(n)) return
    if (!layout.sourceCoverageChecked) throw new Error('coverage')
    logicalPages.value = layout.logicalPages; tocPages.value = layout.tocPages; mapping.value = layout.mapping
    printer = createBrowserExportPrinter(layout.root, async () => { if (!isCurrent(n) || !previewConfirmed.value || !scopeConfirmed.value || !reviewAllowed.value) throw new Error('confirmation'); await layout.assertCurrent(); if (!isCurrent(n)) throw new Error('stale') }, state => {
      if (!isCurrent(n)) return
      printState.value = state
      if (state === 'checking') progress.value = '正在核对当前预览…'
      if (state === 'printing') progress.value = '已请求浏览器打印，等待对话框返回。'
      if (state === 'returned') progress.value = '打印对话框已返回；保存或打印结果请自行核对。'
      if (state === 'acknowledged') progress.value = '已按你的确认返回预览；打印结果未知。'
      if (state === 'failed') progress.value = '未确认打印对话框结果，请检查浏览器设置后重试。'
    }, guard)
    phase.value = 'preview'; progress.value = '预览已准备；尚未请求打印。请检查纸页后确认。'
  } catch (cause) { if (isCurrent(n)) { clearLayout(); phase.value = 'review'; error.value = explain(cause); progress.value = '排版未完成，打印仍被阻止。' } }
}
async function switchMode(value: ExportOutputMode) {
  const layout = book, n = generation; if (busy.value || !layout || value === mode.value) return
  phase.value = 'layout'; previewConfirmed.value = false; error.value = ''
  try { const next = await layout.setMode(value); if (!isCurrent(n)) return; mode.value = value; mapping.value = next; phase.value = 'preview'; progress.value = '纸张映射已更新，请重新确认预览。' }
  catch (cause) { if (isCurrent(n)) { clearLayout(); phase.value = 'review'; error.value = explain(cause) } }
}
function reprepare() { if (busy.value) return; clearLayout(); phase.value = 'review'; progress.value = '仍保留原快照；请选择字体重新排版。' }
async function print() { const n = generation, active = printer; if (!active || busy.value || !previewConfirmed.value) return; error.value = ''; try { await active.request() } catch (cause) { if (isCurrent(n)) error.value = explain(cause) } }
function acknowledgePrint() { if (window.confirm('请确认系统打印对话框已经关闭。应用无法判断是否保存或打印。')) printer?.acknowledgeClosed() }
onMounted(async () => {
  guard = installExportPrintGuard()
  const n = generation
  if (route.query.from === 'list' || route.query.from === 'entry') {
    try {
      const scope = await captureNotebookScope()
      // Check before consuming the one-use capsule: this mount may have left
      // while the owner read was pending, and another entry may now own it.
      if (!isCurrent(n)) return
      const capsule = takeExportHandoff(scope)
      if (capsule) { inheritedFilters.value = capsule.filters; if (capsule.scope.kind === 'entry') { kind.value = 'entry'; entryScope.value = capsule.scope.id }; handoffNotice.value = capsule.scope.kind === 'entry' ? '从单篇进入：只读取这一简的本机已保存版本。' : '已带入列表进入时的筛选；下方范围与其取交集。' }
      else { handoffNeedsConfirmation.value = true; handoffNotice.value = '原入口的范围交接已过期或账号已变化。未读取任何简，请返回原入口重选，或明确重新选择下方范围。' }
    } catch { if (isCurrent(n)) { handoffNeedsConfirmation.value = true; handoffNotice.value = '无法恢复原入口范围。未读取任何简，请核验登录后重新选择。' } }
  }
  if (isCurrent(n)) initializing.value = false
})
onBeforeRouteLeave(() => { if (printing.value && !window.confirm('打印对话框可能仍在使用本次内容。离开将清除应用预览，但不能撤回系统已取得的内容。仍要离开？')) return false; dispose() })
function pageHidden() { dispose(); initializing.value = false; inheritedFilters.value = undefined; title.value = '青简'; entryScope.value = ''; kind.value = 'all'; handoffNotice.value = ''; handoffNeedsConfirmation.value = true; replacementConfirmed.value = false; phase.value = 'select'; progress.value = '页面已离开，本次内容已释放。需要时请重新读取。' }
window.addEventListener('pagehide', pageHidden)
onBeforeUnmount(() => { unmounted = true; window.removeEventListener('pagehide', pageHidden); dispose(); guard?.close(); guard = undefined })
</script>

<style scoped>
.export-page{max-width:1060px;margin:0 auto;padding:24px;color:var(--color-ink,#2e2c28);font:16px/1.65 system-ui,sans-serif;overflow-wrap:anywhere}
.export-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.export-head span{font-size:12px;letter-spacing:.16em;color:#426455}h1{font:400 30px/1.4 var(--font-cn-serif,serif);margin:24px 0 12px}h2{font:400 22px/1.4 var(--font-cn-serif,serif);margin:0 0 16px}h3{font-size:16px;margin:12px 0 4px}.intro{max-width:720px;margin-bottom:24px}
.export-card{background:var(--color-paper-deep,#f4efe5);border:1px solid #c4bcb0;border-radius:8px;padding:24px;margin:16px 0}p{margin:12px 0}.small{font-size:14px;color:#58554e}fieldset{border:0;padding:0;margin:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}label{display:flex;flex-direction:column;gap:6px;min-width:0}input,select,button{font:inherit;color:inherit}input:not([type=checkbox]),select{width:100%;min-width:0;min-height:44px;border:1px solid #a79e90;border-radius:6px;background:#fcfaf5;padding:8px 10px}.fields{display:flex;gap:12px;grid-column:1/-1}.fields label{flex:1}.check{display:flex;flex-direction:row;align-items:flex-start;margin:16px 0;gap:10px;cursor:pointer;min-height:44px}.check input{width:20px;height:20px;flex-shrink:0;margin-top:4px;accent-color:#426455}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}button{min-height:44px;padding:9px 16px;border:1px solid #a79e90;border-radius:6px;background:#fcfaf5;cursor:pointer}.primary{background:#426455;color:white;border-color:#426455}button:disabled,fieldset:disabled{opacity:.6;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,.preview-scroll:focus-visible{outline:3px solid #426455;outline-offset:3px}.warning,.notice{padding:12px 16px;border-left:3px solid #8a4c30;background:#f6e9db;color:#513b2b}.notice{border-color:#426455;background:#e5ebe4;color:#294537}summary{cursor:pointer;min-height:44px;padding:8px 0}.diagnostic{border-top:1px solid #c4bcb0;padding:8px 0}.filter-summary{border-bottom:1px solid #c4bcb0;padding-bottom:8px}.progress{min-height:28px}.preview-region{margin:24px 0}.preview-measure{position:absolute;left:-30000px;top:0;visibility:hidden;pointer-events:none}.preview-scroll{max-width:100%;overflow:auto;padding:16px;background:#ded7ca;border:1px solid #b7ae9e}.preview-scroll :deep(.quire-print-root){width:max-content;min-width:100%}
@media(max-width:600px){.export-page{padding:16px}.export-card{padding:16px}fieldset{grid-template-columns:1fr}.fields{flex-direction:column}.export-head span{font-size:11px}h1{font-size:26px}.actions button{flex-grow:1}}
</style>
