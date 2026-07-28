import type { TitanClient } from "./titanClient.js";

// Paging and normalization helpers shared by the derived tools (aggregates.ts)
// and the sales-order index (orderIndex.ts).

export const INTERNAL_PAGE_SIZE = 500;
export const MAX_PAGES = 200;

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface PaginationData {
  totalCount?: number;
  pageSize?: number;
  currentPage?: number;
  totalPages?: number;
  nextPageLink?: string | null;
}

export interface PagedFetchResult {
  rows: Record<string, unknown>[];
  pagesFetched: number;
  truncated: boolean;
  /** Records the Titan API could not serve (persistent 500s) that were skipped. */
  skipped: number;
}

// Some Titan endpoints 500 when a corrupt record falls inside the requested
// page (seen live on /ProductionEntries). A failing page is subdivided into
// smaller pages so only the genuinely broken record(s) get skipped.
const SUBDIVIDE: Record<number, number> = { 500: 100, 100: 20, 20: 4, 4: 1 };

interface PageFetch {
  rows: Record<string, unknown>[];
  skipped: number;
  pagination?: PaginationData;
}

async function fetchPageRecursive(
  client: TitanClient,
  path: string,
  query: Record<string, unknown>,
  pageNumber: number,
  pageSize: number
): Promise<PageFetch> {
  try {
    const data = await client.get(path, {
      ...query,
      PageNumber: pageNumber,
      PageSize: pageSize,
    });
    const rows = Array.isArray(data.result) ? (data.result as Record<string, unknown>[]) : [];
    return {
      rows,
      skipped: 0,
      pagination: (data.paginationData ?? undefined) as PaginationData | undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!/returned 500/.test(msg)) throw err;
    const subSize = SUBDIVIDE[pageSize];
    if (subSize == null) return { rows: [], skipped: pageSize };
    const k = pageSize / subSize;
    const result: PageFetch = { rows: [], skipped: 0 };
    for (let i = 0; i < k; i++) {
      const sub = await fetchPageRecursive(client, path, query, (pageNumber - 1) * k + i + 1, subSize);
      result.rows.push(...sub.rows);
      result.skipped += sub.skipped;
      result.pagination ??= sub.pagination;
    }
    return result;
  }
}

export async function fetchAllPages(
  client: TitanClient,
  path: string,
  query: Record<string, unknown>
): Promise<PagedFetchResult> {
  const rows: Record<string, unknown>[] = [];
  let pagesFetched = 0;
  let truncated = false;
  let skipped = 0;

  for (let pageNumber = 1; ; pageNumber++) {
    if (pageNumber > MAX_PAGES) {
      truncated = true;
      break;
    }
    const page = await fetchPageRecursive(client, path, query, pageNumber, INTERNAL_PAGE_SIZE);
    if (page.skipped >= INTERNAL_PAGE_SIZE && page.rows.length === 0) {
      throw new Error(
        `The Titan API is persistently failing for GET ${path} (an entire page of records ` +
          "returned server errors); results would be unreliable, so the request was aborted."
      );
    }
    pagesFetched = pageNumber;
    rows.push(...page.rows);
    skipped += page.skipped;

    const totalCount = page.pagination?.totalCount;
    if (totalCount != null) {
      if (pageNumber >= Math.ceil(totalCount / INTERNAL_PAGE_SIZE)) break;
    } else if (page.rows.length === 0 && page.skipped === 0) {
      break;
    }
  }
  return { rows, pagesFetched, truncated, skipped };
}

/** Response fields reporting records the API could not serve; spread into results. */
export const skippedNote = (skipped: number) =>
  skipped > 0
    ? {
        skippedRecords: skipped,
        skippedNote:
          `${skipped} record(s) could not be retrieved from the Titan API (persistent server ` +
          "errors on those records) and are excluded from all sums.",
      }
    : {};

export function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Normalizes an ISO date/date-time string to YYYY-MM-DD; empty string if absent. */
export function datePart(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

/** Same as datePart but returns null instead of "" so absent dates stay explicit. */
export function dateOrNull(value: unknown): string | null {
  const d = datePart(value);
  return d === "" ? null : d;
}

export function inRange(dateYmd: string, start?: string, end?: string): boolean {
  if (!start && !end) return true;
  if (!dateYmd) return false;
  if (start && dateYmd < start.slice(0, 10)) return false;
  if (end && dateYmd > end.slice(0, 10)) return false;
  return true;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** True unless the row's plant is in the configured TITAN_EXCLUDED_PLANTS set. */
export const plantAllowed = (excluded: Set<string>, plant: unknown): boolean =>
  !excluded.has(String(plant ?? "").toUpperCase());

export const excludedPlantsNote = (excluded: Set<string>) =>
  excluded.size > 0 ? { excludedPlants: [...excluded].sort() } : {};

/** YYYY-MM-DD for `days` before the given YYYY-MM-DD date (UTC arithmetic). */
export function shiftDays(dateYmd: string, days: number): string {
  const ms = Date.parse(`${dateYmd.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ms)) return dateYmd;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}
