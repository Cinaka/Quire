const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { loadTS } = require("./schedules-harness.cjs")
const { ID, AT, content, entry } = require("./schedules-data-harness.cjs")
const createEditor = loadTS("shared/scheduleDiaryEditor.ts").createScheduleDiaryEditor
const { createScheduleDiaryPanel: createPanel, diaryPanelBodyMode: mode } = loadTS("shared/scheduleDiaryPanel.ts")
const TODAY = "2026-10-08"
const image = { schemaVersion: 1, doc: { type: "doc", content: [{ type: "image", attrs: { src: "local://media/held" } }] } }
const copy = value => structuredClone(value)
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
function harness(extra = {}) {
  let target = { entry: entry({ entryDate: TODAY, ...extra }), lease: { id: ID, fromScheduleId: ID, clientUpdatedAt: AT } }
  let error = null; const patches = []; let validates = 0; let revision = 0
  const port = { async validate() { validates++; if (error) throw error }, async save(lease, patch) {
    if (error) throw error
    assert.deepEqual(copy(lease), target.lease); patches.push(copy(patch)); revision++
    const updatedAt = `2026-10-08T10:00:00.${String(revision).padStart(3, "0")}Z`
    target = { entry: { ...target.entry, ...copy(patch), clientUpdatedAt: updatedAt }, lease: { ...lease, clientUpdatedAt: updatedAt } }; return copy(target)
  } }
  const session = createEditor(target, port, () => TODAY); const panel = createPanel(session)
  return { port, session, panel, patches, target: () => copy(target), validates: () => validates, fail(value) { error = value } }
}
const source = file => fs.readFileSync(path.join(__dirname, "../src", file), "utf8")

test("panel classifies compatible text without writing or changing initial source", () => {
  const h = harness(); const before = h.target(); assert.equal(h.panel.inspect().bodyMode, "text")
  assert.equal(mode(null), "text"); assert.equal(mode(content("text")), "text"); assert.deepEqual(h.target(), before); assert.equal(h.patches.length, 0)
})
test("image or unsupported/unknown body data stays retained rather than being silently passed through the text editor", () => {
  for (const value of [image, { ...content("too new"), schemaVersion: 2 }, { schemaVersion: 1, doc: { type: "doc", unknown: "held" } },
    { schemaVersion: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { custom: "held" } }] } },
    { schemaVersion: 1, doc: { type: "doc", content: [{ type: "text", text: "held", marks: [{ type: "bold", attrs: { custom: true } }] }] } }]) assert.equal(mode(value), "retained")
})
test("known heading/list/code attributes stay editable but malformed attributes are retained", () => {
  for (const node of [{ type: "heading", attrs: { level: 2 } }, { type: "orderedList", attrs: { start: 3 } }, { type: "codeBlock", attrs: { language: "js" } }]) assert.equal(mode({ schemaVersion: 1, doc: { type: "doc", content: [node] } }), "text")
  for (const node of [{ type: "orderedList", attrs: { start: "3" } }, { type: "orderedList", attrs: { start: -1 } }, { type: "codeBlock", attrs: { language: true } }]) assert.equal(mode({ schemaVersion: 1, doc: { type: "doc", content: [node] } }), "retained")
})
test("a retained image body allows metadata-only save and preserves exact original content and tag IDs", async () => {
  const h = harness({ content: image, tagIds: ["held"] }); const original = h.target().entry.content
  assert.equal(h.panel.inspect().bodyMode, "retained"); assert.equal(h.panel.changeContent(content("replacement")), false)
  assert.equal(h.panel.changeMetadata({ title: "只改题", mood: "喜" }), true); assert.equal(await h.panel.save(), true)
  assert.deepEqual(h.patches, [{ title: "只改题", mood: "喜" }]); assert.deepEqual(h.target().entry.content, original); assert.deepEqual(h.target().entry.tagIds, ["held"])
})
test("panel rejects metadata attempts to replace body/source/tags rather than bypassing the dedicated content boundary", () => {
  const h = harness(); const before = h.session.inspect()
  for (const patch of [{ content: image }, { fromScheduleId: null }, { tagIds: ["not wired"] }, { isDeleted: 1 }]) assert.equal(h.panel.changeMetadata(patch), false)
  assert.deepEqual(h.session.inspect(), before)
})
test("text changes remain runtime-only until explicit save, preserve formatting and update through the protected session", async () => {
  const h = harness(); const next = { schemaVersion: 1, doc: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "格式", marks: [{ type: "bold" }] }] }] } }
  assert.equal(h.panel.changeContent(next), true); assert.equal(h.patches.length, 0); assert.equal(h.panel.inspect().editor.dirty, true)
  assert.equal(await h.panel.save(), true); assert.deepEqual(h.target().entry.content, next); assert.equal(h.panel.inspect().editor.dirty, false)
})
test("text editor errors block saves and clean leave, and unrelated metadata cannot clear the unconfirmed body error", async () => {
  const h = harness(); h.panel.editorInvalid("未确认正文")
  assert.equal(await h.panel.save(), false); assert.equal(await h.panel.prepareLeave(), false); assert.equal(h.panel.inspect().leavePrompt, true)
  h.panel.changeMetadata({ title: "改题" }); assert.equal(h.panel.inspect().editorError, "未确认正文"); assert.equal(await h.panel.save(), false)
  assert.equal(h.panel.changeContent(content("明确修正")), true); assert.equal(h.panel.inspect().editorError, ""); assert.equal(await h.panel.save(), true)
})
test("unsupported new content does not replace the original editable body or permit old content to be submitted as latest", async () => {
  const h = harness(); const before = h.session.inspect().body.content; assert.equal(h.panel.changeContent(image), false)
  assert.deepEqual(h.session.inspect().body.content, before); assert.equal(await h.panel.save(), false); assert.equal(await h.panel.prepareLeave(), false)
})
test("composition accepts runtime input but blocks save, leave and confirmed discard until ending", async () => {
  const h = harness(); h.panel.setComposing(true)
  assert.equal(h.panel.changeMetadata({ title: "中文输入" }), true); assert.equal(h.panel.changeContent(content("中文正文")), true)
  assert.equal(await h.panel.save(), false); assert.equal(await h.panel.prepareLeave(), false); assert.equal(h.panel.requestDiscard(), false)
  assert.equal(h.panel.needsLeaveConfirmation(), true); assert.equal(h.patches.length, 0)
  h.panel.setComposing(false); assert.equal(await h.panel.save(), true)
})
test("dirty return opens a non-destructive prompt and cancellation keeps exact input", async () => {
  const h = harness(); h.panel.changeMetadata({ title: "保留" }); const before = h.target()
  assert.equal(await h.panel.prepareLeave(), false); assert.equal(h.panel.inspect().leavePrompt, true)
  h.panel.cancelPrompt(); assert.equal(h.panel.inspect().leavePrompt, false); assert.equal(h.panel.inspect().editor.body.title, "保留")
  assert.deepEqual(h.target(), before); assert.equal(h.patches.length, 0)
})
test("save-and-return writes once then closes only after the protected save succeeds", async () => {
  const h = harness(); h.panel.changeMetadata({ title: "保存返回" }); await h.panel.prepareLeave()
  assert.equal(await h.panel.saveAndLeave(), true); assert.equal(h.patches.length, 1); assert.equal(h.panel.inspect().editor.closed, true)
  assert.equal(h.panel.inspect().leavePrompt, false); assert.equal(await h.panel.save(), false)
})
test("save failure keeps the return prompt, input and fixed lease instead of closing or reading a replacement target", async () => {
  const h = harness(); h.panel.changeMetadata({ title: "保留" }); await h.panel.prepareLeave(); h.fail(new Error("conflict"))
  assert.equal(await h.panel.saveAndLeave(), false); assert.equal(h.panel.inspect().leavePrompt, true)
  assert.equal(h.panel.inspect().editor.body.title, "保留"); assert.equal(h.panel.inspect().editor.closed, false); assert.equal(h.patches.length, 0)
})
test("discard requires two explicit steps and cancel does not affect stored content or pending input", () => {
  const h = harness(); h.panel.changeMetadata({ title: "待丢弃" }); const before = h.target()
  assert.equal(h.panel.confirmDiscard(), false); assert.equal(h.panel.requestDiscard(), true); h.panel.cancelPrompt()
  assert.equal(h.panel.confirmDiscard(), false); assert.equal(h.panel.inspect().editor.body.title, "待丢弃")
  h.panel.requestDiscard(); assert.equal(h.panel.confirmDiscard(), true); assert.equal(h.panel.inspect().editor.closed, true)
  assert.deepEqual(h.target(), before); assert.equal(h.patches.length, 0)
})
test("context expiry locks writes but retains a copyable body and allows explicit runtime-only discard", async () => {
  const h = harness(); h.panel.changeMetadata({ title: "复制我" }); h.session.invalidate("账号已变")
  assert.equal(h.panel.inspect().editor.expired, true); assert.match(h.panel.inputForCopy(), /复制我/)
  assert.equal(await h.panel.save(), false); assert.equal(await h.panel.prepareLeave(), false)
  assert.equal(h.panel.requestDiscard(), true); assert.equal(h.panel.confirmDiscard(), true); assert.equal(h.patches.length, 0)
})
test("view/input copy cannot mutate session data and contains metadata/structure but does not claim image-byte backup", () => {
  const h = harness({ content: image }); const state = h.panel.inspect(); state.editor.body.content.doc.content.length = 0
  assert.deepEqual(h.session.inspect().body.content, image); const copied = JSON.parse(h.panel.inputForCopy()); assert.deepEqual(copied.content, image)
})
test("panel unmount only detaches subscriptions, not save/discard/dispose of its parent's editor session", () => {
  const h = harness(); let signals = 0; h.panel.subscribe(() => { signals++ }); h.panel.changeMetadata({ title: "未存" }); h.panel.dispose()
  const before = signals; assert.equal(h.session.inspect().expired, false); assert.equal(h.session.change({ title: "仍在父会话" }), true)
  assert.equal(signals, before); assert.equal(h.patches.length, 0); assert.equal(h.panel.changeMetadata({ title: "ignored" }), false)
})
test("in-progress save prevents prompt/action races and reports unload protection", async () => {
  const h = harness(); const entered = gate(); const wait = gate(); const save = h.port.save
  h.port.save = async (...args) => { entered.release(); await wait.promise; return save(...args) }
  h.panel.changeMetadata({ title: "fixed" }); const task = h.panel.save(); await entered.promise
  assert.equal(h.panel.needsLeaveConfirmation(), true); assert.equal(h.panel.changeMetadata({ title: "late" }), false)
  assert.equal(await h.panel.prepareLeave(), false); assert.equal(h.panel.requestDiscard(), false); assert.equal(await h.panel.saveAndLeave(), false)
  wait.release(); assert.equal(await task, true); assert.equal(h.panel.needsLeaveConfirmation(), false)
})
test("visual panel uses fixed initial content, null-safe metadata events, composition generation and explicit confirmations", () => {
  const panel = source("components/schedules/ScheduleDiaryPanel.vue")
  assert.match(panel, /const initialContent = structuredClone/); assert.match(panel, /state.bodyMode === 'text'/)
  assert.match(panel, /diary-mode/); assert.match(panel, /readonly rows=/); assert.match(panel, /不是包含图片字节/)
  assert.match(panel, /compositionGeneration/); assert.match(panel, /await nextTick/); assert.match(panel, /明确弃去并返回/)
  assert.match(panel, /defineExpose\(\{ prepareLeave, needsLeaveConfirmation \}\)/)
  assert.doesNotMatch(panel, /router.push|fetch\(|\bDiaryEditor\b|upload|localStorage/)
})
test("hidden host opens a pinned editor, gates competing workspace actions, preserves expired panel and checks both leave guards", () => {
  const host = source("components/schedules/ScheduleHost.vue")
  assert.match(host, /host.openTargetEditor\(id\)/); assert.match(host, /workspaceRef.value\?\.canCompose/)
  assert.match(host, /fieldset v-show="!diarySession" :disabled="state.busy"/)
  assert.ok(host.indexOf("<ScheduleDiaryPanel") > host.indexOf("</template>\n    <!--"))
  assert.match(host, /:key="diaryKey"/); assert.match(host, /if \(diarySession.value !== next\) diaryKey.value \+= 1/)
  assert.match(host, /diaryRef.value.prepareLeave\(\)/); assert.match(host, /host.prepareTargetLeave\(\)/)
  assert.match(host, /addEventListener\("beforeunload"/); assert.match(host, /removeEventListener\("beforeunload"/)
  assert.doesNotMatch(host, /router.push|EntryEditView|target-ready/)
})
test("shared text editor's optional diary labels do not add image schema or change schedule default", () => {
  const editor = source("components/schedules/ScheduleTextEditor.vue")
  assert.match(editor, /diaryMode\?: boolean/); assert.match(editor, /props.diaryMode \? "日记正文" : "预简正文"/)
  assert.match(editor, /图片、标签、心情和天气请在转简后添加/)
  assert.match(editor, /handlePaste/); assert.match(editor, /handleDrop/); assert.doesNotMatch(editor, /LocalImage|mediaRepo|upload/)
})
test("the new panel remains absent from App, production router and placeholder ScheduleView", () => {
  for (const file of ["App.vue", "router/index.ts", "views/ScheduleView.vue"]) assert.doesNotMatch(source(file), /ScheduleHost|ScheduleDiaryPanel|scheduleDiaryPanel/)
})

test("expiry during composition unlocks explicit discard but never authorizes saving an unconfirmed final input", async () => {
  const h = harness(); h.panel.setComposing(true); h.panel.changeMetadata({ title: "已捕获输入" }); h.session.invalidate("restore")
  assert.equal(h.panel.inspect().composing, false); assert.match(h.panel.inspect().editorError, /可能未包含最后输入/)
  assert.equal(await h.panel.save(), false); assert.equal(await h.panel.prepareLeave(), false)
  assert.equal(h.panel.requestDiscard(), true); assert.equal(h.panel.confirmDiscard(), true); assert.equal(h.patches.length, 0)
})
