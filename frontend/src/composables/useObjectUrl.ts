import { onScopeDispose, ref, watch, type Ref } from "vue"

/**
 * 把 Blob 转成能给 img 标签用的临时地址，并保证组件销毁时释放。
 *
 * 不释放的后果：每个 createObjectURL 都会让浏览器一直持有那份 Blob，
 * 页面不刷新就不回收。翻一百篇带图日记，内存能涨到几百 MB。
 */
export function useObjectUrl(source: Ref<Blob | null | undefined>): Ref<string> {
  const url = ref("")
  let current = ""

  const release = (): void => {
    if (current) {
      URL.revokeObjectURL(current)
      current = ""
    }
  }

  watch(
    source,
    (blob) => {
      release()
      current = blob ? URL.createObjectURL(blob) : ""
      url.value = current
    },
    { immediate: true },
  )

  onScopeDispose(release)

  return url
}
