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

export default function ZodiacHero({
  freeToSpend, liquidBalance, budgetRemaining, upcomingTotal, reportCurrency, monthlyIncome, monthlyExpenses,
}: ZodiacHeroProps) {
  const [zodiacIndex, setZodiacIndex] = useState<number>(() => getZodiacIndex(new Date()));
  const bgStars = useMemo(buildBgStars, []);
  const zodiac = ZODIAC[zodiacIndex];

  const lines = zodiac.edges
    .map(([a, b]) => {
      const s1 = zodiac.stars[a];
      const s2 = zodiac.stars[b];
      return `<line x1='${s1.x}' y1='${s1.y}' x2='${s2.x}' y2='${s2.y}'/>`;
    })
    .join("");
  const stars = zodiac.stars
    .map((s, i) => {
      const b = starBrightness(i);
      const R = s.r * 1.7;
      const glow = b > 0.68 ? `<circle cx='${s.x}' cy='${s.y}' r='${(R * 1.9).toFixed(1)}' fill='${zodiac.color}' opacity='${(0.14 + (b - 0.68) * 0.5).toFixed(2)}'/>` : "";
      return glow + `<polygon points='${starPoints(s.x, s.y, R)}' fill='${zodiac.color}' opacity='${b.toFixed(2)}'/>`;
    })
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
        <svg viewBox="0 0 250 250" fill="none" aria-hidden="true">
          <g stroke={zodiac.color} strokeWidth="1.1" opacity="0.5" dangerouslySetInnerHTML={{ __html: lines }} />
          <g dangerouslySetInnerHTML={{ __html: stars }} />
        </svg>
        <div className="zodiac-caption">
          <span>{zodiac.name}</span>
          <em>{zodiac.latin}</em>
          <small>{formatZodiacRange(zodiac)}</small>
        </div>
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
        <div className="zodiac-nav" aria-label="切换星座">
          <button type="button" className="zodiac-nav-btn" onClick={prev} aria-label="上一个星座" title="上一个星座"><CaretLeft size={16} weight="bold" /></button>
          <button type="button" className="zodiac-nav-btn" onClick={next} aria-label="下一个星座" title="下一个星座"><CaretRight size={16} weight="bold" /></button>
        </div>
        <div className="zodiac-stat income"><span>本月收入</span><b>{formatMoney(monthlyIncome, reportCurrency)}</b></div>
        <div className="zodiac-stat expense"><span>本月支出</span><b>{formatMoney(monthlyExpenses, reportCurrency)}</b></div>
      </div>
    </section>
  );
}
