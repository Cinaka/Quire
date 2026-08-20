/**
 * 原始词条 → 日记场景用语。
 *
 * 只有一张表：同一个词无论出现在宜还是忌，都映射成同一个标签。
 * 这是刻意的——「祈福」在破日出现在忌里，在祭祀日出现在宜里，
 * 语义始终是「静思」，变的只是宜还是忌。
 */
const WORD_LABEL: Record<string, string> = {
  // 静思
  "祭祀": "静思",
  "祈福": "静思",
  "斋醮": "静思",
  "设醮": "静思",
  "沐浴": "静思",
  "安香": "静思",

  // 访友
  "会亲友": "访友",
  "宴会": "访友",
  "进人口": "访友",
  "纳采": "访友",
  "订盟": "访友",
  "嫁娶": "访友",

  // 远游
  "出行": "远游",
  "出火": "远游",
  "移徙": "远游",
  "归宁": "远游",

  // 谋事
  "开市": "谋事",
  "交易": "谋事",
  "立券": "谋事",
  "纳财": "谋事",
  "求嗣": "谋事",

  // 读书
  "入学": "读书",
  "冠带": "读书",
  "裁衣": "读书",

  // 整理
  "扫舍": "整理",
  "除服": "整理",
  "解除": "整理",
  "平治道涂": "整理",
  "修饰垣墙": "整理",

  // 断舍
  "破屋": "断舍",
  "坏垣": "断舍",
  "拆卸": "断舍",

  // 安居
  "入宅": "安居",
  "安床": "安居",

  // 养息
  "治病": "养息",
  "求医": "养息",

  // 争执
  "词讼": "争执",
  "出师": "争执",
}

/** 总括词：不是具体事项，而是「其余诸事皆不宜」。含异体字写法 */
const RESTRICTED_WORDS = ["馀事勿取", "余事勿取", "诸事不宜"]

/**
 * 建除十二值星的基调。
 *
 * 词典全不命中时的兜底。值星每天必有值、只有 12 种取值，
 * 所以这张表能保证首页永远有话说，且是有依据的话。
 */
const ZHI_XING_TONE: Record<string, string> = {
  "建": "宜开创",
  "除": "宜清理",
  "满": "宜圆满",
  "平": "宜平常",
  "定": "宜安定",
  "执": "宜坚守",
  "破": "宜断旧",
  "危": "宜谨慎",
  "成": "宜成事",
  "收": "宜收敛",
  "开": "宜开端",
  "闭": "宜静守",
}

/**
 * 把原始词条映射成日记场景用语。
 *
 * 按原始顺序遍历、去重、最多 3 条——首页空间有限，多了反而没人看。
 * 全不命中时返回空数组，由调用方用 zhiXingTone 兜底。
 */
export function mapTaboo(words: string[]): string[] {
  const hit: string[] = []

  for (const w of words) {
    const label = WORD_LABEL[w]
    if (label && !hit.includes(label)) hit.push(label)
    if (hit.length >= 3) break
  }

  return hit
}

/** 当天是否出现「馀事勿取」这类总括词 */
export function isRestricted(words: string[]): boolean {
  return words.some((w) => RESTRICTED_WORDS.includes(w))
}

/** 取值星基调，未知值星退回「宜随心」 */
export function zhiXingTone(zhiXing: string): string {
  return ZHI_XING_TONE[zhiXing] ?? "宜随心"
}

/* ===== 时辰吉凶：黄黑道十二神 ===== */

const HOUR_ZHI = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"]

/** 十二神固定顺序，从青龙起循环 */
const DAO_GODS = [
  "青龙",
  "明堂",
  "天刑",
  "朱雀",
  "金匮",
  "天德",
  "白虎",
  "玉堂",
  "天牢",
  "玄武",
  "司命",
  "勾陈",
]

/** 六黄道为吉，其余六黑道为凶 */
const LUCKY_GODS = new Set(["青龙", "明堂", "金匮", "天德", "玉堂", "司命"])

/**
 * 日支 → 青龙所在的起始时支下标。
 *
 * 口诀：子午起申、丑未起戌、寅申起子、卯酉起寅、辰戌起辰、巳亥起午。
 * 它不依赖任何库，也不依赖年度数据，只靠日干支推定。
 */
const QING_LONG_START: Record<string, number> = {
  "子": 8,
  "午": 8,
  "丑": 10,
  "未": 10,
  "寅": 0,
  "申": 0,
  "卯": 2,
  "酉": 2,
  "辰": 4,
  "戌": 4,
  "巳": 6,
  "亥": 6,
}

export interface HourLuck {
  /** 时支，如 "子" */
  zhi: string
  /** 时辰名，如 "子时" */
  label: string
  /** 钟点区间，如 "23–01" */
  range: string
  /** 当值十二神，如 "青龙" */
  god: string
  /** 黄道为 true */
  lucky: boolean
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/**
 * 算出十二时辰的吉凶。
 *
 * @param dayZhi 日干支的支，如 "丙寅" 传 "寅"
 */
export function getHourLuck(dayZhi: string): HourLuck[] {
  const start = QING_LONG_START[dayZhi]
  if (start === undefined) return []

  return HOUR_ZHI.map((zhi, i) => {
    const god = DAO_GODS[(i - start + 12) % 12]
    // 子时从 23 点起，每个时辰两小时
    const from = (i * 2 + 23) % 24
    return {
      zhi,
      label: `${zhi}时`,
      range: `${pad2(from)}–${pad2((from + 2) % 24)}`,
      god,
      lucky: LUCKY_GODS.has(god),
    }
  })
}
