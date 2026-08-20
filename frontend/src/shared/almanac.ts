import { Solar } from "lunar-typescript"

import { getHourLuck, isRestricted, mapTaboo, zhiXingTone, type HourLuck } from "./almanacMap"
import type { LocalDate } from "./types"

export interface AlmanacDay {
  /** 公历日期，与入参一致 */
  date: LocalDate
  /** 星期几，如 "星期四" */
  weekday: string
  /** 完整农历，如 "二〇二六年七月初八" */
  lunarFull: string
  /** 简短农历，如 "七月初八"，首页用这个 */
  lunarShort: string
  /** 年干支，如 "丙午" */
  ganZhi: string
  /** 生肖，如 "马" */
  zodiac: string
  /** 当天若为节气则返回节气名，否则 null */
  jieQi: string | null
  /** 农历节日与公历节日合并 */
  festivals: string[]
  /** 建除十二值星，如 "除" */
  zhiXing: string
  /** 原始宜，完整黄历里展示 */
  yi: string[]
  /** 原始忌，完整黄历里展示 */
  ji: string[]
  /** 映射后的宜，首页展示，最多 3 条 */
  yiBrief: string[]
  /** 映射后的忌，首页展示，最多 3 条 */
  jiBrief: string[]
  /** 值星推出的基调，如 "宜断旧"。任何日子都有值，永不为空 */
  tone: string
  /** 当天是否出现「馀事勿取」「诸事不宜」这类总括词 */
  restricted: boolean
  /** 日干支，如 "丙寅" */
  dayGanZhi: string
  /** 胎神方位，如 "厨灶炉外正南" */
  taiShen: string
  /** 二十八宿全称，如 "东方角木蛟" */
  xiu: string
  /** 星宿吉凶，"吉" 或 "凶" */
  xiuLuck: string
  /** 日纳音五行，如 "炉中火" */
  naYin: string
  /** 冲，如 "虎日冲猴（庚申）" */
  chong: string
  /** 煞方，如 "煞北" */
  sha: string
  /** 十二时辰吉凶，本地推算，不走库 */
  hours: HourLuck[]
  /** 彭祖百忌两句 */
  pengZu: string[]
}

function parseDate(date: LocalDate): [number, number, number] {
  const parts = date.split("-").map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`invalid LocalDate: ${date}`)
  }
  return [parts[0], parts[1], parts[2]]
}

/**
 * 拼「虎日冲猴（庚申）」。
 *
 * 实测 getDayChongDesc() 返回的是 "(庚申)猴"，干支在前、生肖在后，
 * 和手机日历的习惯写法相反，所以把括号里的干支抠出来重排。
 * 正则同时容下半角与全角括号，库版本变了也不致于报错。
 */
function formatChong(
  dayShengXiao: string,
  chongDesc: string,
  chongShengXiao: string,
): string {
  const matched = chongDesc.match(/[（(]([^）)]+)[）)]/)
  const ganZhi = matched?.[1] ?? ""
  const target = chongShengXiao || chongDesc

  return ganZhi ? `${dayShengXiao}日冲${target}（${ganZhi}）` : `${dayShengXiao}日冲${target}`
}

/**
 * 取某一天的黄历信息。
 *
 * 入参是 LocalDate（"2026-08-20"）而不是 Date 对象，这是刻意的：
 * 黄历回答的是"这个日历日"的问题，掺进时间戳只会引入时区歧义。
 */
export function getAlmanac(date: LocalDate): AlmanacDay {
  const [y, m, d] = parseDate(date)
  const solar = Solar.fromYmd(y, m, d)
  const lunar = solar.getLunar()

  const yi = lunar.getDayYi()
  const ji = lunar.getDayJi()
  const jieQi = lunar.getJieQi()
  const dayGanZhi = lunar.getDayInGanZhi()

  return {
    date,
    weekday: `星期${solar.getWeekInChinese()}`,
    lunarFull: lunar.toString(),
    lunarShort: `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
    ganZhi: lunar.getYearInGanZhi(),
    zodiac: lunar.getYearShengXiao(),
    jieQi: jieQi ? jieQi : null,
    festivals: [...lunar.getFestivals(), ...solar.getFestivals()],
    zhiXing: lunar.getZhiXing(),
    yi,
    ji,
    yiBrief: mapTaboo(yi),
    jiBrief: mapTaboo(ji),
    tone: zhiXingTone(lunar.getZhiXing()),
    restricted: isRestricted(yi) || isRestricted(ji),
    dayGanZhi,
    // 库返回「厨灶炉 外正南」，中间带空格；手机日历的写法是连写，去掉
    taiShen: lunar.getDayPositionTai().replace(/\s+/g, ""),
    xiu: `${lunar.getGong()}方${lunar.getXiu()}${lunar.getZheng()}${lunar.getAnimal()}`,
    xiuLuck: lunar.getXiuLuck(),
    naYin: lunar.getDayNaYin(),
    chong: formatChong(
      lunar.getDayShengXiao(),
      lunar.getDayChongDesc(),
      lunar.getDayChongShengXiao(),
    ),
    sha: `煞${lunar.getDaySha()}`,
    // 只取日干支的支，避免多调一个 getDayZhi() 增加 API 风险
    hours: getHourLuck(dayGanZhi.slice(1)),
    pengZu: [lunar.getPengZuGan(), lunar.getPengZuZhi()],
  }
}
