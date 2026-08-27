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
