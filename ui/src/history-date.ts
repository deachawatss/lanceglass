import type { HistoryPeriod } from "./location";

function dateFromKey(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function shiftHistoryDate(value: string, period: HistoryPeriod, direction: -1 | 1) {
  const current = dateFromKey(value);
  if (period === "day" || period === "week") {
    current.setUTCDate(current.getUTCDate() + direction * (period === "week" ? 7 : 1));
    return dateKey(current);
  }

  const day = current.getUTCDate();
  const target = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + direction, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return dateKey(target);
}

export function nextHistoryDate(value: string, period: HistoryPeriod, today: string) {
  const shifted = shiftHistoryDate(value, period, 1);
  return shifted > today ? today : shifted;
}
