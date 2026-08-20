import { onScopeDispose, ref, type Ref } from "vue"

/**
 * 响应式媒体查询。
 *
 * 用 matchMedia 而不是监听 resize：前者只在跨越阈值时触发一次，
 * 后者拖动窗口会触发几百次。
 */
export function useBreakpoint(query: string): Ref<boolean> {
  const matches = ref(false)

  // SSR 或小程序环境下没有 matchMedia，直接返回 false，不报错
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return matches
  }

  const mql = window.matchMedia(query)
  matches.value = mql.matches

  const onChange = (e: MediaQueryListEvent): void => {
    matches.value = e.matches
  }

  mql.addEventListener("change", onChange)
  onScopeDispose(() => mql.removeEventListener("change", onChange))

  return matches
}

/** 768px 是我们约定的 PC / 移动分界线 */
export function useIsDesktop(): Ref<boolean> {
  return useBreakpoint("(min-width: 768px)")
}
