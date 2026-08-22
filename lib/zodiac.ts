// 黄道十二星座：按日期范围匹配，各自本色；星座符号以「星点 + 连线」方式绘制。
export interface ZodiacDef {
  name: string;      // 中文名
  latin: string;     // 拉丁名
  color: string;     // 星座本色
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
  // 星座符号的星点连线：多个笔画，每个笔画是一串 [x, y] 点
  glyph: Array<Array<[number, number]>>;
}

export const ZODIAC: ZodiacDef[] = [
  {
    name: "摩羯座", latin: "Capricorn", color: "#8C7A6B", startMonth: 12, startDay: 22, endMonth: 1, endDay: 19,
    glyph: [[[95, 55], [95, 130], [95, 175]], [[95, 130], [155, 130]], [[155, 130], [155, 175], [155, 195]]],
  },
  {
    name: "水瓶座", latin: "Aquarius", color: "#3E9DE0", startMonth: 1, startDay: 20, endMonth: 2, endDay: 18,
    glyph: [[[70, 70], [110, 100], [70, 130], [110, 160]], [[140, 70], [180, 100], [140, 130], [180, 160]]],
  },
  {
    name: "双鱼座", latin: "Pisces", color: "#4FB3A9", startMonth: 2, startDay: 19, endMonth: 3, endDay: 20,
    glyph: [[[125, 55], [95, 130], [125, 195]], [[125, 55], [155, 130], [125, 195]], [[95, 130], [155, 130]]],
  },
  {
    name: "白羊座", latin: "Aries", color: "#FF6B4A", startMonth: 3, startDay: 21, endMonth: 4, endDay: 19,
    glyph: [[[50, 180], [90, 140], [125, 65], [160, 140], [200, 180]]],
  },
  {
    name: "金牛座", latin: "Taurus", color: "#7FB069", startMonth: 4, startDay: 20, endMonth: 5, endDay: 20,
    glyph: [[[95, 60], [125, 95], [155, 60]], [[125, 95], [165, 115], [155, 175], [95, 175], [85, 115], [125, 95]]],
  },
  {
    name: "双子座", latin: "Gemini", color: "#F2C14E", startMonth: 5, startDay: 21, endMonth: 6, endDay: 20,
    glyph: [[[80, 55], [80, 200]], [[170, 55], [170, 200]]],
  },
  {
    name: "巨蟹座", latin: "Cancer", color: "#9EC5E8", startMonth: 6, startDay: 21, endMonth: 7, endDay: 22,
    glyph: [[[105, 70], [105, 120], [145, 120], [145, 70]], [[105, 135], [105, 185], [145, 185], [145, 135]]],
  },
  {
    name: "狮子座", latin: "Leo", color: "#F5C542", startMonth: 7, startDay: 23, endMonth: 8, endDay: 22,
    glyph: [[[95, 95], [95, 140], [150, 140], [150, 95], [95, 95]], [[150, 140], [175, 165], [185, 195]]],
  },
  {
    name: "处女座", latin: "Virgo", color: "#C8A56A", startMonth: 8, startDay: 23, endMonth: 9, endDay: 22,
    glyph: [[[100, 55], [100, 110], [100, 165]], [[100, 110], [150, 110]], [[150, 110], [150, 165], [150, 200]]],
  },
  {
    name: "天秤座", latin: "Libra", color: "#F49AC1", startMonth: 9, startDay: 23, endMonth: 10, endDay: 22,
    glyph: [[[60, 90], [190, 90]], [[125, 90], [90, 50], [90, 40], [160, 40], [160, 50], [125, 90]]],
  },
  {
    name: "天蝎座", latin: "Scorpio", color: "#C0392B", startMonth: 10, startDay: 23, endMonth: 11, endDay: 21,
    glyph: [[[100, 55], [100, 120], [100, 175]], [[100, 175], [120, 200], [150, 185]], [[100, 120], [150, 55], [150, 120]]],
  },
  {
    name: "射手座", latin: "Sagittarius", color: "#A06BD6", startMonth: 11, startDay: 22, endMonth: 12, endDay: 21,
    glyph: [[[70, 190], [115, 145], [160, 100], [205, 55]], [[160, 100], [140, 90], [165, 70]]],
  },
];

/** 星座日期范围中文展示，如「7月23日 – 8月22日」。 */
export function formatZodiacRange(z: ZodiacDef): string {
  return `${z.startMonth}月${z.startDay}日 – ${z.endMonth}月${z.endDay}日`;
}

function dayOfYear(month: number, day: number): number {
  const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return cum[month - 1] + day;
}

function inRange(doy: number, z: ZodiacDef): boolean {
  const start = dayOfYear(z.startMonth, z.startDay);
  const end = dayOfYear(z.endMonth, z.endDay);
  if (start <= end) return doy >= start && doy <= end;
  return doy >= start || doy <= end; // 跨年（摩羯座）
}

/** 根据日期返回该日所属黄道星座。 */
export function getZodiacForDate(date: Date): ZodiacDef {
  const doy = dayOfYear(date.getMonth() + 1, date.getDate());
  return ZODIAC.find((z) => inRange(doy, z)) ?? ZODIAC[7]; // 兜底狮子座
}

/** 返回日期所属星座在 ZODIAC 中的下标。 */
export function getZodiacIndex(date: Date): number {
  const z = getZodiacForDate(date);
  return ZODIAC.indexOf(z);
}

/** 生成五角星 polygon points。 */
export function starPoints(cx: number, cy: number, outerR: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 10; k++) {
    const rr = k % 2 === 0 ? outerR : outerR * 0.45;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

/** 确定性"随机"明暗（同一星座每次渲染一致）。 */
export function starBrightness(index: number): number {
  return 0.6 + (((index * 37) % 10) / 10) * 0.4;
}
