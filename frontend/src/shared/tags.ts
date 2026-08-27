/** 只用于比较 / 去重；展示名仍保留首次创建时的 trim 后文本。 */
export function normalizeTagName(name: string): string {
  return name.trim().toLowerCase()
}
