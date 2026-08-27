import { readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Solar } from "lunar-typescript"

const toolsDir = path.dirname(new URL(import.meta.url).pathname)
const frontendDir = path.resolve(toolsDir, "../..")
const sourceDir = path.join(frontendDir, "src")
const sourceExtensions = new Set([".css", ".html", ".ts", ".vue"])
const printableAscii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join("")
const requiredPunctuation = "，。！？；：、‘’“”（）《》〈〉【】〔〕「」『』—·…／＋－"
const handText = "今日无事，也可留白"

function collectChars(target, value) {
  for (const char of value) target.add(char)
}

async function walk(directory) {
  const files = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, item.name)
    if (item.isDirectory()) files.push(...await walk(fullPath))
    else if (sourceExtensions.has(path.extname(item.name))) files.push(fullPath)
  }
  return files
}

function localDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

function addUtcDays(startYear, offset) {
  const date = new Date(Date.UTC(startYear, 0, 1 + offset))
  return localDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function almanacSnapshot(date) {
  const [year, month, day] = date.split("-").map(Number)
  const solar = Solar.fromYmd(year, month, day)
  const lunar = solar.getLunar()
  return [
    date,
    solar.getWeekInChinese(),
    lunar.toString(),
    lunar.getMonthInChinese(),
    lunar.getDayInChinese(),
    lunar.getYearInGanZhi(),
    lunar.getYearShengXiao(),
    lunar.getJieQi(),
    ...lunar.getFestivals(),
    ...solar.getFestivals(),
    lunar.getZhiXing(),
    ...lunar.getDayYi(),
    ...lunar.getDayJi(),
    lunar.getDayInGanZhi(),
    lunar.getDayPositionTai(),
    lunar.getGong(),
    lunar.getXiu(),
    lunar.getZheng(),
    lunar.getAnimal(),
    lunar.getXiuLuck(),
    lunar.getDayNaYin(),
    lunar.getDayShengXiao(),
    lunar.getDayChongDesc(),
    lunar.getDayChongShengXiao(),
    lunar.getDaySha(),
    lunar.getPengZuGan(),
    lunar.getPengZuZhi(),
  ]
}

const almanacChars = new Set()
const windowResults = []
let stableWindows = 0
for (let year = 2026; year <= 2070; year += 4) {
  const windowChars = new Set()
  for (let offset = 0; offset < 400; offset += 1) {
    collectChars(windowChars, JSON.stringify(almanacSnapshot(addUtcDays(year, offset))))
  }
  const added = [...windowChars].filter((char) => !almanacChars.has(char))
  collectChars(almanacChars, [...windowChars].join(""))
  windowResults.push({ year, size: windowChars.size, added })
  stableWindows = added.length === 0 && windowResults.length > 1 ? stableWindows + 1 : 0
  if (year >= 2034 && stableWindows >= 2) break
}

if (stableWindows < 2) {
  const last = windowResults.at(-1)
  throw new Error(`截至 ${last?.year} 年仍未得到连续两个无新增字符的窗口`)
}

const kaiChars = new Set()
collectChars(kaiChars, printableAscii)
collectChars(kaiChars, requiredPunctuation)
collectChars(kaiChars, [...almanacChars].join(""))

for (const file of await walk(sourceDir)) {
  const text = await readFile(file, "utf8")
  for (const match of text.matchAll(/[\p{Script=Han}\u3000-\u303f\uff00-\uffef\u2010-\u2027]/gu)) {
    kaiChars.add(match[0])
  }
}

const sortedKai = [...kaiChars].sort((left, right) => left.codePointAt(0) - right.codePointAt(0))
const sortedHand = [...new Set(handText)].sort((left, right) => left.codePointAt(0) - right.codePointAt(0))
await writeFile(path.join(toolsDir, "kai-chars.txt"), `${sortedKai.join("")}\n`, "utf8")
await writeFile(path.join(toolsDir, "hand-chars.txt"), `${sortedHand.join("")}\n`, "utf8")

for (const { year, size, added } of windowResults) {
  console.log(`${year}-01-01 起 400 天：${size} 个字符，较此前新增 ${added.length}`)
}
console.log(`kai-chars.txt：${sortedKai.length} 个字符`)
console.log(`hand-chars.txt：${sortedHand.length} 个字符（${handText}）`)
