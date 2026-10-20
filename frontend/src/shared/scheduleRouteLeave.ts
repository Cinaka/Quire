/** 路由只请求现有宿主协商，不保存/弃去数据，也不记住目的地自动重放导航。 */
export interface ScheduleRouteHost {
  prepareLeave(): Promise<boolean>
}
export function createScheduleRouteLeave(getHost: () => ScheduleRouteHost | null) {
  let busy = false
  let disposed = false
  let error = ""
  return {
    inspect() { return { busy, disposed, error } },
    async attempt(): Promise<boolean> {
      if (disposed || busy) return false
      busy = true; error = ""
      try {
        const host = getHost()
        if (!host) { error = "预简页面尚未就绪，请稍后重试。"; return false }
        const allowed = await host.prepareLeave()
        if (disposed || getHost() !== host) return false
        if (allowed !== true) error = "请先在编辑区处理未保存输入或等待操作结束，再点击导航离开。"
        return allowed === true
      } catch {
        if (!disposed) error = "离开检查未完成，已保留当前页面；请检查编辑区后重试。"
        return false
      } finally { busy = false }
    },
    dispose(): void { disposed = true },
  }
}
