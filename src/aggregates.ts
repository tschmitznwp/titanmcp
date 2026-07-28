import { z, type ZodRawShape } from "zod";
import type { ProductCatalog, TitanClient } from "./titanClient.js";
import type { OrderIndex, OrderIndexEntry } from "./orderIndex.js";
import {
  MAX_PAGES,
  datePart,
  dateOrNull,
  excludedPlantsNote,
  fetchAllPages,
  inRange,
  mapLimit,
  plantAllowed,
  round2,
  shiftDays,
  skippedNote,
  toNumber,
} from "./shared.js";

// Derived, read-only summary tools. Each pages through a Titan list endpoint
// inside this server (cheap HTTP round-trips) and returns only aggregate
// numbers, so large transaction histories never enter the model's context.

// The /SalesOrders list rows carry no value fields, no bookedDate, and null
// customerId/plantId, so anything beyond jobNumber/orderDate/jobStatus requires
// fetching each matched order individually. Caps protect the API when the
// background order index (orderIndex.ts) is not available to answer instead.
const ORDER_DETAIL_CAP = 5000;
const PRODUCTION_DETAIL_CAP = 2500;
const ORDER_DETAIL_CONCURRENCY = 12;
// How long a tool call waits for a first-time index build before falling back.
// Kept short: the first build takes minutes, so waiting rarely helps, and the
// fallback scan needs the remaining time budget before the client times out.
const INDEX_WAIT_MS = 8_000;
/** Default look-back when scanning for bookings without the index. */
const FALLBACK_SCAN_DAYS = 365;

export interface ToolContext {
  client: TitanClient;
  orderIndex: OrderIndex;
}

async function tryGetProductCatalog(client: TitanClient): Promise<ProductCatalog | undefined> {
  try {
    return await client.getProductCatalog();
  } catch {
    return undefined;
  }
}

function resolveProduct(productID: string, catalog: ProductCatalog | undefined) {
  const hit = catalog?.get(productID);
  return {
    productID,
    productName: hit?.description ?? null,
    resolved: hit != null,
    ...(hit?.unitOfMeasure ? { unitOfMeasure: hit.unitOfMeasure } : {}),
  };
}

function enrichProductGroups(
  groups: Record<string, unknown>[] | undefined,
  catalog: ProductCatalog | undefined
): Record<string, unknown>[] | undefined {
  if (!groups || !catalog) return groups;
  return groups.map((g) => {
    const productID = g.product;
    if (typeof productID !== "string") return g;
    const hit = catalog.get(productID);
    return {
      ...g,
      productName: hit?.description ?? null,
      resolved: hit != null,
      ...(hit?.unitOfMeasure ? { unitOfMeasure: hit.unitOfMeasure } : {}),
    };
  });
}

const CATALOG_UNAVAILABLE_NOTE = {
  productCatalogUnavailable: true,
  productCatalogNote:
    "The product catalog could not be fetched from the Titan API, so productIDs in this " +
    "response are unverified. Present them as raw codes without inventing product names.",
};

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

// ---------------------------------------------------------------------------
// Sales-order resolution (shared by the booked-date tools)
// ---------------------------------------------------------------------------

interface OrderFilter {
  bookedDateStart?: string;
  bookedDateEnd?: string;
  orderDateStart?: string;
  orderDateEnd?: string;
  customerId?: string;
  plantId?: string;
  jobStatus?: string;
  salesRep?: string;
}

interface ResolvedOrders {
  orders: OrderIndexEntry[];
  coverage: Record<string, unknown>;
  /** Response fields describing skipped/unreadable records. */
  notes: Record<string, unknown>;
}

const eqIgnoreCase = (a: unknown, b: unknown): boolean =>
  String(a ?? "").toUpperCase() === String(b ?? "").toUpperCase();

function matchesAttributes(entry: OrderIndexEntry, filter: OrderFilter, excluded: Set<string>): boolean {
  if (filter.customerId != null && !eqIgnoreCase(entry.customerId, filter.customerId)) return false;
  if (filter.plantId != null && !eqIgnoreCase(entry.plantId, filter.plantId)) return false;
  if (filter.jobStatus != null && !eqIgnoreCase(entry.jobStatus, filter.jobStatus)) return false;
  if (filter.salesRep != null && !eqIgnoreCase(entry.salesRep, filter.salesRep)) return false;
  return plantAllowed(excluded, entry.plantId);
}

/**
 * Fetches full sales orders for every listing row whose orderDate falls in the
 * given window. This is the no-index fallback: the listing carries neither
 * bookedDate nor values, so each order has to be fetched individually.
 */
async function scanOrders(
  client: TitanClient,
  orderDateStart: string | undefined,
  orderDateEnd: string | undefined,
  serverQuery: Record<string, unknown>
): Promise<{ orders: OrderIndexEntry[]; scanned: number; matched: number; pagesFetched: number; truncated: boolean; skipped: number }> {
  const { rows, pagesFetched, truncated, skipped } = await fetchAllPages(
    client,
    "/api/v1/SalesOrders",
    serverQuery
  );
  const candidates = rows.filter((row) =>
    inRange(datePart(row.orderDate), orderDateStart, orderDateEnd)
  );
  if (candidates.length > ORDER_DETAIL_CAP) {
    throw new Error(
      `${candidates.length} sales orders fall in the scanned window, which exceeds the ` +
        `${ORDER_DETAIL_CAP}-order limit for individual fetches (the Titan order list carries ` +
        "neither bookedDate nor values, so each order must be fetched one at a time). Narrow " +
        "the request (customer, shorter range) or wait for the background order index to finish " +
        "building — check it with get_order_index_status."
    );
  }
  const fetched = await mapLimit(candidates, ORDER_DETAIL_CONCURRENCY, async (row) => {
    const jobNumber = String(row.jobNumber);
    try {
      const data = await client.get(`/api/v1/SalesOrders/${encodeURIComponent(jobNumber)}`);
      const order = (data.result ?? {}) as Record<string, unknown>;
      const entry: OrderIndexEntry = {
        jobNumber,
        orderDate: dateOrNull(order.orderDate) ?? dateOrNull(row.orderDate),
        bookedDate: dateOrNull(order.bookedDate),
        quotedDate: dateOrNull(order.quotedDate),
        customerId: (order.customerId as string) ?? null,
        customerName: (order.customerName as string) ?? (row.customerName as string) ?? null,
        jobName: (order.jobName as string) ?? null,
        plantId: (order.plantId as string) ?? null,
        jobStatus: (order.jobStatus as string) ?? (row.jobStatus as string) ?? null,
        salesRep: (order.salesRep as string) ?? null,
        bookedValue: toNumber(order.bookedValue),
        estimatedValue: toNumber(order.estimatedValue),
        indexedAt: Date.now(),
      };
      return entry;
    } catch {
      return null;
    }
  });
  const orders = fetched.filter((o): o is OrderIndexEntry => o != null);
  return {
    orders,
    scanned: rows.length,
    matched: candidates.length,
    pagesFetched,
    truncated,
    skipped: skipped + (candidates.length - orders.length),
  };
}

/**
 * Returns the sales orders matching `filter`, preferring the background index
 * (complete and instant) and falling back to a bounded live scan.
 *
 * The fallback CANNOT be complete for booked-date questions: an order booked
 * last week may have been entered years ago, and only an orderDate window can
 * bound a live scan. That limitation is reported in `coverage`, never hidden.
 */
async function resolveOrders(ctx: ToolContext, filter: OrderFilter): Promise<ResolvedOrders> {
  const excluded = ctx.client.excludedPlants;
  const wantsBooked = filter.bookedDateStart != null || filter.bookedDateEnd != null;

  if (await ctx.orderIndex.ensureReady(INDEX_WAIT_MS)) {
    const status = ctx.orderIndex.status();
    const orders = ctx.orderIndex
      .query({ ...filter, excludedPlants: excluded })
      .filter((entry) => matchesAttributes(entry, filter, excluded));
    return {
      orders,
      coverage: {
        basis: "index",
        complete: status.coversOrdersFrom == null,
        ordersIndexed: status.orders,
        indexBuiltAt: status.builtAt,
        indexLastRefreshedAt: status.lastRefreshAt,
        ...(status.refreshing ? { indexRefreshInProgress: true } : {}),
        ...(status.coversOrdersFrom != null
          ? {
              indexCoversOrdersEnteredFrom: status.coversOrdersFrom,
              indexFloorNote:
                `This deployment only indexes orders entered on or after ${status.coversOrdersFrom} ` +
                "(TITAN_ORDER_INDEX_MIN_ORDER_DATE). An older order booked in the requested " +
                "period would not appear here.",
            }
          : {}),
      },
      notes:
        status.failedOrders > 0
          ? {
              unreadableOrders: status.failedOrders,
              unreadableNote:
                `${status.failedOrders} order(s) could not be read from the Titan API and are ` +
                "excluded from these results.",
            }
          : {},
    };
  }

  // No index: bound the live scan by orderDate.
  const status = ctx.orderIndex.status();
  const scanFrom = wantsBooked
    ? filter.orderDateStart ??
      (filter.bookedDateStart ? shiftDays(filter.bookedDateStart, -FALLBACK_SCAN_DAYS) : undefined)
    : filter.orderDateStart;
  const scanTo = wantsBooked ? filter.orderDateEnd ?? filter.bookedDateEnd : filter.orderDateEnd;

  const scan = await scanOrders(ctx.client, scanFrom, scanTo, {
    CustomerId: filter.customerId,
    JobStatus: filter.jobStatus,
  });

  const orders = scan.orders.filter(
    (entry) =>
      matchesAttributes(entry, filter, excluded) &&
      (!wantsBooked ||
        (entry.bookedDate != null &&
          inRange(entry.bookedDate, filter.bookedDateStart, filter.bookedDateEnd))) &&
      inRange(entry.orderDate ?? "", filter.orderDateStart, filter.orderDateEnd)
  );

  return {
    orders,
    coverage: {
      basis: "partialScan",
      complete: !wantsBooked,
      scannedOrderDateFrom: scanFrom ?? null,
      scannedOrderDateTo: scanTo ?? null,
      ordersScanned: scan.matched,
      indexState: status.state,
      ...(status.state === "building"
        ? {
            indexProgress: `${status.buildFetched} fetched, ${status.buildRemaining} remaining of ` +
              `${status.totalOrders ?? "?"} orders`,
          }
        : {}),
      ...(wantsBooked
        ? {
            incompleteWarning:
              "The booked-date index is not ready, so only orders with an orderDate between " +
              `${scanFrom ?? "the beginning"} and ${scanTo ?? "the end"} were examined. An order ` +
              "booked in the requested period but entered before that window is MISSING from " +
              "these results. Report this caveat, or re-run once the index is ready " +
              "(get_order_index_status).",
          }
        : {}),
    },
    notes: {
      ...skippedNote(scan.skipped),
      ...(scan.truncated
        ? { warning: `Scan truncated after ${MAX_PAGES} pages; results are incomplete.` }
        : {}),
    },
  };
}

/** Compact order row returned to the model. */
function presentOrder(entry: OrderIndexEntry) {
  return {
    jobNumber: entry.jobNumber,
    bookedDate: entry.bookedDate,
    orderDate: entry.orderDate,
    customerId: entry.customerId,
    customerName: entry.customerName,
    jobName: entry.jobName,
    plantId: entry.plantId,
    jobStatus: entry.jobStatus,
    salesRep: entry.salesRep,
    bookedValue: round2(entry.bookedValue),
    estimatedValue: round2(entry.estimatedValue),
  };
}

export interface AggregateToolDef {
  name: string;
  title: string;
  description: string;
  params: ZodRawShape;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

const groupByParam = (values: [string, ...string[]], hint: string) =>
  z.enum(values).optional().describe(`Optional grouping for subtotals: ${hint}.`);

export const aggregateToolDefs: AggregateToolDef[] = [
  {
    name: "list_booked_orders",
    title: "List orders booked in a period",
    description:
      "Lists the individual sales orders whose bookedDate falls inside a date range, with each " +
      "order's bookedDate, bookedValue, customer, plant, sales rep and status, plus the count " +
      "and summed bookedValue for the whole match. THIS IS THE TOOL FOR 'orders booked in " +
      "<period>' / 'what did we book last week' — the Titan API itself has NO bookedDate filter, " +
      "and list_sales_orders/OrderDate filters on when the order was ENTERED, which is a " +
      "different (usually much larger) set. Answers come from a background index of every sales " +
      "order; if that index is still building, the tool falls back to a bounded scan and says so " +
      "in coverage.incompleteWarning — repeat that caveat to the user rather than presenting " +
      "partial results as complete.",
    params: {
      BookedDateStart: z
        .string()
        .describe("Booked date range start (YYYY-MM-DD, inclusive). Required."),
      BookedDateEnd: z
        .string()
        .describe("Booked date range end (YYYY-MM-DD, inclusive). Required."),
      CustomerId: z.string().optional().describe("Filter by customer ID."),
      PlantId: z.string().optional().describe("Filter by plant ID."),
      JobStatus: z.string().optional().describe("Filter by job status."),
      SalesRep: z.string().optional().describe("Filter by sales rep."),
      MinBookedValue: z
        .number()
        .optional()
        .describe("Only orders whose bookedValue is at least this amount."),
      SortBy: z
        .enum(["bookedDate", "bookedValue", "customer", "plant"])
        .optional()
        .describe("Sort order for the returned rows (default bookedDate, then value descending)."),
      Limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Maximum order rows to return (default 200). Totals always cover ALL matches."),
      OrderDateStart: z
        .string()
        .optional()
        .describe("Optional extra filter on the order (entry) date, range start."),
      OrderDateEnd: z
        .string()
        .optional()
        .describe("Optional extra filter on the order (entry) date, range end."),
    },
    handler: async (ctx, args) => {
      const bookedDateStart = String(args.BookedDateStart ?? "").slice(0, 10);
      const bookedDateEnd = String(args.BookedDateEnd ?? "").slice(0, 10);
      if (!bookedDateStart || !bookedDateEnd) {
        throw new Error("BookedDateStart and BookedDateEnd are required (YYYY-MM-DD).");
      }
      if (bookedDateStart > bookedDateEnd) {
        throw new Error(
          `BookedDateStart (${bookedDateStart}) is after BookedDateEnd (${bookedDateEnd}).`
        );
      }

      const filter: OrderFilter = {
        bookedDateStart,
        bookedDateEnd,
        ...(args.OrderDateStart != null ? { orderDateStart: String(args.OrderDateStart) } : {}),
        ...(args.OrderDateEnd != null ? { orderDateEnd: String(args.OrderDateEnd) } : {}),
        ...(args.CustomerId != null ? { customerId: String(args.CustomerId) } : {}),
        ...(args.PlantId != null ? { plantId: String(args.PlantId) } : {}),
        ...(args.JobStatus != null ? { jobStatus: String(args.JobStatus) } : {}),
        ...(args.SalesRep != null ? { salesRep: String(args.SalesRep) } : {}),
      };

      const { orders, coverage, notes } = await resolveOrders(ctx, filter);
      const minValue = args.MinBookedValue == null ? null : Number(args.MinBookedValue);
      const matched = minValue == null ? orders : orders.filter((o) => o.bookedValue >= minValue);

      const sortBy = (args.SortBy as string) ?? "bookedDate";
      const sorted = [...matched].sort((a, b) => {
        switch (sortBy) {
          case "bookedValue":
            return b.bookedValue - a.bookedValue;
          case "customer":
            return String(a.customerName ?? "").localeCompare(String(b.customerName ?? ""));
          case "plant":
            return String(a.plantId ?? "").localeCompare(String(b.plantId ?? ""));
          default: {
            const d = String(a.bookedDate ?? "").localeCompare(String(b.bookedDate ?? ""));
            return d !== 0 ? d : b.bookedValue - a.bookedValue;
          }
        }
      });

      const limit = Math.min(Number(args.Limit ?? 200), 2000);
      const returned = sorted.slice(0, limit);

      return {
        measure: "sales orders whose bookedDate falls in the requested range",
        dateBasis: "bookedDate (when the order was booked, NOT when it was entered)",
        filters: {
          BookedDateStart: bookedDateStart,
          BookedDateEnd: bookedDateEnd,
          CustomerId: args.CustomerId ?? null,
          PlantId: args.PlantId ?? null,
          JobStatus: args.JobStatus ?? null,
          SalesRep: args.SalesRep ?? null,
          MinBookedValue: minValue,
          OrderDateStart: args.OrderDateStart ?? null,
          OrderDateEnd: args.OrderDateEnd ?? null,
          ...excludedPlantsNote(ctx.client.excludedPlants),
        },
        coverage,
        ...notes,
        count: matched.length,
        totals: {
          bookedValue: round2(matched.reduce((sum, o) => sum + o.bookedValue, 0)),
          estimatedValue: round2(matched.reduce((sum, o) => sum + o.estimatedValue, 0)),
        },
        returned: returned.length,
        ...(returned.length < matched.length
          ? {
              truncated: true,
              truncationNote:
                `Showing ${returned.length} of ${matched.length} matching orders (Limit). The ` +
                "count and totals above cover all matches; raise Limit to list more.",
            }
          : {}),
        orders: returned.map(presentOrder),
      };
    },
  },
  {
    name: "get_order_index_status",
    title: "Get sales-order index status",
    description:
      "Reports the state of the background sales-order index that powers bookedDate queries " +
      "(list_booked_orders and summarize_sales_orders with DateBasis=booked). Use it when one of " +
      "those tools reports coverage.basis=partialScan, to tell the user whether a complete answer " +
      "is available yet and how far along the build is.",
    params: {},
    handler: async (ctx) => {
      ctx.orderIndex.kick();
      const status = ctx.orderIndex.status();
      return {
        ...status,
        explanation:
          status.state === "ready"
            ? "The index is ready; bookedDate queries return complete results."
            : status.state === "building"
              ? "The index is still being built (every sales order must be fetched individually " +
                "because the Titan list endpoint omits bookedDate). Booked-date queries fall back " +
                "to a bounded, incomplete scan until it finishes."
              : status.state === "disabled"
                ? "The index is disabled (TITAN_ORDER_INDEX=false); booked-date queries can only " +
                  "use bounded scans and cannot be complete."
                : "The index has not started yet.",
      };
    },
  },
  {
    name: "summarize_sales_orders",
    title: "Summarize sales orders",
    description:
      "Aggregates sales orders (bookings) without returning individual orders: finds matching " +
      "orders, fetches their values, and returns counts and summed bookedValue/estimatedValue, " +
      "optionally grouped. Use this instead of list_sales_orders for questions about sales " +
      "totals, e.g. a customer's annual sales. DATE BASIS MATTERS: by default dates filter on " +
      "the ORDER (entry) date via OrderDateStart/OrderDateEnd. For 'booked in <period>' " +
      "questions set DateBasis=booked and pass BookedDateStart/BookedDateEnd instead — the two " +
      "give very different numbers, and the Titan API has no bookedDate filter of its own (this " +
      "server maintains an index for it). GroupBy product (or a ProductID filter) switches to " +
      "order DETAIL LINES and sums sellValue (quantityOrdered x sellUnitPrice), quantityOrdered, " +
      "and yards per product - use that for questions like which products sold the most in " +
      "dollars. When grouped by product each group is enriched with productName (from the Titan " +
      "product catalog) and a resolved boolean; resolved=false means the productID has no " +
      "catalog entry - report it verbatim and do NOT invent a name for it. Check coverage in the " +
      "response: basis=partialScan means the result may be incomplete.",
    params: {
      DateBasis: z
        .enum(["order", "booked"])
        .optional()
        .describe(
          "Which date the range filters and year/month groupings use: 'order' (default, the " +
            "order/entry date) or 'booked' (the bookedDate). Use 'booked' for booking reports."
        ),
      CustomerId: z.string().optional().describe("Filter by customer ID (recommended when known)."),
      PlantId: z.string().optional().describe("Filter by plant ID."),
      JobStatus: z.string().optional().describe("Filter by job status."),
      SalesRep: z.string().optional().describe("Filter by sales rep."),
      ProductID: z.string().optional().describe("Only count order detail lines for this product ID."),
      OrderDateStart: z.string().optional().describe("Order (entry) date range start (YYYY-MM-DD, inclusive)."),
      OrderDateEnd: z.string().optional().describe("Order (entry) date range end (YYYY-MM-DD, inclusive)."),
      BookedDateStart: z.string().optional().describe("Booked date range start (YYYY-MM-DD, inclusive)."),
      BookedDateEnd: z.string().optional().describe("Booked date range end (YYYY-MM-DD, inclusive)."),
      GroupBy: groupByParam(
        ["year", "month", "customer", "plant", "jobStatus", "salesRep", "product"],
        "year, month, customer, plant, jobStatus, salesRep, or product (product switches to detail-line sums)"
      ),
    },
    handler: async (ctx, args) => {
      const hasBookedRange = args.BookedDateStart != null || args.BookedDateEnd != null;
      const basis = (args.DateBasis as string) ?? (hasBookedRange ? "booked" : "order");
      if (basis === "booked" && !hasBookedRange) {
        throw new Error(
          "DateBasis=booked requires BookedDateStart and/or BookedDateEnd (OrderDateStart/" +
            "OrderDateEnd filter the order entry date, which is a different measure). Call this " +
            "tool again with the booked-date range."
        );
      }

      const filter: OrderFilter = {
        ...(args.BookedDateStart != null ? { bookedDateStart: String(args.BookedDateStart) } : {}),
        ...(args.BookedDateEnd != null ? { bookedDateEnd: String(args.BookedDateEnd) } : {}),
        ...(args.OrderDateStart != null ? { orderDateStart: String(args.OrderDateStart) } : {}),
        ...(args.OrderDateEnd != null ? { orderDateEnd: String(args.OrderDateEnd) } : {}),
        ...(args.CustomerId != null ? { customerId: String(args.CustomerId) } : {}),
        ...(args.PlantId != null ? { plantId: String(args.PlantId) } : {}),
        ...(args.JobStatus != null ? { jobStatus: String(args.JobStatus) } : {}),
        ...(args.SalesRep != null ? { salesRep: String(args.SalesRep) } : {}),
      };

      const { orders, coverage, notes } = await resolveOrders(ctx, filter);
      const dateField = basis === "booked" ? "bookedDate" : "orderDate";

      const base = {
        measure:
          basis === "booked"
            ? "sales orders by bookedDate (bookings); sums are bookedValue and estimatedValue"
            : "sales orders by order (entry) date; sums are bookedValue and estimatedValue",
        dateBasis: dateField,
        filters: {
          DateBasis: basis,
          CustomerId: args.CustomerId ?? null,
          PlantId: args.PlantId ?? null,
          JobStatus: args.JobStatus ?? null,
          SalesRep: args.SalesRep ?? null,
          ProductID: args.ProductID ?? null,
          OrderDateStart: args.OrderDateStart ?? null,
          OrderDateEnd: args.OrderDateEnd ?? null,
          BookedDateStart: args.BookedDateStart ?? null,
          BookedDateEnd: args.BookedDateEnd ?? null,
          ...excludedPlantsNote(ctx.client.excludedPlants),
        },
        coverage,
        ...notes,
      };

      // Product mode: dollar value per product lives on order detail lines
      // (sellValue = quantityOrdered x sellUnitPrice, confirmed with the user).
      if (args.GroupBy === "product" || args.ProductID != null) {
        if (orders.length > ORDER_DETAIL_CAP) {
          return {
            ...base,
            count: orders.length,
            totals: null,
            message:
              `${orders.length} orders match, which exceeds the ${ORDER_DETAIL_CAP}-order limit ` +
              "for detail-line summation (each order's lines must be fetched individually). " +
              "Narrow the filters (customer, shorter date range, job status) and call again.",
          };
        }
        const [detailBatches, catalog] = await Promise.all([
          mapLimit(orders, ORDER_DETAIL_CONCURRENCY, async (order) => {
            const details = await fetchAllPages(
              ctx.client,
              `/api/v1/salesorders/${encodeURIComponent(order.jobNumber)}/SalesOrderDetails`,
              {}
            );
            return details.rows.map(
              (line): Record<string, unknown> => ({
                ...line,
                orderDate: order.orderDate,
                bookedDate: order.bookedDate,
                customerId: order.customerId,
                customerName: order.customerName,
                salesRep: order.salesRep,
                jobStatus: order.jobStatus,
                sellValue: toNumber(line.quantityOrdered) * toNumber(line.sellUnitPrice),
              })
            );
          }),
          tryGetProductCatalog(ctx.client),
        ]);
        let lines = detailBatches
          .flat()
          .filter(
            (line) =>
              plantAllowed(ctx.client.excludedPlants, line.plantID) &&
              (args.PlantId == null || String(line.plantID) === String(args.PlantId))
          );
        if (args.ProductID != null) {
          const wanted = String(args.ProductID).toUpperCase();
          lines = lines.filter(
            (line) => String(line.productId ?? line.productID ?? "").toUpperCase() === wanted
          );
        }
        const effectiveGroupBy = (args.GroupBy as string) ?? "product";
        const agg = aggregate(lines, ["sellValue", "quantityOrdered", "yards"], dateField, effectiveGroupBy);
        return {
          ...base,
          measure:
            "sales order detail lines (bookings); sums are sellValue " +
            "(quantityOrdered x sellUnitPrice), quantityOrdered, and yards",
          ...agg,
          ...(effectiveGroupBy === "product"
            ? { groups: enrichProductGroups(agg.groups, catalog) }
            : {}),
          ...(args.ProductID != null
            ? { product: resolveProduct(String(args.ProductID), catalog) }
            : {}),
          ...(catalog == null ? CATALOG_UNAVAILABLE_NOTE : {}),
        };
      }

      return {
        ...base,
        ...aggregate(
          orders as unknown as Record<string, unknown>[],
          ["bookedValue", "estimatedValue"],
          dateField,
          args.GroupBy as string
        ),
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
      "date range, plant, or department if exceeded. When grouped by product each group is " +
      "enriched with productName (from the Titan product catalog) and a resolved boolean; " +
      "resolved=false means the productID has no catalog entry - report it verbatim and do NOT " +
      "invent a name for it.",
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
    handler: async (ctx, args) => {
      const client = ctx.client;
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

      const [fullEntries, catalog] = await Promise.all([
        mapLimit(kept, ORDER_DETAIL_CONCURRENCY, async (row) => {
          const data = await client.get(
            `/api/v1/ProductionEntries/${encodeURIComponent(String(row.productionID))}`
          );
          return (data.result ?? {}) as Record<string, unknown>;
        }),
        args.GroupBy === "product" || args.ProductID != null
          ? tryGetProductCatalog(client)
          : Promise.resolve(undefined),
      ]);
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
      const agg = aggregate(
        lines,
        ["quantity", "quantityProd", "yards", "cubicMeters", "tons"],
        "date",
        args.GroupBy as string
      );
      const catalogUsed = args.GroupBy === "product" || args.ProductID != null;
      return {
        ...base,
        ...agg,
        ...(args.GroupBy === "product"
          ? { groups: enrichProductGroups(agg.groups, catalog) }
          : {}),
        ...(args.ProductID != null
          ? { product: resolveProduct(String(args.ProductID), catalog) }
          : {}),
        ...(catalogUsed && catalog == null ? CATALOG_UNAVAILABLE_NOTE : {}),
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
    handler: async (ctx, args) => {
      const client = ctx.client;
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
