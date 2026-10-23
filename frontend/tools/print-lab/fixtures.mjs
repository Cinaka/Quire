// Fixed public/non-private material; never imports the app, auth, DB or user diary.
export const entries = [
  { id: 'rain', date: '2026-10-21', title: '雨后记事，一编青简', blocks: [
    { type: 'p', text: '山色入窗，夜雨初歇。今日把零散的心事收拢，编成一简。纸张有界，文字仍须完整：不裁切，不漏行，不因翻到下一页而改写昨日。'.repeat(9) + '【长段落终点】' },
    { type: 'quote', text: '一编青简，半生浮沉。\n硬换行仍在，句读不应丢失。' },
    { type: 'li', number: 3, text: '列表从第三项开始，跨页也不重置。' },
    { type: 'li', number: 4, text: '保留第四项及其自然顺序，不修改原文。' },
  ] },
  { id: 'code', date: '2026-10-22', title: '长代码与无空格词', blocks: [
    { type: 'code', text: 'const diary = "local-first";\n' + Array.from({ length: 18 }, (_, i) => `line_${i + 1}: ${'long_word_'.repeat(9)}`).join('\n') + '\n// CODE_END_42' },
    { type: 'p', text: 'long_word_'.repeat(60) + ' WORD_END_43' },
  ] },
  { id: 'image', date: '2026-10-23', title: '一张长图，完整而不裁切', blocks: [
    { type: 'p', text: '下图是固定的非私人校准图；四边和上下标记必须完整可见。它不是实际媒体读取或像素安全预检的验收。' },
    { type: 'image', alt: '固定长图：TOP / BOTTOM', caption: '图 1 · 整图等比缩放，不裁边' },
    { type: 'p', text: '杀青之后，原简仍留在本机。PRINT_END_44' },
  ] },
]
export const sourceText = () => entries.flatMap(e => e.blocks.filter(b => b.type !== 'image').map(b => b.text)).join('')
