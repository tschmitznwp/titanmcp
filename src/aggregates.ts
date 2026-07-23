import { z, type ZodRawShape } from "zod";
import type { TitanClient } from "./titanClient.js";

// Derived, read-only summary tools. Each pages through a Titan list endpoint
// inside this server (cheap HTTP round-trips) and returns only aggregate
// numbers, so large transaction histories never enter the model's context.

const INTERNAL_PAGE_SIZE = 500;
const MAX_PAGES = 200;
// The /SalesOrders list rows carry no value fields (and null customerId/plantId),
// so values require fetching each matched order individually. Cap protects the API.
const ORDER_DETAIL_CAP = 5000;
const PRODUCTION_DETAIL_CAP = 2500;
const ORDER_DETAIL_CONCURRENCY = 12;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface PaginationData {
  totalCount?: number;
  pageSize?: number;
  currentPage?: number;
  totalPages?: number;
  nextPageLink?: string | null;
}

interface PagedFetchResult {
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
    return { rows, skipped: 0, pagination: (data.paginationData ?? undefined) as PaginationData | undefined };
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

async function fetchAllPages(
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
const skippedNote = (skipped: number) =>
  skipped > 0
    ? {
        skippedRecords: skipped,
        skippedNote:
          `${skipped} record(s) could not be retrieved from the Titan API (persistent server ` +
          "errors on those records) and are excluded from all sums.",
      }
    : {};

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Normalizes an ISO date/date-time string to YYYY-MM-DD; empty string if absent. */
function datePart(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

function inRange(dateYmd: string, start?: string, end?: string): boolean {
  if (!start && !end) return true;
  if (!dateYmd) return false;
  if (start && dateYmd < start.slice(0, 10)) return false;
  if (end && dateYmd > end.slice(0, 10)) return false;
  return true;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** True unless the row's plant is in the configured TITAN_EXCLUDED_PLANTS set. */
const plantAllowed = (excluded: Set<string>, plant: unknown): boolean =>
  !excluded.has(String(plant ?? "").toUpperCase());

const excludedPlantsNote = (excluded: Set<string>) =>
  excluded.size > 0 ? { excludedPlants: [...excluded].sort() } : {};

interface GroupSpec {
  /** Returns the grouping key for a row, e.g. "2025" or a customer ID. */
  key: (row: Record<string, unknown>, dateField: string) => string;
  /** Optional human-readable label field captured from the first row seen. */
  label?: (row: Record<string, unknown>) => string | undefined;
}

const groupSpecs: Record<string, GroupSpec> = {
  year: { key: (row, dateField) => datePart(row[dateField]).slice(0, 4) || "unknown" },
  month: { key: (row, dateField) => datePart(row[dateField]).slice(0, 7) || "unknown" },
  customer: {
    key: (row) => String(row.customerId ?? row.customerName ?? row.name ?? "unknown"),
    label: (row) => (row.customerName ?? row.name) as string | undefined,
  },
  plant: { key: (row) => String(row.plantId ?? row.plantID ?? "unknown") },
  salesRep: { key: (row) => String(row.salesRep ?? "unknown") },
  jobStatus: { key: (row) => String(row.jobStatus ?? "unknown") },
  product: {
    key: (row) => String(row.productID ?? row.productId ?? "unknown"),
    label: (row) => row.description as string | undefined,
  },
  department: { key: (row) => String(row.productionDepartment ?? "unknown") },
};

function aggregate(
  rows: Record<string, unknown>[],
  sumFields: string[],
  dateField: string,
  groupBy?: string
): {
  count: number;
  totals: Record<string, number>;
  groups?: Record<string, unknown>[];
} {
  const totals: Record<string, number> = Object.fromEntries(sumFields.map((f) => [f, 0]));
  for (const row of rows) {
    for (const f of sumFields) totals[f] += toNumber(row[f]);
  }
  for (const f of sumFields) totals[f] = round2(totals[f]);

  const result: ReturnType<typeof aggregate> = { count: rows.length, totals };

  const spec = groupBy ? groupSpecs[groupBy] : undefined;
  if (spec) {
    const byKey = new Map<string, { count: number; label?: string; sums: Record<string, number> }>();
    for (const row of rows) {
      const key = spec.key(row, dateField);
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = {
          count: 0,
          ...(spec.label ? { label: spec.label(row) } : {}),
          sums: Object.fromEntries(sumFields.map((f) => [f, 0])),
        };
        byKey.set(key, bucket);
      }
      bucket.count++;
      for (const f of sumFields) bucket.sums[f] += toNumber(row[f]);
    }
    result.groups = [...byKey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, bucket]) => ({
        [groupBy!]: key,
        ...(bucket.label !== undefined ? { name: bucket.label } : {}),
        count: bucket.count,
        ...Object.fromEntries(sumFields.map((f) => [f, round2(bucket.sums[f])])),
      }));
  }
  return result;
}

export interface AggregateToolDef {
  name: string;
  title: string;
  description: string;
  params: ZodRawShape;
  handler: (client: TitanClient, args: Record<string, unknown>) => Promise<unknown>;
}

const groupByParam = (values: [string, ...string[]], hint: string) =>
  z.enum(values).optional().describe(`Optional grouping for subtotals: ${hint}.`);

export const aggregateToolDefs: AggregateToolDef[] = [
  {
    name: "summarize_sales_orders",
    title: "Summarize sales orders",
    description:
      "Aggregates sales orders (bookings) without returning individual orders: finds matching " +
      "orders server-side, fetches their values, and returns counts and summed " +
      "bookedValue/estimatedValue, optionally grouped. Use this instead of list_sales_orders " +
      "for questions about sales totals, e.g. a customer's annual sales. Dates filter on the " +
      "order date (inclusive). Value sums are available when at most 5000 orders match (a " +
      "company-wide year is fine); narrow the filters if exceeded. GroupBy product (or a " +
      "ProductID filter) switches to order DETAIL LINES and sums sellValue " +
      "(quantityOrdered x sellUnitPrice), quantityOrdered, and yards per product - use that " +
      "for questions like which products sold the most in dollars.",
    params: {
      CustomerId: z.string().optional().describe("Filter by customer ID (recommended when known)."),
      PlantId: z.string().optional().describe("Filter by plant ID."),
      JobStatus: z.string().optional().describe("Filter by job status."),
      ProductID: z.string().optional().describe("Only count order detail lines for this product ID."),
      OrderDateStart: z.string().optional().describe("Order date range start (YYYY-MM-DD, inclusive)."),
      OrderDateEnd: z.string().optional().describe("Order date range end (YYYY-MM-DD, inclusive)."),
      GroupBy: groupByParam(
        ["year", "month", "customer", "plant", "jobStatus", "salesRep", "product"],
        "year, month, customer, plant, jobStatus, salesRep, or product (product switches to detail-line sums)"
      ),
    },
    handler: async (client, args) => {
      const serverQuery: Record<string, unknown> = {
        CustomerId: args.CustomerId,
        JobStatus: args.JobStatus,
      };
      const { rows, pagesFetched, truncated, skipped } = await fetchAllPages(
        client,
        "/api/v1/SalesOrders",
        serverQuery
      );
      // List rows only reliably carry jobNumber/orderDate/jobStatus; values,
      // customerId, and plantId come from the per-order fetch below.
      const matched = rows.filter((row) =>
        inRange(datePart(row.orderDate), args.OrderDateStart as string, args.OrderDateEnd as string)
      );

      const base = {
        measure: "sales orders (bookings); sums are bookedValue and estimatedValue",
        filters: {
          CustomerId: args.CustomerId ?? null,
          PlantId: args.PlantId ?? null,
          JobStatus: args.JobStatus ?? null,
          ProductID: args.ProductID ?? null,
          OrderDateStart: args.OrderDateStart ?? null,
          OrderDateEnd: args.OrderDateEnd ?? null,
          ...excludedPlantsNote(client.excludedPlants),
        },
        scanned: rows.length,
        pagesFetched,
        ...(truncated
          ? { warning: `Result truncated after ${MAX_PAGES} pages; totals are incomplete. Narrow the filters.` }
          : {}),
        ...skippedNote(skipped),
      };

      if (matched.length > ORDER_DETAIL_CAP) {
        return {
          ...base,
          count: matched.length,
          totals: null,
          message:
            `${matched.length} orders match, which exceeds the ${ORDER_DETAIL_CAP}-order limit for ` +
            "value summation (the Titan order list carries no value fields, so each order must be " +
            "fetched individually). Narrow the filters (customer, shorter date range, job status) " +
            "and call this tool again — do not substitute invoice data for sales." +
            (args.PlantId != null ? " Note: the PlantId filter was NOT applied to this count." : ""),
        };
      }

      // Product mode: dollar value per product lives on order detail lines
      // (sellValue = quantityOrdered x sellUnitPrice, confirmed with the user).
      if (args.GroupBy === "product" || args.ProductID != null) {
        const detailBatches = await mapLimit(matched, ORDER_DETAIL_CONCURRENCY, async (row) => {
          const details = await fetchAllPages(
            client,
            `/api/v1/salesorders/${encodeURIComponent(String(row.jobNumber))}/SalesOrderDetails`,
            {}
          );
          return details.rows.map(
            (line): Record<string, unknown> => ({
              ...line,
              orderDate: row.orderDate,
              customerName: row.customerName,
              sellValue: toNumber(line.quantityOrdered) * toNumber(line.sellUnitPrice),
            })
          );
        });
        let lines = detailBatches
          .flat()
          .filter(
            (line) =>
              plantAllowed(client.excludedPlants, line.plantID) &&
              (args.PlantId == null || String(line.plantID) === String(args.PlantId))
          );
        if (args.ProductID != null) {
          const wanted = String(args.ProductID).toUpperCase();
          lines = lines.filter(
            (line) => String(line.productId ?? line.productID ?? "").toUpperCase() === wanted
          );
        }
        return {
          ...base,
          measure:
            "sales order detail lines (bookings); sums are sellValue " +
            "(quantityOrdered x sellUnitPrice), quantityOrdered, and yards",
          ...aggregate(
            lines,
            ["sellValue", "quantityOrdered", "yards"],
            "orderDate",
            (args.GroupBy as string) ?? "product"
          ),
        };
      }

      const fullOrders = await mapLimit(matched, ORDER_DETAIL_CONCURRENCY, async (row) => {
        const data = await client.get(
          `/api/v1/SalesOrders/${encodeURIComponent(String(row.jobNumber))}`
        );
        return (data.result ?? {}) as Record<string, unknown>;
      });
      const filtered = fullOrders.filter(
        (row) =>
          (args.PlantId == null || String(row.plantId) === String(args.PlantId)) &&
          plantAllowed(client.excludedPlants, row.plantId)
      );
      return {
        ...base,
        ...aggregate(filtered, ["bookedValue", "estimatedValue"], "orderDate", args.GroupBy as string),
      };
    },
  },
  {
    name: "summarize_production",
    title: "Summarize production",
    description:
      "Aggregates posted production output without returning individual entries: finds matching " +
      "production entries server-side (plant, department, type, production date range apply at " +
      "the API), fetches their detail lines, and returns summed quantity, quantityProd, yards, " +
      "cubicMeters, and tons - optionally filtered to one product and/or grouped. Use this for " +
      "questions like how many yards of a product were produced in a timeframe. Detail sums are " +
      "available when at most 2500 entries match (roughly a quarter company-wide); narrow the " +
      "date range, plant, or department if exceeded.",
    params: {
      PlantID: z.string().optional().describe("Filter by plant ID."),
      ProductionDepartment: z.string().optional().describe("Filter by production department."),
      Type: z.string().optional().describe("Filter by entry type (e.g. Standard, Reversal)."),
      ProductID: z.string().optional().describe("Only count detail lines for this product ID."),
      StartProductionDate: z.string().optional().describe("Production date range start (YYYY-MM-DD, inclusive)."),
      EndProductionDate: z.string().optional().describe("Production date range end (YYYY-MM-DD, inclusive)."),
      GroupBy: groupByParam(
        ["year", "month", "plant", "product", "department"],
        "year, month, plant, product, or department"
      ),
    },
    handler: async (client, args) => {
      const serverQuery: Record<string, unknown> = {
        PlantID: args.PlantID,
        ProductionDepartment: args.ProductionDepartment,
        Type: args.Type,
        StartProductionDate: args.StartProductionDate,
        EndProductionDate: args.EndProductionDate,
      };
      const { rows, pagesFetched, truncated, skipped } = await fetchAllPages(
        client,
        "/api/v1/ProductionEntries",
        serverQuery
      );
      const kept = rows.filter((row) => plantAllowed(client.excludedPlants, row.plantID));

      const base = {
        measure:
          "posted production entry detail lines; sums are quantity (scheduled), " +
          "quantityProd (produced), yards, cubicMeters, and tons",
        filters: {
          PlantID: args.PlantID ?? null,
          ProductionDepartment: args.ProductionDepartment ?? null,
          Type: args.Type ?? null,
          ProductID: args.ProductID ?? null,
          StartProductionDate: args.StartProductionDate ?? null,
          EndProductionDate: args.EndProductionDate ?? null,
          ...excludedPlantsNote(client.excludedPlants),
        },
        entriesMatched: kept.length,
        pagesFetched,
        ...(truncated
          ? { warning: `Result truncated after ${MAX_PAGES} pages; totals are incomplete. Narrow the filters.` }
          : {}),
        ...skippedNote(skipped),
      };

      if (kept.length > PRODUCTION_DETAIL_CAP) {
        return {
          ...base,
          totals: null,
          message:
            `${kept.length} production entries match, which exceeds the ${PRODUCTION_DETAIL_CAP}-entry ` +
            "limit for detail summation (the entry list carries no detail lines, so each entry " +
            "must be fetched individually). Narrow the production date range, plant, or department.",
        };
      }

      const fullEntries = await mapLimit(kept, ORDER_DETAIL_CONCURRENCY, async (row) => {
        const data = await client.get(
          `/api/v1/ProductionEntries/${encodeURIComponent(String(row.productionID))}`
        );
        return (data.result ?? {}) as Record<string, unknown>;
      });
      let lines: Record<string, unknown>[] = fullEntries.flatMap((entry) =>
        (Array.isArray(entry.details) ? (entry.details as Record<string, unknown>[]) : []).map(
          (line): Record<string, unknown> => ({
            ...line,
            date: entry.date,
            productionDepartment: line.productionDepartment ?? entry.productionDepartment,
            plantID: line.plantID ?? entry.plantID,
          })
        )
      );
      if (args.ProductID != null) {
        const wanted = String(args.ProductID).toUpperCase();
        lines = lines.filter((line) => String(line.productID ?? "").toUpperCase() === wanted);
      }
      return {
        ...base,
        ...aggregate(
          lines,
          ["quantity", "quantityProd", "yards", "cubicMeters", "tons"],
          "date",
          args.GroupBy as string
        ),
      };
    },
  },
  {
    name: "summarize_invoices",
    title: "Summarize invoices",
    description:
      "Aggregates posted customer (AR) invoices without returning individual invoices: pages " +
      "through the full result set server-side and returns counts and summed subtotal/tax/total, " +
      "optionally grouped. Use this instead of list_invoices for questions about invoiced/billed " +
      "revenue totals. Dates filter on the invoice date (inclusive). Credit invoices are included " +
      "as returned by the API (negative or credit amounts net against totals).",
    params: {
      CustomerId: z.string().optional().describe("Filter by customer ID (recommended when known)."),
      PlantId: z.string().optional().describe("Filter by plant ID."),
      TicketType: z.string().optional().describe("Filter by ticket type."),
      StartDate: z.string().optional().describe("Invoice date range start (YYYY-MM-DD, inclusive)."),
      EndDate: z.string().optional().describe("Invoice date range end (YYYY-MM-DD, inclusive)."),
      GroupBy: groupByParam(
        ["year", "month", "customer", "plant", "salesRep"],
        "year, month, customer, plant, or salesRep"
      ),
    },
    handler: async (client, args) => {
      const serverQuery: Record<string, unknown> = {
        CustomerId: args.CustomerId,
        PlantId: args.PlantId,
        TicketType: args.TicketType,
        StartDate: args.StartDate,
        EndDate: args.EndDate,
      };
      const { rows, pagesFetched, truncated, skipped } = await fetchAllPages(
        client,
        "/api/v1/Invoices",
        serverQuery
      );
      const kept = rows.filter((row) => plantAllowed(client.excludedPlants, row.plantId));
      return {
        measure: "posted AR invoices (billed revenue); sums are subtotal, tax, and total",
        filters: {
          CustomerId: args.CustomerId ?? null,
          PlantId: args.PlantId ?? null,
          TicketType: args.TicketType ?? null,
          StartDate: args.StartDate ?? null,
          EndDate: args.EndDate ?? null,
          ...excludedPlantsNote(client.excludedPlants),
        },
        scanned: rows.length,
        pagesFetched,
        ...(truncated ? { warning: `Result truncated after ${MAX_PAGES} pages; totals are incomplete. Narrow the filters.` } : {}),
        ...skippedNote(skipped),
        ...aggregate(kept, ["subtotal", "tax", "total"], "invoiceDate", args.GroupBy as string),
      };
    },
  },
];



