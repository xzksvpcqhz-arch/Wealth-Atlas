// 黄道十二星座：按日期范围匹配，各自本色；星点用五角星 + 随机明暗渲染。
export interface ZodiacStar {
  x: number;
  y: number;
  r: number; // 星点大小（亮度基数）
}

export interface ZodiacDef {
  name: string;      // 中文名
  latin: string;     // 拉丁名
  color: string;     // 星座本色
  startMonth: number; // 起始月 1-12
  startDay: number;
  endMonth: number;   // 结束月 1-12
  endDay: number;
  stars: ZodiacStar[];
  edges: Array<[number, number]>; // 连线（stars 下标）
}

export const ZODIAC: ZodiacDef[] = [
  { name: "摩羯座", latin: "Capricorn", color: "#8C7A6B", startMonth: 12, startDay: 22, endMonth: 1, endDay: 19, stars: [{ x: 85, y: 150, r: 2.5 }, { x: 125, y: 95, r: 3 }, { x: 165, y: 150, r: 2.5 }, { x: 125, y: 130, r: 2 }, { x: 125, y: 165, r: 2 }], edges: [[0, 1], [1, 2], [1, 3], [3, 4]] },
  { name: "水瓶座", latin: "Aquarius", color: "#3E9DE0", startMonth: 1, startDay: 20, endMonth: 2, endDay: 18, stars: [{ x: 85, y: 70, r: 2.5 }, { x: 110, y: 105, r: 2 }, { x: 85, y: 140, r: 2 }, { x: 110, y: 175, r: 2.5 }, { x: 135, y: 155, r: 2 }, { x: 135, y: 120, r: 2 }], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]] },
  { name: "双鱼座", latin: "Pisces", color: "#4FB3A9", startMonth: 2, startDay: 19, endMonth: 3, endDay: 20, stars: [{ x: 125, y: 55, r: 3 }, { x: 95, y: 125, r: 2 }, { x: 125, y: 195, r: 2.5 }, { x: 155, y: 125, r: 2 }, { x: 175, y: 125, r: 2 }], edges: [[0, 1], [1, 2], [0, 3], [3, 2], [3, 4]] },
  { name: "白羊座", latin: "Aries", color: "#FF6B4A", startMonth: 3, startDay: 21, endMonth: 4, endDay: 19, stars: [{ x: 70, y: 170, r: 2.5 }, { x: 90, y: 155, r: 2 }, { x: 115, y: 138, r: 2 }, { x: 145, y: 120, r: 2 }, { x: 175, y: 105, r: 3 }, { x: 200, y: 105, r: 2 }], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]] },
  { name: "金牛座", latin: "Taurus", color: "#7FB069", startMonth: 4, startDay: 20, endMonth: 5, endDay: 20, stars: [{ x: 125, y: 120, r: 4 }, { x: 85, y: 170, r: 2.5 }, { x: 165, y: 170, r: 2.5 }, { x: 60, y: 150, r: 2 }, { x: 35, y: 115, r: 2 }, { x: 190, y: 150, r: 2 }, { x: 215, y: 115, r: 2 }], edges: [[1, 0], [0, 2], [1, 3], [3, 4], [2, 5], [5, 6]] },
  { name: "双子座", latin: "Gemini", color: "#F2C14E", startMonth: 5, startDay: 21, endMonth: 6, endDay: 20, stars: [{ x: 80, y: 70, r: 3 }, { x: 80, y: 105, r: 2 }, { x: 80, y: 140, r: 2 }, { x: 170, y: 70, r: 3 }, { x: 170, y: 105, r: 2 }, { x: 170, y: 140, r: 2 }, { x: 80, y: 50, r: 2 }, { x: 170, y: 50, r: 2 }], edges: [[6, 0], [0, 1], [1, 2], [7, 3], [3, 4], [4, 5]] },
  { name: "巨蟹座", latin: "Cancer", color: "#9EC5E8", startMonth: 6, startDay: 21, endMonth: 7, endDay: 22, stars: [{ x: 125, y: 60, r: 3 }, { x: 125, y: 90, r: 2 }, { x: 125, y: 120, r: 2 }, { x: 95, y: 155, r: 2 }, { x: 155, y: 155, r: 2 }], edges: [[0, 1], [1, 2], [2, 3], [2, 4]] },
  { name: "狮子座", latin: "Leo", color: "#F5C542", startMonth: 7, startDay: 23, endMonth: 8, endDay: 22, stars: [{ x: 150, y: 165, r: 5 }, { x: 130, y: 140, r: 2.5 }, { x: 105, y: 120, r: 2.5 }, { x: 80, y: 105, r: 2 }, { x: 62, y: 82, r: 2 }, { x: 52, y: 55, r: 2.5 }, { x: 185, y: 80, r: 3 }, { x: 210, y: 130, r: 2.5 }, { x: 200, y: 185, r: 3.5 }], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [0, 6], [6, 7], [7, 8], [8, 0]] },
  { name: "处女座", latin: "Virgo", color: "#C8A56A", startMonth: 8, startDay: 23, endMonth: 9, endDay: 22, stars: [{ x: 125, y: 60, r: 3 }, { x: 125, y: 90, r: 2 }, { x: 95, y: 120, r: 2 }, { x: 155, y: 120, r: 2 }, { x: 125, y: 150, r: 2 }, { x: 125, y: 185, r: 2.5 }], edges: [[0, 1], [1, 2], [1, 3], [1, 4], [4, 5]] },
  { name: "天秤座", latin: "Libra", color: "#F49AC1", startMonth: 9, startDay: 23, endMonth: 10, endDay: 22, stars: [{ x: 125, y: 55, r: 3 }, { x: 150, y: 105, r: 2 }, { x: 125, y: 155, r: 2.5 }, { x: 100, y: 105, r: 2 }, { x: 125, y: 185, r: 2 }], edges: [[0, 1], [1, 2], [2, 3], [3, 0], [2, 4]] },
  { name: "天蝎座", latin: "Scorpio", color: "#C0392B", startMonth: 10, startDay: 23, endMonth: 11, endDay: 21, stars: [{ x: 125, y: 55, r: 3 }, { x: 125, y: 95, r: 2 }, { x: 125, y: 130, r: 2 }, { x: 110, y: 165, r: 2 }, { x: 120, y: 190, r: 2.5 }, { x: 155, y: 185, r: 2 }, { x: 95, y: 95, r: 2 }, { x: 155, y: 95, r: 2 }], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [1, 6], [1, 7]] },
  { name: "射手座", latin: "Sagittarius", color: "#A06BD6", startMonth: 11, startDay: 22, endMonth: 12, endDay: 21, stars: [{ x: 80, y: 175, r: 2 }, { x: 120, y: 135, r: 2 }, { x: 160, y: 95, r: 2.5 }, { x: 200, y: 55, r: 3 }, { x: 150, y: 75, r: 2 }, { x: 165, y: 50, r: 2 }], edges: [[0, 1], [1, 2], [2, 3], [2, 4], [3, 4]] },
];

/** 星座日期范围中文展示，如「7月23日 – 8月22日」。 */
export function formatZodiacRange(z: ZodiacDef): string {
  return `${z.startMonth}月${z.startDay}日 – ${z.endMonth}月${z.endDay}日`;
}

/** 星座日期范围简短展示，如「7.23 – 8.22」。 */
export function formatZodiacRangeShort(z: ZodiacDef): string {
  return `${z.startMonth}.${z.startDay} – ${z.endMonth}.${z.endDay}`;
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
  return 0.42 + (((index * 37) % 10) / 10) * 0.58;
}
