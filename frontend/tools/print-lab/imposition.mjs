/** Lab-only candidate; not a production export API. Numbers are 1-based; null is a blank. */
export function impose(count, mode) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 300) throw Error('logical pages must be 1..300')
  const page = number => number <= count ? number : null
  if (mode === 'a5') return Array.from({ length: count }, (_, i) => [i + 1])
  if (mode === 'spread') return Array.from({ length: Math.ceil(count / 2) }, (_, i) => [page(2 * i + 1), page(2 * i + 2)])
  if (mode !== 'booklet') throw Error('unknown output mode')
  const padded = Math.ceil(count / 4) * 4, sheets = []
  for (let k = 0; k < padded / 4; k++) {
    sheets.push([page(padded - 2 * k), page(1 + 2 * k)])
    sheets.push([page(2 + 2 * k), page(padded - 1 - 2 * k)])
  }
  return sheets
}
