import { computed, onScopeDispose, ref, type Ref } from "vue"

const THRESHOLD = 64
const MAX_OFFSET = 96
const DAMPING = 0.45

export function usePullToRefresh(
  refresh: () => Promise<void>,
  loading: Readonly<Ref<boolean>>,
) {
  const distance = ref(0)
  const refreshing = ref(false)
  let tracking = false
  let startX = 0
  let startY = 0

  const pullStyle = computed(() => ({
    transform: `translateY(${distance.value}px)`,
  }))
  const ready = computed(() => distance.value >= THRESHOLD)

  function reset(): void {
    tracking = false
    startX = 0
    startY = 0
    distance.value = 0
  }

  function onTouchStart(event: TouchEvent): void {
    if (loading.value || refreshing.value || window.scrollY > 0 || event.touches.length !== 1) {
      reset()
      return
    }

    const touch = event.touches[0]
    tracking = true
    startX = touch.clientX
    startY = touch.clientY
  }

  function onTouchMove(event: TouchEvent): void {
    if (!tracking || event.touches.length !== 1 || window.scrollY > 0) {
      reset()
      return
    }

    const touch = event.touches[0]
    const deltaX = touch.clientX - startX
    const deltaY = touch.clientY - startY
    if (deltaY <= 0 || Math.abs(deltaY) <= Math.abs(deltaX)) {
      distance.value = 0
      return
    }

    distance.value = Math.min(MAX_OFFSET, deltaY * DAMPING)
    event.preventDefault()
  }

  async function onTouchEnd(): Promise<void> {
    if (!tracking) return
    const shouldRefresh = ready.value && !loading.value && !refreshing.value
    tracking = false

    if (!shouldRefresh) {
      distance.value = 0
      return
    }

    refreshing.value = true
    try {
      await refresh()
    } finally {
      refreshing.value = false
      distance.value = 0
    }
  }

  function onTouchCancel(): void {
    reset()
  }

  onScopeDispose(reset)

  return {
    distance,
    ready,
    refreshing,
    pullStyle,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  }
}
