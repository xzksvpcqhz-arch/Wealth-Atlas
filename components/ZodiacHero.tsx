"use client";

import { useMemo, useState } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { formatZodiacRange, getZodiacIndex, starBrightness, starPoints, ZODIAC } from "@/lib/zodiac";
import { formatMoney } from "@/lib/finance";
import type { CurrencyCode } from "@/lib/types";

interface ZodiacHeroProps {
  freeToSpend: number;
  liquidBalance: number;
  budgetRemaining: number;
  upcomingTotal: number;
  reportCurrency: CurrencyCode;
  monthlyIncome: number;
  monthlyExpenses: number;
}

interface BgStar {
  left: number;   // %
  top: number;    // %
  size: number;   // px
  opacity: number;
  rotation: number;
  color: string;
  duration: number;
  delay: number;
}

const BG_COLORS = ["#ffffff", "#f2f6ff", "#dbe9ff", "#8fc7ff", "#ffedda", "#ffe3b0"];
const CLUSTERS = [[18, 26], [68, 14], [82, 62], [36, 78], [55, 45]];

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildBgStars(): BgStar[] {
  const rand = mulberry32(20260820);
  const stars: BgStar[] = [];
  for (let i = 0; i < 34; i++) {
    let left: number;
    let top: number;
    if (rand() < 0.7) {
      const c = CLUSTERS[i % CLUSTERS.length];
      left = Math.min(97, Math.max(2, c[0] + (rand() * 26 - 13)));
      top = Math.min(97, Math.max(2, c[1] + (rand() * 26 - 13)));
    } else {
      left = rand() * 96 + 2;
      top = rand() * 96 + 2;
    }
    const r = rand();
    const size = +(r < 0.55 ? 3 + rand() * 4 : r < 0.85 ? 7 + rand() * 5 : 12 + rand() * 7).toFixed(1);
    stars.push({
      left: +left.toFixed(1),
      top: +top.toFixed(1),
      size,
      opacity: +(0.2 + rand() * 0.65).toFixed(2),
      rotation: Math.round(rand() * 360),
      color: BG_COLORS[Math.floor(rand() * BG_COLORS.length)],
      duration: +(1.6 + rand() * 2.6).toFixed(2),
      delay: +(rand() * 3).toFixed(2),
    });
  }
  return stars;
}

/** Catmull-Rom → 三次贝塞尔，生成平滑曲线路径。 */
function smoothPathD(points: Array<[number, number]>): string {
  if (points.length < 2) return "";
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 4;
    const c1y = p1[1] + (p2[1] - p0[1]) / 4;
    const c2x = p2[0] - (p3[0] - p1[0]) / 4;
    const c2y = p2[1] - (p3[1] - p1[1]) / 4;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

export default function ZodiacHero({
  freeToSpend, liquidBalance, budgetRemaining, upcomingTotal, reportCurrency, monthlyIncome, monthlyExpenses,
}: ZodiacHeroProps) {
  const [zodiacIndex, setZodiacIndex] = useState<number>(() => getZodiacIndex(new Date()));
  const bgStars = useMemo(buildBgStars, []);
  const zodiac = ZODIAC[zodiacIndex];

  // 平滑曲线路径（细线）
  const paths = zodiac.glyph.map((poly) => `<path d='${smoothPathD(poly)}'/>`).join("");
  // 星点：轻微抖动 + 首尾亮（带光圈）+ 中间随机有无光圈，更自然
  const stars = zodiac.glyph
    .flatMap((poly, pi) => poly.map(([x, y], i) => {
      const idx = pi * 20 + i;
      const isEdge = i === 0 || i === poly.length - 1;
      const base = starBrightness(idx);
      const b = isEdge ? Math.max(base, 0.9) : base;
      const jx = +(x + ((idx * 13) % 9) - 4.5).toFixed(1);
      const jy = +(y + ((idx * 7) % 9) - 4.5).toFixed(1);
      const R = isEdge ? +(9.5 + (idx % 3)).toFixed(1) : +(4 + b * 6).toFixed(1);
      const dur = +(2.2 + (idx % 4) * 0.5).toFixed(2);
      const delay = +((idx * 0.37) % 2.4).toFixed(2);
      const hasGlow = isEdge || ((idx * 11) % 3 === 0);
      const glow = hasGlow ? `<circle cx='${jx}' cy='${jy}' r='${(R * 1.9).toFixed(1)}' fill='${zodiac.color}' opacity='${(0.16 + (b - 0.6) * 0.4).toFixed(2)}'/>` : "";
      return glow + `<polygon points='${starPoints(jx, jy, R)}' fill='${zodiac.color}' fill-opacity='${b.toFixed(2)}' style='animation:zodiac-star-twinkle ${dur}s ease-in-out ${delay}s infinite'/>`;
    }))
    .join("");

  const prev = () => setZodiacIndex((i) => (i - 1 + ZODIAC.length) % ZODIAC.length);
  const next = () => setZodiacIndex((i) => (i + 1) % ZODIAC.length);

  return (
    <section className="panel zodiac-hero" aria-label={`${zodiac.name}星座 · 本月可自由使用`}>
      <div className="zodiac-stars" aria-hidden="true">
        {bgStars.map((s, i) => (
          <span key={i} style={{ left: `${s.left}%`, top: `${s.top}%`, opacity: s.opacity }}>
            <svg
              viewBox="0 0 10 10"
              style={{
                width: s.size,
                height: s.size,
                transform: `rotate(${s.rotation}deg)`,
                animation: `zodiac-twinkle ${s.duration}s ease-in-out ${s.delay}s infinite`,
                filter: s.size >= 10 ? `drop-shadow(0 0 ${(s.size / 4).toFixed(1)}px ${s.color})` : undefined,
              }}
            >
              <polygon points={starPoints(5, 5, 4.8)} fill={s.color} />
            </svg>
          </span>
        ))}
      </div>
      <div className="zodiac-const">
        <div className="zodiac-visual">
          <svg viewBox="0 0 250 250" fill="none" aria-hidden="true">
            <defs>
              <radialGradient id="zodiac-nebula"><stop offset="0%" stopColor={zodiac.color} stopOpacity="0.22" /><stop offset="100%" stopColor={zodiac.color} stopOpacity="0" /></radialGradient>
            </defs>
            <circle cx="125" cy="125" r="105" fill="url(#zodiac-nebula)" />
            <g stroke={zodiac.color} strokeWidth="0.9" opacity="0.72" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: paths }} />
            <g dangerouslySetInnerHTML={{ __html: stars }} />
          </svg>
        </div>
        <div className="zodiac-name-block">
          <span className="zodiac-name">{zodiac.name}</span>
          <div className="zodiac-arrows">
            <button type="button" className="zodiac-nav-btn" onClick={prev} aria-label="上一个星座" title="上一个星座"><CaretLeft size={15} weight="bold" /></button>
            <button type="button" className="zodiac-nav-btn" onClick={next} aria-label="下一个星座" title="下一个星座"><CaretRight size={15} weight="bold" /></button>
          </div>
          <em className="zodiac-latin">{zodiac.latin}</em>
        </div>
        <div className="zodiac-range">{formatZodiacRange(zodiac)}</div>
      </div>
      <div className="zodiac-free">
        <div className="panel-kicker">本月可自由使用</div>
        <div className="hero-number">{formatMoney(freeToSpend, reportCurrency)}</div>
        <div className="zodiac-calc">
          <span>流动余额 <b>{formatMoney(liquidBalance, reportCurrency)}</b></span>
          <span>预算剩余 <b>- {formatMoney(budgetRemaining, reportCurrency)}</b></span>
          <span>固定付款 <b>- {formatMoney(upcomingTotal, reportCurrency)}</b></span>
        </div>
      </div>
      <div className="zodiac-side">
        <div className="zodiac-stat income"><span>本月收入</span><b>{formatMoney(monthlyIncome, reportCurrency)}</b></div>
        <div className="zodiac-stat expense"><span>本月支出</span><b>{formatMoney(monthlyExpenses, reportCurrency)}</b></div>
      </div>
    </section>
  );
}
