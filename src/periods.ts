// Relative period resolution (WI-3). The model's date arithmetic is a recurring
// error source and its sense of "today" drifts from the server's, so the server
// resolves named periods against its own clock and reports the absolute range back.
//
// NWPX books in Mountain time; the container would otherwise compute in UTC and be
// a day out at every week and month boundary. Titan's dates are date-only
// (2026-07-20T00:00:00), so the zone is used ONLY to decide what "today" is —
// everything after that is calendar arithmetic on YYYY-MM-DD strings, which makes
// DST irrelevant to the range maths.
export const REPORTING_TIME_ZONE = "America/Denver";

/** Calendar year (confirmed with NWPX 2026-07-28): quarters are Jan-Mar, Apr-Jun, ... */
export const PERIOD_NAMES = [
  "today",
  "yesterday",
  "thisWeek",
  "lastWeek",
  "thisMonth",
  "lastMonth",
  "thisQuarter",
  "lastQuarter",
  "ytd",
  "priorYear",
  "last7Days",
  "last30Days",
  "trailing12Months",
] as const;

export type PeriodName = (typeof PERIOD_NAMES)[number];

export interface DateRange {
  start: string;
  end: string;
}

/** Today's date in the reporting zone, as YYYY-MM-DD. */
export function todayInZone(now: Date = new Date(), timeZone = REPORTING_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function parse(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new Error(`Invalid date: ${ymd} (expected YYYY-MM-DD).`);
  }
  return { y, m, d };
}

const pad = (n: number): string => String(n).padStart(2, "0");
const fmt = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** Days in month m (1-12) of year y. */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(ymd: string, days: number): string {
  const { y, m, d } = parse(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Adds months, clamping the day to the target month's length (Mar 31 -1mo = Feb 28/29). */
export function addMonths(ymd: string, months: number): string {
  const { y, m, d } = parse(ymd);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** 0 = Sunday. Weeks run Sunday-Saturday, per NWPX reporting convention. */
export function dayOfWeek(ymd: string): number {
  const { y, m, d } = parse(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Resolves a named period against `today` (YYYY-MM-DD in the reporting zone).
 * "This"-periods run period-start through today rather than through the period's
 * end, so a range never extends into the future.
 */
export function resolvePeriod(period: PeriodName, today: string): DateRange {
  const { y, m } = parse(today);
  const firstOfMonth = fmt(y, m, 1);
  const quarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const firstOfQuarter = fmt(y, quarterStartMonth, 1);
  const startOfWeek = addDays(today, -dayOfWeek(today));

  switch (period) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const d = addDays(today, -1);
      return { start: d, end: d };
    }
    case "thisWeek":
      return { start: startOfWeek, end: today };
    case "lastWeek": {
      const end = addDays(startOfWeek, -1);
      return { start: addDays(end, -6), end };
    }
    case "thisMonth":
      return { start: firstOfMonth, end: today };
    case "lastMonth":
      return { start: addMonths(firstOfMonth, -1), end: addDays(firstOfMonth, -1) };
    case "thisQuarter":
      return { start: firstOfQuarter, end: today };
    case "lastQuarter":
      return { start: addMonths(firstOfQuarter, -3), end: addDays(firstOfQuarter, -1) };
    case "ytd":
      return { start: fmt(y, 1, 1), end: today };
    case "priorYear":
      return { start: fmt(y - 1, 1, 1), end: fmt(y - 1, 12, 31) };
    case "last7Days":
      return { start: addDays(today, -6), end: today };
    case "last30Days":
      return { start: addDays(today, -29), end: today };
    case "trailing12Months":
      return { start: addDays(addMonths(today, -12), 1), end: today };
    default: {
      const exhaustive: never = period;
      throw new Error(`Unknown period: ${String(exhaustive)}`);
    }
  }
}

/** Human-readable definitions, surfaced by get_server_time so the agent can cite them. */
export const PERIOD_DEFINITIONS: Record<PeriodName, string> = {
  today: "Today.",
  yesterday: "Yesterday.",
  thisWeek: "Sunday of the current week through today.",
  lastWeek: "The previous Sunday-Saturday week.",
  thisMonth: "The 1st of the current month through today.",
  lastMonth: "The 1st through the last day of the previous month.",
  thisQuarter: "The first day of the current calendar quarter through today.",
  lastQuarter: "The previous calendar quarter, in full.",
  ytd: "January 1 of the current calendar year through today.",
  priorYear: "January 1 through December 31 of the previous calendar year.",
  last7Days: "The 7 days ending today, inclusive.",
  last30Days: "The 30 days ending today, inclusive.",
  trailing12Months: "The 12 months ending today, inclusive.",
};
