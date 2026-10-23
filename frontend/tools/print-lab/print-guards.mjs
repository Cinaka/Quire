// P6-0 lab contracts only. Not imported by the production app; not a capacity guarantee.
export const LIMITS = Object.freeze({ entries: 100, textBytes: 4 * 1024 ** 2, mediaBytes: 64 * 1024 ** 2, logicalPages: 300, nodes: 20000 })
export class PrintLabError extends Error {
  constructor(code) { super(code); this.name = 'PrintLabError'; this.code = code }
}
export function assertBudget(stats) {
  for (const [key, limit] of Object.entries(LIMITS)) {
    const n = stats[key]
    if (!Number.isSafeInteger(n) || n < 0) throw new PrintLabError(`INVALID_${key}`)
    if (n > limit) throw new PrintLabError(`LIMIT_${key}`)
  }
}
// Relative body page numbers are immutable; cover occupies one page.
// A measure callback must use the exact candidate labels and must not mutate body starts.
export async function settleToc(bodyStarts, measure, { signal, now = () => performance.now() } = {}) {
  if (!bodyStarts.length || bodyStarts.length > LIMITS.entries || bodyStarts.some((n, i) => !Number.isSafeInteger(n) || n < 1 || n > LIMITS.logicalPages || (i && n < bodyStarts[i - 1]))) throw new PrintLabError('INVALID_BODY_STARTS')
  const starts = [...bodyStarts], began = now(), trace = [], seen = new Set()
  const check = () => {
    if (signal?.aborted) throw new PrintLabError('CANCELLED')
    if (now() - began > 20000) throw new PrintLabError('TIME_LIMIT')
  }
  let guess = 1
  for (let iteration = 1; iteration <= 8; iteration++) {
    check()
    if (seen.has(guess)) throw new PrintLabError('TOC_CYCLE')
    seen.add(guess)
    const labels = starts.map(n => n + 1 + guess)
    if (labels.at(-1) > LIMITS.logicalPages) throw new PrintLabError('LIMIT_logicalPages')
    const measured = await measure(Object.freeze(labels), signal)
    check() // A late result after cancellation/time limit must not become ready.
    const count = measured?.pageCount
    if (!Number.isSafeInteger(count) || count < 1) throw new PrintLabError('INVALID_TOC_COUNT')
    if (count + 1 + starts.at(-1) > LIMITS.logicalPages) throw new PrintLabError('LIMIT_logicalPages')
    trace.push({ iteration, guess, measured: count })
    if (count === guess) return { tocPages: count, labels, trace, value: measured.value }
    guess = count
  }
  throw new PrintLabError('TOC_ITERATION_LIMIT')
}
