"use client";

import { CalendarDots, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

export const monthValuePattern = /^\d{4}-(0[1-9]|1[0-2])$/;
export const selectedMonthStorageKey = "wealth-atlas.selected-month";
const legacyMonthStorageKey = "wealth-atlas.transaction-month";
const monthChangeEvent = "wealth-atlas:month-change";

export function formatMonthLabel(month: string) {
  return monthValuePattern.test(month) ? `${month.slice(0, 4)}年${month.slice(5, 7)}月` : month;
}

export function shiftMonth(month: string, offset: number) {
  if (!monthValuePattern.test(month)) return month;
  const [year, monthNumber] = month.split("-").map(Number);
  const absoluteMonth = year * 12 + monthNumber - 1 + offset;
  const nextYear = Math.floor(absoluteMonth / 12);
  const nextMonth = ((absoluteMonth % 12) + 12) % 12 + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

export function getMonthStart(month: string) {
  return `${month}-01`;
}

export function getMonthEnd(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${month}-${String(new Date(year, monthNumber, 0).getDate()).padStart(2, "0")}`;
}

export function getMonthReferenceDate(month: string, today: string) {
  const currentMonth = today.slice(0, 7);
  if (month === currentMonth) return today;
  return month < currentMonth ? getMonthEnd(month) : getMonthStart(month);
}

type MonthPickerProps = {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
};

export function useSharedMonth(defaultValue: string) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(selectedMonthStorageKey) ?? window.localStorage.getItem(legacyMonthStorageKey);
      if (saved && monthValuePattern.test(saved)) setValue(saved);
    } catch {
      // Month selection remains available for the current session.
    }
    const sync = (event: Event) => {
      const nextValue = (event as CustomEvent<string>).detail;
      if (monthValuePattern.test(nextValue)) setValue(nextValue);
    };
    window.addEventListener(monthChangeEvent, sync);
    return () => window.removeEventListener(monthChangeEvent, sync);
  }, []);

  const change = (nextValue: string) => {
    if (!monthValuePattern.test(nextValue)) return;
    setValue(nextValue);
    try { window.localStorage.setItem(selectedMonthStorageKey, nextValue); }
    catch { /* The in-memory selection is still valid. */ }
    window.dispatchEvent(new CustomEvent(monthChangeEvent, { detail: nextValue }));
  };

  return [value, change] as const;
}

export function SharedMonthPicker({ ariaLabel = "选择查看月份" }: { ariaLabel?: string }) {
  const current = new Date();
  const fallback = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}`;
  const [value, setValue] = useSharedMonth(fallback);
  return <MonthPicker value={value} onChange={setValue} ariaLabel={ariaLabel} />;
}

export default function MonthPicker({ value, onChange, ariaLabel = "选择查看月份" }: MonthPickerProps) {
  const commit = (nextValue: string) => {
    if (monthValuePattern.test(nextValue) && nextValue !== value) onChange(nextValue);
  };

  return <div className="month-picker-group">
    <button type="button" className="month-step-button" onClick={() => onChange(shiftMonth(value, -1))} aria-label="上一个月" title="上一个月">
      <CaretLeft size={15} weight="bold" />
    </button>
    <label className="month-select month-select-control">
      <CalendarDots size={18} aria-hidden="true" />
      <input
        className="month-input"
        type="month"
        value={value}
        onInput={(event) => commit(event.currentTarget.value)}
        onChange={(event) => commit(event.currentTarget.value)}
        aria-label={ariaLabel}
        title={`当前查看：${formatMonthLabel(value)}`}
      />
    </label>
    <button type="button" className="month-step-button" onClick={() => onChange(shiftMonth(value, 1))} aria-label="下一个月" title="下一个月">
      <CaretRight size={15} weight="bold" />
    </button>
  </div>;
}
