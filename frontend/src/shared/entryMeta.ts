export interface EntryMetaOption {
  value: string
  label: string
}

export const MOOD_OPTIONS: readonly EntryMetaOption[] = [
  { value: "😊", label: "欣然" },
  { value: "😌", label: "安然" },
  { value: "🥰", label: "欢喜" },
  { value: "🤔", label: "沉思" },
  { value: "😴", label: "疲倦" },
  { value: "😔", label: "低落" },
  { value: "😢", label: "难过" },
  { value: "😤", label: "烦闷" },
] as const

export const WEATHER_OPTIONS: readonly EntryMetaOption[] = [
  { value: "☀️", label: "晴" },
  { value: "🌤️", label: "少云" },
  { value: "☁️", label: "阴" },
  { value: "🌫️", label: "雾" },
  { value: "🌦️", label: "阵雨" },
  { value: "🌧️", label: "雨" },
  { value: "⛈️", label: "雷雨" },
  { value: "❄️", label: "雪" },
] as const

/**
 * 列表 / 首页摘要位的文案。真文本优先；整篇只有图时才用张数兜底。
 *
 * 注意它<b>只用于展示</b>，绝不能写回 Entry.contentText —— 那个字段必须
 * 严格由 content 派生（铁律 1），塞进「4 张图片」会污染搜索索引。
 */
export function entryExcerpt(contentText: string, imageCount = 0): string {
  const text = contentText.replace(/\s+/g, " ").trim()
  if (text) return text
  if (imageCount > 0) return `${imageCount} 张图片`
  return ""
}
