import { z, type ZodRawShape } from "zod";
import type {
  CatalogCustomer,
  CatalogProduct,
  ProductCatalog,
  TitanClient,
} from "./titanClient.js";
import type { OrderIndex, OrderIndexEntry } from "./orderIndex.js";
import {
  PERIOD_NAMES,
  PERIOD_DEFINITIONS,
  REPORTING_TIME_ZONE,
  resolvePeriod,
  todayInZone,
  type DateRange,
  type PeriodName,
} from "./periods.js";
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

// --- Response self-description (WI-2) -------------------------------------

/** Absolute dates actually applied, normalized to YYYY-MM-DD. */
function resolvedRange(start: unknown, end: unknown) {
  const norm = (v: unknown) => (typeof v === "string" && v !== "" ? v.slice(0, 10) : null);
  return { start: norm(start), end: norm(end) };
}

/**
 * Permanent, disclosed narrowing of the result set (D-2). Kept separate from
 * `coverage.complete`, which means only "answered from a fully-built index" —
 * otherwise a deployment with a configured floor would report incomplete
 * forever and the flag would stop meaning anything.
 */
function scopeFields(
  excluded: Set<string>,
  coversOrdersFrom?: string | null
): {
  plantsExcluded?: string[];
  indexCoversOrdersEnteredFrom?: string;
  scopeNote?: string;
} {
  const notes: string[] = [];
  if (excluded.size > 0) {
    notes.push(
      `Totals exclude plant(s) ${[...excluded].sort().join(", ")} ` +
        "(TITAN_EXCLUDED_PLANTS); this is not a company-wide figure."
    );
  }
  if (coversOrdersFrom != null) {
    notes.push(
      `Only orders entered on or after ${coversOrdersFrom} are indexed ` +
        "(TITAN_ORDER_INDEX_MIN_ORDER_DATE); an older order booked in the requested " +
        "period would not appear."
    );
  }
  if (notes.length === 0) return {};
  return {
    ...(excluded.size > 0 ? { plantsExcluded: [...excluded].sort() } : {}),
    ...(coversOrdersFrom != null ? { indexCoversOrdersEnteredFrom: coversOrdersFrom } : {}),
    scopeNote: notes.join(" "),
  };
}

const periodParam = () =>
  z
    .enum(PERIOD_NAMES)
    .optional()
    .describe(
      "Named relative period, resolved by the SERVER against its own clock in " +
        `${REPORTING_TIME_ZONE} (calendar year; weeks run Sunday-Saturday). Prefer this over ` +
        "computing dates yourself. Mutually exclusive with the explicit start/end dates for " +
        "the same basis. The absolute range applied comes back as resolvedRange."
    );

/**
 * Resolves a Period to a concrete range, refusing to guess when explicit dates were
 * also supplied (WI-3). Returns undefined when no Period was given.
 */
function periodRange(
  period: unknown,
  explicit: { start?: unknown; end?: unknown },
  label: string
): DateRange | undefined {
  if (period == null) return undefined;
  if (explicit.start != null || explicit.end != null) {
    throw new Error(
      `Period and ${label} are mutually exclusive — pass one or the other, not both. ` +
        "Period resolves the range on the server against its own clock."
    );
  }
  return resolvePeriod(period as PeriodName, todayInZone());
}

/**
 * Order-basis totals sum booked dollars over orders bucketed by ENTRY date — a
 * legitimate figure and an easy one to mislabel as bookings. The measure differs
 * between header sums and detail-line (product) sums, so it is named explicitly.
 */
const orderBasisNote = (measureDesc: string) =>
  `Values are ${measureDesc} grouped by orderDate (entry date). This is NOT a bookings ` +
  "figure — for bookings use DateBasis=booked.";

async function tryGetProductCatalog(client: TitanClient): Promise<ProductCatalog | undefined> {
  try {
    return await client.getProductCatalog();
  } catch {
    return undefined;
  }
}

/** Catalog fields worth carrying alongside a product ID, when the catalog has them. */
function catalogFields(hit: CatalogProduct | undefined) {
  return {
    productName: hit?.productName ?? null,
    resolved: hit != null,
    ...(hit?.unitOfMeasure ? { unitOfMeasure: hit.unitOfMeasure } : {}),
    ...(hit?.type ? { type: hit.type } : {}),
    ...(hit?.partTypeID ? { partTypeID: hit.partTypeID } : {}),
    ...(hit?.productLine ? { productLine: hit.productLine } : {}),
  };
}

function resolveProduct(productID: string, catalog: ProductCatalog | undefined) {
  const hit = catalog?.get(productID);
  const displayName = hit?.productName ?? null;
  return {
    productID,
    ...catalogFields(hit),
    displayName,
    displayNameSource: displayName != null ? "catalog" : null,
    ...(displayName == null
      ? {
          displayNameNote:
            "No name exists for this product in Titan. Present the product code alone — do NOT " +
            "infer, expand, or invent a name from the letters in the code.",
        }
      : {}),
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
    // One unambiguous field to quote. With a catalog name, a line description and
    // a bare code all in play, the model picked none of them and expanded the code
    // instead ("CIMC" -> "Cast Iron Misc. Custom Structure", which is not the
    // product). displayName removes the choice.
    const lineName = typeof g.name === "string" && g.name !== "" ? g.name : null;
    const catalogName = hit?.productName ?? null;
    const displayName = catalogName ?? lineName;
    return {
      ...g,
      ...catalogFields(hit),
      displayName,
      displayNameSource: catalogName != null ? "catalog" : lineName != null ? "orderLine" : null,
      ...(displayName == null
        ? {
            displayNameNote:
              "No name exists for this product in Titan. Present the product code alone — do " +
              "NOT infer, expand, or invent a name from the letters in the code.",
          }
        : {}),
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
  jobType: { key: (row) => String(row.jobType ?? "unknown") },
  product: {
    key: (row) => String(row.productID ?? row.productId ?? "unknown"),
    label: (row) => row.description as string | undefined,
  },
  department: { key: (row) => String(row.productionDepartment ?? "unknown") },
};

/** Groupings where chronological order beats ranking, and a "top N" makes no sense. */
const CHRONOLOGICAL_GROUPS = new Set(["year", "month"]);

interface AggregateOptions {
  groupBy?: string;
  /** Field the groups are ranked by; defaults to the first sum field. */
  rankBy?: string;
  /** Cap on ranked groups returned. Ignored for chronological groupings. */
  topGroups?: number;
}

function aggregate(
  rows: Record<string, unknown>[],
  sumFields: string[],
  dateField: string,
  options: AggregateOptions = {}
): {
  count: number;
  totals: Record<string, number>;
  groups?: Record<string, unknown>[];
} {
  const { groupBy, topGroups } = options;
  const rankBy = options.rankBy ?? sumFields[0];
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
    // Ranked by value for categorical groupings — an alphabetical dump of 300
    // products forces the caller to scan and hand-pick, which is where wrong
    // "top 5" answers come from. Chronological groupings stay in date order.
    const chronological = CHRONOLOGICAL_GROUPS.has(groupBy!);
    const entries = [...byKey.entries()];
    if (chronological) {
      entries.sort(([a], [b]) => a.localeCompare(b));
    } else {
      entries.sort(
        (a, b) => (b[1].sums[rankBy] ?? 0) - (a[1].sums[rankBy] ?? 0) || a[0].localeCompare(b[0])
      );
    }

    const capped =
      !chronological && topGroups != null && entries.length > topGroups
        ? entries.slice(0, topGroups)
        : entries;

    result.groups = capped.map(([key, bucket]) => ({
      [groupBy!]: key,
      ...(bucket.label !== undefined ? { name: bucket.label } : {}),
      count: bucket.count,
      ...Object.fromEntries(sumFields.map((f) => [f, round2(bucket.sums[f])])),
    }));

    if (capped.length < entries.length) {
      Object.assign(result, {
        groupsReturned: capped.length,
        groupsTotal: entries.length,
        groupsNote:
          `Showing the top ${capped.length} of ${entries.length} groups, ranked by ${rankBy} ` +
          "descending. The count and totals above cover ALL groups, not just these — raise " +
          "TopGroups to see more. Do not re-rank these rows yourself; they are already ordered.",
      });
    } else if (!chronological) {
      Object.assign(result, { groupsRankedBy: `${rankBy} descending` });
    }
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
  jobType?: string;
  /** Booked basis with no date bounds: still restrict to orders that were booked. */
  bookedOnly?: boolean;
}

interface ResolvedOrders {
  orders: OrderIndexEntry[];
  coverage: Record<string, unknown>;
  /** Answered from a fully-built index (D-2). Drives the WI-7 fail-closed gate. */
  complete: boolean;
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
  if (filter.jobType != null && !eqIgnoreCase(entry.jobType, filter.jobType)) return false;
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
        jobType: (row.jobType as string) ?? null,
        jobPriority: typeof row.jobPriority === "number" ? row.jobPriority : null,
        startDate: dateOrNull(row.startDate),
        completedDate: dateOrNull(row.completedDate),
        expirationDate: dateOrNull(row.expirationDate),
        reference: (row.reference as string) ?? null,
        quote: (row.quote as string) ?? null,
        lastModifiedDate: dateOrNull(row.lastModifiedDate),
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
  const wantsBooked =
    filter.bookedOnly === true ||
    filter.bookedDateStart != null ||
    filter.bookedDateEnd != null;

  if (await ctx.orderIndex.ensureReady(INDEX_WAIT_MS)) {
    const status = ctx.orderIndex.status();
    const orders = ctx.orderIndex
      .query({ ...filter, excludedPlants: excluded })
      .filter((entry) => matchesAttributes(entry, filter, excluded));
    return {
      orders,
      complete: true,
      coverage: {
        basis: "index",
        complete: true,
        ordersIndexed: status.orders,
        indexBuiltAt: status.builtAt,
        indexLastRefreshedAt: status.lastRefreshAt,
        ...(status.refreshing ? { indexRefreshInProgress: true } : {}),
        ...scopeFields(excluded, status.coversOrdersFrom),
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
    complete: !wantsBooked,
    coverage: {
      basis: "partialScan",
      complete: !wantsBooked,
      ...scopeFields(excluded, status.coversOrdersFrom),
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

/**
 * WI-7: a partial answer must not be presentable as a final one. The error names the
 * forbidden detours explicitly — a bare failure invites the model to "helpfully" fall
 * back to order-date or invoice figures, which is the bug this server exists to stop.
 */
function assertComplete(ctx: ToolContext, resolved: ResolvedOrders, allowPartial: unknown): void {
  if (resolved.complete || allowPartial === true) return;
  const status = ctx.orderIndex.status();
  const progress =
    status.state === "building"
      ? `${status.buildFetched} of ${status.buildFetched + status.buildRemaining} orders fetched`
      : `index state: ${status.state}`;
  throw new Error(
    `Incomplete coverage: the booked-date index is not ready (${progress}), so a complete ` +
      "answer for this booked-date range is not available yet. Do NOT substitute " +
      "DateBasis=order, list_sales_orders, or invoice figures — they measure something " +
      "different and would be wrong. Either retry once get_order_index_status reports " +
      "state=ready, or pass AllowPartial=true to receive the partial result together with " +
      "its incompleteWarning."
  );
}

/**
 * D-3: estimatedValue is unpopulated in Titan (null on every order observed). Reporting
 * it as $0 reads as "we estimated nothing" rather than "not tracked", so it is omitted
 * unless some matching order actually carries a value.
 */
function estimatedValueInUse(orders: OrderIndexEntry[]): boolean {
  return orders.some((o) => toNumber(o.estimatedValue) !== 0);
}

const ESTIMATED_VALUE_OMITTED_NOTE = {
  estimatedValueOmitted:
    "estimatedValue is 0 or unset on every matching order in Titan, so it is omitted " +
    "rather than reported as $0. Do not present it as a zero estimate.",
};

/** Compact order row returned to the model. */
function presentOrder(entry: OrderIndexEntry, includeEstimated: boolean) {
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
    ...(includeEstimated ? { estimatedValue: round2(entry.estimatedValue) } : {}),
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

const DEFAULT_TOP_GROUPS = 20;

const topGroupsParam = () =>
  z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      `Maximum groups returned when grouping by a category (default ${DEFAULT_TOP_GROUPS}). ` +
        "Groups come back already ranked by value, highest first, so this is a top-N — use it " +
        "for 'which N did we X the most of'. Ignored for year/month, which stay chronological " +
        "and complete. Counts and totals always cover ALL groups."
    );

const topGroupsArg = (args: Record<string, unknown>): number =>
  args.TopGroups == null ? DEFAULT_TOP_GROUPS : Number(args.TopGroups);

/** Fold case and punctuation so "AAA Construction Inc" matches "AAA Construction, Inc.". */
function normalizeForSearch(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** exact > prefix > substring, so the obvious match sorts first. */
function matchRank(haystack: string, needle: string): number | null {
  if (needle === "") return 2;
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  return haystack.includes(needle) ? 2 : null;
}

export const aggregateToolDefs: AggregateToolDef[] = [
  {
    name: "list_booked_orders",
    title: "List orders booked in a period",
    description:
      "LISTS INDIVIDUAL ORDERS booked in a date range — job numbers, customers, values, one-off " +
      "drill-down — when the user wants to see the orders themselves. NOT for totals, rankings, " +
      "or any breakdown: for 'how much did we book', 'which products/customers/plants did we " +
      "book the most of', or anything grouped, use summarize_sales_orders with DateBasis=booked, " +
      "which aggregates server-side instead of making you read rows. Filtering is on bookedDate " +
      "(when the order was booked); the Titan API has no such filter and list_sales_orders/" +
      "OrderDate filters on when the order was ENTERED, a different and usually much larger set. " +
      "Answers come from a background index of every sales order; if it is still building the " +
      "call errors rather than returning a partial result, unless AllowPartial=true. Returns the " +
      "count and summed bookedValue for ALL matches regardless of how many rows are listed.",
    params: {
      BookedDateStart: z
        .string()
        .optional()
        .describe("Booked date range start (YYYY-MM-DD, inclusive). Required unless Period is used."),
      BookedDateEnd: z
        .string()
        .optional()
        .describe("Booked date range end (YYYY-MM-DD, inclusive). Required unless Period is used."),
      Period: periodParam(),
      CustomerId: z.string().optional().describe("Filter by customer ID."),
      PlantId: z.string().optional().describe("Filter by plant ID."),
      JobStatus: z
        .string()
        .optional()
        .describe("Filter by job status. Valid values come from list_job_statuses."),
      SalesRep: z.string().optional().describe("Filter by sales rep."),
      JobType: z.string().optional().describe("Filter by job type (e.g. Precast)."),
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
        .describe(
          "Maximum order rows to return (default 200, max 2000). The count and totals always " +
            "cover ALL matches, so the limit only affects how many rows are listed."
        ),
      OrderDateStart: z
        .string()
        .optional()
        .describe("Optional extra filter on the order (entry) date, range start."),
      OrderDateEnd: z
        .string()
        .optional()
        .describe("Optional extra filter on the order (entry) date, range end."),
      AllowPartial: z
        .boolean()
        .optional()
        .describe(
          "Set true to accept a knowingly incomplete result while the booked-date index is " +
            "still building. Without it, incomplete coverage is an error rather than a result."
        ),
    },
    handler: async (ctx, args) => {
      const period = periodRange(
        args.Period,
        { start: args.BookedDateStart, end: args.BookedDateEnd },
        "BookedDateStart/BookedDateEnd"
      );
      const bookedDateStart = String(period?.start ?? args.BookedDateStart ?? "").slice(0, 10);
      const bookedDateEnd = String(period?.end ?? args.BookedDateEnd ?? "").slice(0, 10);
      if (!bookedDateStart || !bookedDateEnd) {
        throw new Error(
          "A booked-date range is required: pass BookedDateStart and BookedDateEnd " +
            "(YYYY-MM-DD), or a Period such as lastWeek."
        );
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
        ...(args.JobType != null ? { jobType: String(args.JobType) } : {}),
      };

      const resolved = await resolveOrders(ctx, filter);
      assertComplete(ctx, resolved, args.AllowPartial);
      const { orders, coverage, notes } = resolved;
      const minValue = args.MinBookedValue == null ? null : Number(args.MinBookedValue);
      const matched = minValue == null ? orders : orders.filter((o) => o.bookedValue >= minValue);
      const withEstimated = estimatedValueInUse(matched);

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
        dateBasis: "booked",
        dateField: "bookedDate",
        resolvedRange: resolvedRange(bookedDateStart, bookedDateEnd),
        ...(args.Period != null
          ? { period: args.Period, periodDefinition: PERIOD_DEFINITIONS[args.Period as PeriodName] }
          : {}),
        measureFields: withEstimated ? ["bookedValue", "estimatedValue"] : ["bookedValue"],
        ...(withEstimated || matched.length === 0 ? {} : ESTIMATED_VALUE_OMITTED_NOTE),
        filters: {
          BookedDateStart: bookedDateStart,
          BookedDateEnd: bookedDateEnd,
          Period: args.Period ?? null,
          CustomerId: args.CustomerId ?? null,
          PlantId: args.PlantId ?? null,
          JobStatus: args.JobStatus ?? null,
          SalesRep: args.SalesRep ?? null,
          JobType: args.JobType ?? null,
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
          ...(withEstimated
            ? { estimatedValue: round2(matched.reduce((sum, o) => sum + o.estimatedValue, 0)) }
            : {}),
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
        orders: returned.map((entry) => presentOrder(entry, withEstimated)),
      };
    },
  },
  {
    name: "search_customers",
    title: "Search customers by name",
    description:
      "Finds customers by company name or customer ID and returns the CustomerId needed by the " +
      "other tools, with city, state, status and sales rep to tell similar names apart. The " +
      "Titan API has no name filter, so this searches a cached snapshot of the customer list. " +
      "Use this instead of paging through list_customers, and never guess a CustomerId. " +
      "Matching ignores case and punctuation, so 'AAA Construction Inc' finds " +
      "'AAA Construction, Inc.'.",
    params: {
      Query: z
        .string()
        .describe("Company name (full or partial) or customer ID to search for."),
      Status: z
        .string()
        .optional()
        .describe("Restrict to a customer status code (A, H, P, S, N). Omit to search all."),
      Limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum matches to return (default 25)."),
    },
    handler: async (ctx, args) => {
      const query = String(args.Query ?? "").trim();
      if (query === "") throw new Error("Query is required (a company name or customer ID).");
      const needle = normalizeForSearch(query);
      const catalog = await ctx.client.getCustomerCatalog();

      const scored: { rank: number; customer: CatalogCustomer }[] = [];
      for (const customer of catalog.values()) {
        if (args.Status != null && !eqIgnoreCase(customer.status, args.Status)) continue;
        const byName = matchRank(normalizeForSearch(customer.companyName), needle);
        const byId = matchRank(normalizeForSearch(customer.customerID), needle);
        const rank = Math.min(byName ?? 99, byId ?? 99);
        if (rank < 99) scored.push({ rank, customer });
      }
      scored.sort(
        (a, b) =>
          a.rank - b.rank ||
          String(a.customer.companyName ?? "").localeCompare(String(b.customer.companyName ?? ""))
      );

      const limit = Math.min(Number(args.Limit ?? 25), 200);
      const matches = scored.slice(0, limit).map(({ customer }) => ({
        customerId: customer.customerID,
        companyName: customer.companyName ?? null,
        city: customer.city ?? null,
        state: customer.state ?? null,
        status: customer.status ?? null,
        salesRep: customer.salesRep ?? null,
      }));

      return {
        measure: "customers matching the search term",
        filters: { Query: query, Status: args.Status ?? null },
        customersSearched: catalog.size,
        count: scored.length,
        returned: matches.length,
        ...(matches.length < scored.length
          ? {
              truncated: true,
              truncationNote: `Showing ${matches.length} of ${scored.length} matches; raise Limit for more.`,
            }
          : {}),
        ...(scored.length === 0
          ? {
              noMatchNote:
                "No customer matched. Do not guess a CustomerId — ask the user to confirm the " +
                "name, or try a shorter/distinctive fragment of it.",
            }
          : {}),
        customers: matches,
      };
    },
  },
  {
    name: "search_products",
    title: "Search products by name or ID",
    description:
      "Finds products by name or product ID and returns real Titan ProductIds for use as filter " +
      "values, along with type, partTypeID and productLine — which distinguish manufactured " +
      "goods from charges such as freight, fuel surcharge and quote notes. The Titan API has no " +
      "name filter, so this searches the cached product catalog. Use it to ground a product " +
      "before quoting figures for it, and never invent a ProductId. Matching ignores case and " +
      "punctuation.",
    params: {
      Query: z.string().describe("Product description (full or partial) or product ID."),
      Limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum matches to return (default 25)."),
    },
    handler: async (ctx, args) => {
      const query = String(args.Query ?? "").trim();
      if (query === "") throw new Error("Query is required (a product description or ID).");
      const needle = normalizeForSearch(query);
      const catalog = await ctx.client.getProductCatalog();

      const scored: { rank: number; product: CatalogProduct }[] = [];
      for (const product of catalog.values()) {
        const byName = matchRank(normalizeForSearch(product.productName), needle);
        const byId = matchRank(normalizeForSearch(product.productID), needle);
        const rank = Math.min(byName ?? 99, byId ?? 99);
        if (rank < 99) scored.push({ rank, product });
      }
      scored.sort(
        (a, b) => a.rank - b.rank || a.product.productID.localeCompare(b.product.productID)
      );

      const limit = Math.min(Number(args.Limit ?? 25), 200);
      const matches = scored.slice(0, limit).map(({ product }) => ({
        productId: product.productID,
        productName: product.productName ?? null,
        unitOfMeasure: product.unitOfMeasure ?? null,
        type: product.type ?? null,
        partTypeID: product.partTypeID ?? null,
        productLine: product.productLine ?? null,
        status: product.status ?? null,
      }));

      return {
        measure: "products matching the search term",
        filters: { Query: query },
        productsSearched: catalog.size,
        count: scored.length,
        returned: matches.length,
        ...(matches.length < scored.length
          ? {
              truncated: true,
              truncationNote: `Showing ${matches.length} of ${scored.length} matches; raise Limit for more.`,
            }
          : {}),
        ...(scored.length === 0
          ? {
              noMatchNote:
                "No product matched. Do not invent a ProductId — report that the product was not " +
                "found in the catalog.",
            }
          : {}),
        products: matches,
      };
    },
  },
  {
    name: "list_job_statuses",
    title: "List job statuses and job types",
    description:
      "Returns the jobStatus and jobType values actually present on Titan sales orders, with " +
      "order counts and how many orders in each status have been booked. Use it to populate the " +
      "JobStatus/JobType filters rather than guessing a code. NOTE: this is DERIVED from the " +
      "indexed orders, not a master reference table — a status that no order currently uses will " +
      "not appear, so absence is not proof the code is invalid. Counts cover all plants, " +
      "including any excluded from the summarize_* totals.",
    params: {},
    handler: async (ctx) => {
      if (!(await ctx.orderIndex.ensureReady(INDEX_WAIT_MS))) {
        const status = ctx.orderIndex.status();
        throw new Error(
          "The sales-order index is not ready yet, and job statuses are derived from it " +
            `(${status.state}: ${status.buildFetched} of ` +
            `${status.buildFetched + status.buildRemaining} orders fetched). Retry once ` +
            "get_order_index_status reports state=ready."
        );
      }
      const status = ctx.orderIndex.status();
      return {
        measure: "distinct jobStatus and jobType values across all indexed sales orders",
        derivedFrom: "the sales-order index (not a Titan reference table)",
        ordersIndexed: status.orders,
        indexBuiltAt: status.builtAt,
        note:
          "booked = orders in this status that carry a bookedDate; unbooked = those that do " +
          "not. Plant exclusions are deliberately NOT applied here.",
        jobStatuses: ctx.orderIndex.statusBreakdown(),
        jobTypes: ctx.orderIndex.typeBreakdown(),
      };
    },
  },
  {
    name: "get_server_time",
    title: "Get server time and resolved periods",
    description:
      "Returns the server's current date in the NWPX reporting time zone plus the absolute " +
      "date range each named Period resolves to right now. Use it to anchor any date reasoning " +
      "you do yourself, and prefer passing Period to the summarize_*/list_booked_orders tools " +
      "over computing ranges by hand.",
    params: {},
    handler: async () => {
      const now = new Date();
      const today = todayInZone(now);
      return {
        serverTimeUtc: now.toISOString(),
        timeZone: REPORTING_TIME_ZONE,
        today,
        fiscalCalendar: "calendar year (quarters are Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec)",
        weekDefinition: "weeks run Sunday through Saturday",
        periods: Object.fromEntries(
          PERIOD_NAMES.map((name) => [
            name,
            { ...resolvePeriod(name, today), definition: PERIOD_DEFINITIONS[name] },
          ])
        ),
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
      "totals, e.g. a customer's annual sales. THIS IS THE TOOL for 'which products / customers " +
      "/ plants / reps did we book the most of', 'how much did we book', and any ranked or " +
      "grouped bookings figure — use it rather than listing orders with list_booked_orders and " +
      "adding them up yourself. Grouped results come back ALREADY RANKED by value, highest " +
      "first, capped by TopGroups: read them in order and do not re-sort or re-rank them " +
      "yourself. DATE BASIS: defaults to BOOKED (bookedDate), " +
      "which is what 'sales', 'bookings' and 'sold' mean — pass BookedDateStart/BookedDateEnd or " +
      "Period. Pass DateBasis=order with OrderDateStart/OrderDateEnd only when the user " +
      "explicitly asks about when orders were ENTERED; the two give very different numbers, and " +
      "the Titan API has no bookedDate filter of its own (this server maintains an index for " +
      "it). Use Period (e.g. lastWeek, lastMonth, ytd) instead of computing dates yourself; the " +
      "server resolves it and reports the absolute range in resolvedRange. " +
      "PRODUCT NAMES: each product group carries displayName — reproduce it EXACTLY as given, " +
      "including dimensions and punctuation. Never expand a product code into words, never " +
      "shorten a description, and when displayName is null present the code alone. GroupBy " +
      "product (or a ProductID filter) switches to " +
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
          "Which date the range filters and year/month groupings use. DEFAULTS TO 'booked' " +
            "(the bookedDate — what 'sales', 'bookings' and 'sold' mean). Pass 'order' only " +
            "when the user explicitly asks about when orders were ENTERED/created, which is a " +
            "different measure. Always state which basis you used."
        ),
      Period: periodParam(),
      CustomerId: z.string().optional().describe("Filter by customer ID (recommended when known)."),
      PlantId: z.string().optional().describe("Filter by plant ID."),
      JobStatus: z
        .string()
        .optional()
        .describe("Filter by job status. Valid values come from list_job_statuses."),
      SalesRep: z.string().optional().describe("Filter by sales rep."),
      JobType: z
        .string()
        .optional()
        .describe("Filter by job type (e.g. Precast). Valid values come from list_job_statuses."),
      ProductID: z.string().optional().describe("Only count order detail lines for this product ID."),
      OrderDateStart: z.string().optional().describe("Order (entry) date range start (YYYY-MM-DD, inclusive)."),
      OrderDateEnd: z.string().optional().describe("Order (entry) date range end (YYYY-MM-DD, inclusive)."),
      BookedDateStart: z.string().optional().describe("Booked date range start (YYYY-MM-DD, inclusive)."),
      BookedDateEnd: z.string().optional().describe("Booked date range end (YYYY-MM-DD, inclusive)."),
      AllowPartial: z
        .boolean()
        .optional()
        .describe(
          "Set true to accept a knowingly incomplete booked-date result while the index is " +
            "still building. Without it, incomplete coverage is an error rather than a result."
        ),
      GroupBy: groupByParam(
        ["year", "month", "customer", "plant", "jobStatus", "salesRep", "jobType", "product"],
        "year, month, customer, plant, jobStatus, salesRep, jobType, or product (product " +
          "switches to detail-line sums)"
      ),
      TopGroups: topGroupsParam(),
    },
    handler: async (ctx, args) => {
      // D-5: booked is the default basis — "sales" means booked at NWPX, so an
      // omitted DateBasis must not quietly produce an entry-date figure.
      const basis = (args.DateBasis as string) ?? "booked";

      const period = periodRange(
        args.Period,
        basis === "booked"
          ? { start: args.BookedDateStart, end: args.BookedDateEnd }
          : { start: args.OrderDateStart, end: args.OrderDateEnd },
        basis === "booked" ? "BookedDateStart/BookedDateEnd" : "OrderDateStart/OrderDateEnd"
      );

      const bookedStart = (period && basis === "booked" ? period.start : args.BookedDateStart) as
        | string
        | undefined;
      const bookedEnd = (period && basis === "booked" ? period.end : args.BookedDateEnd) as
        | string
        | undefined;
      const orderStart = (period && basis === "order" ? period.start : args.OrderDateStart) as
        | string
        | undefined;
      const orderEnd = (period && basis === "order" ? period.end : args.OrderDateEnd) as
        | string
        | undefined;

      const hasBookedRange = bookedStart != null || bookedEnd != null;
      const hasOrderRange = orderStart != null || orderEnd != null;

      // A booked basis with order dates and no booked range is the ambiguous case:
      // the caller almost certainly wanted one or the other, so name both exits
      // rather than guessing. With no dates at all, an unbounded booked query is
      // perfectly answerable from the index, so it is allowed.
      if (basis === "booked" && !hasBookedRange && hasOrderRange) {
        throw new Error(
          "You passed order-entry dates but the date basis is 'booked' (the default). For " +
            "bookings, pass BookedDateStart/BookedDateEnd (or Period). To filter on when orders " +
            "were ENTERED instead, pass DateBasis=order — that is a different measure and is not " +
            "a bookings figure."
        );
      }
      if (basis === "order" && hasBookedRange) {
        throw new Error(
          "DateBasis=order filters on OrderDateStart/OrderDateEnd; BookedDateStart/BookedDateEnd " +
            "apply only to DateBasis=booked. Pass one basis and its matching dates."
        );
      }

      const filter: OrderFilter = {
        ...(basis === "booked" ? { bookedOnly: true } : {}),
        ...(bookedStart != null ? { bookedDateStart: String(bookedStart) } : {}),
        ...(bookedEnd != null ? { bookedDateEnd: String(bookedEnd) } : {}),
        ...(orderStart != null ? { orderDateStart: String(orderStart) } : {}),
        ...(orderEnd != null ? { orderDateEnd: String(orderEnd) } : {}),
        ...(args.CustomerId != null ? { customerId: String(args.CustomerId) } : {}),
        ...(args.PlantId != null ? { plantId: String(args.PlantId) } : {}),
        ...(args.JobStatus != null ? { jobStatus: String(args.JobStatus) } : {}),
        ...(args.SalesRep != null ? { salesRep: String(args.SalesRep) } : {}),
        ...(args.JobType != null ? { jobType: String(args.JobType) } : {}),
      };

      const resolved = await resolveOrders(ctx, filter);
      assertComplete(ctx, resolved, args.AllowPartial);
      const { orders, coverage, notes } = resolved;
      const dateField = basis === "booked" ? "bookedDate" : "orderDate";
      const withEstimated = estimatedValueInUse(orders);
      const orderSumFields = withEstimated ? ["bookedValue", "estimatedValue"] : ["bookedValue"];

      const base = {
        measure:
          basis === "booked"
            ? "sales orders by bookedDate (bookings); sums are bookedValue"
            : "sales orders by order (entry) date; sums are bookedValue",
        dateBasis: basis,
        dateField,
        resolvedRange:
          basis === "booked"
            ? resolvedRange(bookedStart, bookedEnd)
            : resolvedRange(orderStart, orderEnd),
        ...(args.Period != null
          ? { period: args.Period, periodDefinition: PERIOD_DEFINITIONS[args.Period as PeriodName] }
          : {}),
        measureFields: orderSumFields,
        filters: {
          DateBasis: basis,
          CustomerId: args.CustomerId ?? null,
          PlantId: args.PlantId ?? null,
          JobStatus: args.JobStatus ?? null,
          SalesRep: args.SalesRep ?? null,
          JobType: args.JobType ?? null,
          ProductID: args.ProductID ?? null,
          Period: args.Period ?? null,
          OrderDateStart: orderStart ?? null,
          OrderDateEnd: orderEnd ?? null,
          BookedDateStart: bookedStart ?? null,
          BookedDateEnd: bookedEnd ?? null,
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
        const agg = aggregate(lines, ["sellValue", "quantityOrdered", "yards"], dateField, {
          groupBy: effectiveGroupBy,
          rankBy: "sellValue",
          topGroups: topGroupsArg(args),
        });
        return {
          ...base,
          measure:
            "sales order detail lines (bookings); sums are sellValue " +
            "(quantityOrdered x sellUnitPrice), quantityOrdered, and yards",
          measureFields: ["sellValue", "quantityOrdered", "yards"],
          ...(basis === "order"
            ? {
                measureNote: orderBasisNote(
                  "sellValue (quantityOrdered x sellUnitPrice) on order detail lines"
                ),
              }
            : {}),
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
        ...(basis === "order"
          ? { measureNote: orderBasisNote("bookedValue (booked dollars)") }
          : {}),
        ...(withEstimated || orders.length === 0 ? {} : ESTIMATED_VALUE_OMITTED_NOTE),
        ...aggregate(orders as unknown as Record<string, unknown>[], orderSumFields, dateField, {
          groupBy: args.GroupBy as string,
          rankBy: "bookedValue",
          topGroups: topGroupsArg(args),
        }),
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
      Period: periodParam(),
      GroupBy: groupByParam(
        ["year", "month", "plant", "product", "department"],
        "year, month, plant, product, or department"
      ),
      TopGroups: topGroupsParam(),
    },
    handler: async (ctx, args) => {
      const client = ctx.client;
      const period = periodRange(
        args.Period,
        { start: args.StartProductionDate, end: args.EndProductionDate },
        "StartProductionDate/EndProductionDate"
      );
      const startDate = period?.start ?? args.StartProductionDate;
      const endDate = period?.end ?? args.EndProductionDate;
      const serverQuery: Record<string, unknown> = {
        PlantID: args.PlantID,
        ProductionDepartment: args.ProductionDepartment,
        Type: args.Type,
        StartProductionDate: startDate,
        EndProductionDate: endDate,
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
        dateBasis: "production",
        dateField: "date",
        resolvedRange: resolvedRange(startDate, endDate),
        ...(args.Period != null
          ? { period: args.Period, periodDefinition: PERIOD_DEFINITIONS[args.Period as PeriodName] }
          : {}),
        measureFields: ["quantity", "quantityProd", "yards", "cubicMeters", "tons"],
        coverage: {
          basis: "apiQuery",
          complete: !truncated,
          ...scopeFields(client.excludedPlants),
        },
        filters: {
          PlantID: args.PlantID ?? null,
          ProductionDepartment: args.ProductionDepartment ?? null,
          Type: args.Type ?? null,
          ProductID: args.ProductID ?? null,
          Period: args.Period ?? null,
          StartProductionDate: startDate ?? null,
          EndProductionDate: endDate ?? null,
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
      const agg = aggregate(lines, ["quantity", "quantityProd", "yards", "cubicMeters", "tons"], "date", {
        groupBy: args.GroupBy as string,
        // NWPX reports production volume in yards unless asked otherwise.
        rankBy: "yards",
        topGroups: topGroupsArg(args),
      });
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
      "optionally grouped. BILLED/INVOICED REVENUE (AR) ONLY — this is NOT a substitute for " +
      "sales or bookings figures, which come from summarize_sales_orders (DateBasis=booked) or " +
      "list_booked_orders. Use it only when the user explicitly asks about invoiced or billed " +
      "amounts. Dates filter on the invoice date (inclusive). Credit invoices are included as " +
      "returned by the API (negative or credit amounts net against totals).",
    params: {
      CustomerId: z.string().optional().describe("Filter by customer ID (recommended when known)."),
      PlantId: z.string().optional().describe("Filter by plant ID."),
      TicketType: z.string().optional().describe("Filter by ticket type."),
      StartDate: z.string().optional().describe("Invoice date range start (YYYY-MM-DD, inclusive)."),
      EndDate: z.string().optional().describe("Invoice date range end (YYYY-MM-DD, inclusive)."),
      Period: periodParam(),
      GroupBy: groupByParam(
        ["year", "month", "customer", "plant", "salesRep"],
        "year, month, customer, plant, or salesRep"
      ),
      TopGroups: topGroupsParam(),
    },
    handler: async (ctx, args) => {
      const client = ctx.client;
      const period = periodRange(
        args.Period,
        { start: args.StartDate, end: args.EndDate },
        "StartDate/EndDate"
      );
      const startDate = period?.start ?? args.StartDate;
      const endDate = period?.end ?? args.EndDate;
      const serverQuery: Record<string, unknown> = {
        CustomerId: args.CustomerId,
        PlantId: args.PlantId,
        TicketType: args.TicketType,
        StartDate: startDate,
        EndDate: endDate,
      };
      const { rows, pagesFetched, truncated, skipped } = await fetchAllPages(
        client,
        "/api/v1/Invoices",
        serverQuery
      );
      const kept = rows.filter((row) => plantAllowed(client.excludedPlants, row.plantId));
      return {
        measure: "posted AR invoices (billed revenue); sums are subtotal, tax, and total",
        dateBasis: "invoice",
        dateField: "invoiceDate",
        resolvedRange: resolvedRange(startDate, endDate),
        ...(args.Period != null
          ? { period: args.Period, periodDefinition: PERIOD_DEFINITIONS[args.Period as PeriodName] }
          : {}),
        measureFields: ["subtotal", "tax", "total"],
        coverage: {
          basis: "apiQuery",
          complete: !truncated,
          ...scopeFields(client.excludedPlants),
        },
        filters: {
          CustomerId: args.CustomerId ?? null,
          PlantId: args.PlantId ?? null,
          TicketType: args.TicketType ?? null,
          Period: args.Period ?? null,
          StartDate: startDate ?? null,
          EndDate: endDate ?? null,
          ...excludedPlantsNote(client.excludedPlants),
        },
        scanned: rows.length,
        pagesFetched,
        ...(truncated ? { warning: `Result truncated after ${MAX_PAGES} pages; totals are incomplete. Narrow the filters.` } : {}),
        ...skippedNote(skipped),
        ...aggregate(kept, ["subtotal", "tax", "total"], "invoiceDate", {
          groupBy: args.GroupBy as string,
          rankBy: "total",
          topGroups: topGroupsArg(args),
        }),
      };
    },
  },
];
