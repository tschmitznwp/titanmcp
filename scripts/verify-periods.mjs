// WI-3: the period resolver is pure logic with no API involved, so it gets real
// fixtures rather than a smoke assertion — the alternative is waiting a month to
// discover that lastMonth was wrong.
import { addMonths, dayOfWeek, resolvePeriod, todayInZone } from "../dist/periods.js";

let failed = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
    failed++;
  }
}

function range(today, period, start, end) {
  check(`${period} on ${today}`, resolvePeriod(period, today), { start, end });
}

// --- 2026-07-28 is a Tuesday; the Sunday-Saturday week before it is Jul 19-25,
// --- which is the window NWPX verified against live data.
range("2026-07-28", "today", "2026-07-28", "2026-07-28");
range("2026-07-28", "yesterday", "2026-07-27", "2026-07-27");
range("2026-07-28", "thisWeek", "2026-07-26", "2026-07-28");
range("2026-07-28", "lastWeek", "2026-07-19", "2026-07-25");
range("2026-07-28", "thisMonth", "2026-07-01", "2026-07-28");
range("2026-07-28", "lastMonth", "2026-06-01", "2026-06-30");
range("2026-07-28", "thisQuarter", "2026-07-01", "2026-07-28");
range("2026-07-28", "lastQuarter", "2026-04-01", "2026-06-30");
range("2026-07-28", "ytd", "2026-01-01", "2026-07-28");
range("2026-07-28", "priorYear", "2025-01-01", "2025-12-31");
range("2026-07-28", "last7Days", "2026-07-22", "2026-07-28");
range("2026-07-28", "last30Days", "2026-06-29", "2026-07-28");
range("2026-07-28", "trailing12Months", "2025-07-29", "2026-07-28");

// --- On a Sunday, thisWeek is a single day and lastWeek is the full week before.
check("2026-07-26 is a Sunday", dayOfWeek("2026-07-26"), 0);
range("2026-07-26", "thisWeek", "2026-07-26", "2026-07-26");
range("2026-07-26", "lastWeek", "2026-07-19", "2026-07-25");

// --- Year boundary: last month/quarter must cross into the previous year.
range("2026-01-01", "lastMonth", "2025-12-01", "2025-12-31");
range("2026-01-01", "lastQuarter", "2025-10-01", "2025-12-31");
range("2026-01-01", "thisQuarter", "2026-01-01", "2026-01-01");
range("2026-01-01", "ytd", "2026-01-01", "2026-01-01");
range("2026-01-03", "lastWeek", "2025-12-21", "2025-12-27");

// --- Leap year: February must resolve to 29 days in 2024.
range("2024-03-05", "lastMonth", "2024-02-01", "2024-02-29");
range("2024-02-29", "today", "2024-02-29", "2024-02-29");
range("2024-03-01", "yesterday", "2024-02-29", "2024-02-29");

// --- Month-length clamping: adding months must not roll over into the next month.
check("2026-03-31 minus 1 month", addMonths("2026-03-31", -1), "2026-02-28");
check("2024-03-31 minus 1 month (leap)", addMonths("2024-03-31", -1), "2024-02-29");
check("2026-01-31 plus 1 month", addMonths("2026-01-31", 1), "2026-02-28");

// --- DST transitions are irrelevant to the arithmetic (dates are date-only), but
// --- the boundary days must still resolve normally. 2026-03-08 is a Sunday.
range("2026-03-08", "thisWeek", "2026-03-08", "2026-03-08");
range("2026-03-08", "lastWeek", "2026-03-01", "2026-03-07");
range("2026-11-01", "lastWeek", "2026-10-25", "2026-10-31");

// --- Quarter boundaries.
range("2026-04-01", "lastQuarter", "2026-01-01", "2026-03-31");
range("2026-10-15", "lastQuarter", "2026-07-01", "2026-09-30");
range("2026-12-31", "thisQuarter", "2026-10-01", "2026-12-31");

// --- todayInZone must return a well-formed date in the reporting zone. A UTC
// --- instant just after midnight UTC is still the previous day in Denver.
const denverEvening = new Date("2026-07-29T04:30:00Z"); // 22:30 on the 28th in Denver
check("todayInZone honours America/Denver", todayInZone(denverEvening), "2026-07-28");
check("todayInZone honours UTC", todayInZone(denverEvening, "UTC"), "2026-07-29");
if (!/^\d{4}-\d{2}-\d{2}$/.test(todayInZone())) {
  console.error("FAIL: todayInZone() did not return YYYY-MM-DD");
  failed++;
}

if (failed > 0) {
  console.error(`${failed} period check(s) failed.`);
  process.exit(1);
}
console.log("Period resolution OK: all fixtures match (week, month, quarter, year, leap, DST).");
