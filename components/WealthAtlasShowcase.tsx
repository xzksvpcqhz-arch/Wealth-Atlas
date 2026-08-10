"use client";

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { Responsive, WidthProvider, type ResponsiveLayouts } from "react-grid-layout/legacy";
import { ArrowsOutCardinal, ChartLineUp, Check, Coins, Compass, Receipt, Sparkle, Wallet } from "@phosphor-icons/react";
import styles from "./WealthAtlasShowcase.module.css";

const ResponsiveGrid = WidthProvider(Responsive);

const initialLayouts: ResponsiveLayouts = {
  lg: [
    { i: "free", x: 0, y: 0, w: 5, h: 4 },
    { i: "pulse", x: 5, y: 0, w: 3, h: 4 },
    { i: "accounts", x: 8, y: 0, w: 4, h: 4 },
    { i: "currency", x: 0, y: 4, w: 7, h: 2 },
    { i: "focus", x: 7, y: 4, w: 5, h: 2 },
  ],
  md: [
    { i: "free", x: 0, y: 0, w: 6, h: 4 },
    { i: "pulse", x: 6, y: 0, w: 4, h: 4 },
    { i: "accounts", x: 0, y: 4, w: 10, h: 4 },
    { i: "currency", x: 0, y: 8, w: 6, h: 2 },
    { i: "focus", x: 6, y: 8, w: 4, h: 2 },
  ],
  sm: [
    { i: "free", x: 0, y: 0, w: 6, h: 4 },
    { i: "pulse", x: 0, y: 4, w: 6, h: 3 },
    { i: "accounts", x: 0, y: 7, w: 6, h: 4 },
    { i: "currency", x: 0, y: 11, w: 6, h: 2 },
    { i: "focus", x: 0, y: 13, w: 6, h: 2 },
  ],
};

const moduleItems = [
  { id: "free", className: styles.free, content: <><span className={styles.eyebrow}>本月可自由使用 · 展示数据</span><strong className={styles.heroValue}>RM 2,480.00</strong><span className={styles.heroSupport}>在固定付款和储蓄之后，仍然可以安心使用的金额。</span><div className={styles.heroLine}><span>安全余额 RM 17.40</span><b>82%</b></div><div className={styles.progress}><span style={{ width: "82%" }} /></div></> },
  { id: "pulse", className: styles.pulse, content: <><span className={styles.eyebrow}>本月节奏</span><div className={styles.metric}><Receipt size={18} /><div><span>本月支出</span><strong>RM 2,670.00</strong></div></div><div className={styles.metric}><Wallet size={18} /><div><span>本月储蓄</span><strong>RM 2,100.00</strong></div></div><div className={styles.metric}><ChartLineUp size={18} /><div><span>净资产变化</span><strong className={styles.positive}>+RM 3,820</strong></div></div></> },
  { id: "accounts", className: styles.accounts, content: <><div className={styles.cardHeader}><div><span className={styles.eyebrow}>账户总览</span><h2>钱现在在哪里</h2></div><Compass size={22} /></div><div className={styles.accountRow}><span>新加坡工资账户<small>SGD · 2 笔活动</small></span><b>SGD 6,595.00</b></div><div className={styles.accountRow}><span>马来西亚生活账户<small>MYR · 4 笔活动</small></span><b>RM 4,290.00</b></div><div className={styles.accountRow}><span>USD 投资账户<small>USD · 0 笔活动</small></span><b>US$5,000.00</b></div></> },
  { id: "currency", className: styles.currency, content: <><div className={styles.currencyHeader}><span className={styles.eyebrow}>货币暴露</span><span>SGD/MYR 3.48 · USD/SGD 1.34</span></div><div className={styles.exposure}><div><strong>MYR</strong><span>62%</span><i><em style={{ width: "62%" }} /></i></div><div><strong>SGD</strong><span>24%</span><i><em style={{ width: "24%" }} /></i></div><div><strong>USD</strong><span>14%</span><i><em style={{ width: "14%" }} /></i></div></div></> },
  { id: "focus", className: styles.focus, content: <><div className={styles.cardHeader}><div><span className={styles.eyebrow}>理财师提醒</span><h2>今天先守住外食预算</h2></div><Sparkle size={22} /></div><p>当前支出速度会让月底预测来到 RM 940。再记录下一笔前，系统会先提示你。</p><div className={styles.focusStatus}><Check size={16} weight="bold" /> 目标和现金流仍在安全轨道</div></> },
];

export default function WealthAtlasShowcase() {
  const [layouts, setLayouts] = useState<ResponsiveLayouts>(initialLayouts);
  const [isEditing, setIsEditing] = useState(true);
  const layoutCount = useMemo(() => layouts.lg?.length ?? 0, [layouts]);

  return <main className={styles.page}>
    <div className={styles.starfield} />
      <motion.div className={styles.shell} initial={{ y: 16 }} animate={{ y: 0 }} transition={{ duration: 0.55, ease: "easeOut" }}>
      <header className={styles.header}>
        <div><div className={styles.brand}><Sparkle size={16} weight="fill" /> WEALTH ATLAS / LAYOUT LAB</div><h1>可调整的财富星图首页</h1><p>先把你最常看的财务模块放到最顺手的位置。</p></div>
        <div className={styles.headerActions}><span className={styles.demoPill}>展示用数据</span><button className={styles.toggle} onClick={() => setIsEditing((value) => !value)}><ArrowsOutCardinal size={16} /> {isEditing ? "完成排版" : "调整排版"}</button></div>
      </header>
      <section className={styles.notice}><Coins size={18} /><span>{isEditing ? "拖动模块调整顺序，拖动右下角调整大小；完成后可保存到你的首页偏好。" : `已完成一版排版 · ${layoutCount} 个首页模块`}</span></section>
      <ResponsiveGrid className="showcase-grid" layouts={layouts} breakpoints={{ lg: 1100, md: 780, sm: 0 }} cols={{ lg: 12, md: 10, sm: 6 }} rowHeight={56} margin={[14, 14]} containerPadding={[0, 0]} isDraggable={isEditing} isResizable={isEditing} compactType="vertical" preventCollision={false} onLayoutChange={(_, allLayouts) => setLayouts(allLayouts)}>
        {moduleItems.map((item) => <div key={item.id} className={`${styles.module} ${item.className}`}>{item.content}</div>)}
      </ResponsiveGrid>
      <footer className={styles.footer}><span>Prototype direction: Operate · calm density · one cyan accent</span><span>下一步：把排版偏好保存到本地数据</span></footer>
    </motion.div>
  </main>;
}
