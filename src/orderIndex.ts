import { readFile, rename, writeFile } from "node:fs/promises";
import type { TitanClient } from "./titanClient.js";
import {
  dateOrNull,
  datePart,
  fetchAllPages,
  inRange,
  mapLimit,
  plantAllowed,
  toNumber,
} from "./shared.js";

// Why this exists: the Titan sales-order LIST endpoint (GET /api/v1/SalesOrders)
// returns only jobNumber, orderDate, customerName, jobStatus, jobType, quote,
// shipping address and the start/completed/expiration dates — with plantId and
// customerId always null. bookedDate, bookedValue, estimatedValue, plantId,
// customerId and salesRep exist ONLY on the per-order GET
// (/api/v1/SalesOrders/{jobNumber}), and the API has no BookedDate filter at all.
//
// So "which orders were BOOKED between X and Y" cannot be answered by any single
// API call: it requires the full order set (57k+ orders) fetched individually.
// This index does that once in the background, keeps the result in memory, and
// refreshes incrementally, so booked-date questions answer instantly afterwards.

const INDEX_FORMAT = 2;
const PROGRESS_EVERY = 2500;

/** Statuses where a not-yet-booked order will never become booked later. */
const TERMINAL_STATUSES = new Set(["cancelled", "canceled", "lost", "void", "voided"]);

/** How far back an unbooked order stays a refresh candidate (it may get booked). */
const UNBOOKED_LOOKBACK_DAYS = 730;
/** Recently booked orders stay refresh candidates (their value can be revised). */
const RECENT_BOOKING_DAYS = 45;
// Status changes and lastModifiedDate catch most updates on every refresh for
// free. The date-window rules below would otherwise re-fetch thousands of open
// quotes every cycle, so they only re-check an entry this often.
const RECHECK_MS = 6 * 3_600_000;

export interface OrderIndexEntry {
  jobNumber: string;
  orderDate: string | null;
  bookedDate: string | null;
  quotedDate: string | null;
  customerId: string | null;
  customerName: string | null;
  jobName: string | null;
  plantId: string | null;
  jobStatus: string | null;
  salesRep: string | null;
  bookedValue: number;
  estimatedValue: number;
  /** Epoch ms when this entry was last fetched from the API. */
  indexedAt: number;
}

export interface OrderIndexOptions {
  enabled: boolean;
  concurrency: number;
  refreshMs: number;
  fullRebuildMs: number;
  persistPath?: string;
  /** Skip orders entered before this YYYY-MM-DD, to bound the initial build. */
  minOrderDate?: string;
}

export type OrderIndexState = "disabled" | "empty" | "building" | "ready";

export interface OrderIndexStatus {
  state: OrderIndexState;
  /** Orders currently in the index. */
  orders: number;
  /** Orders the API reports exist (known once a listing pass has run). */
  totalOrders: number | null;
  /** Orders fetched so far in the in-flight build (0 when idle). */
  buildFetched: number;
  /** Orders the in-flight build still has to fetch. */
  buildRemaining: number;
  /** Orders whose detail fetch failed (persistent API errors); excluded. */
  failedOrders: number;
  builtAt: string | null;
  lastRefreshAt: string | null;
  refreshing: boolean;
  lastError: string | null;
  /** Orders entered before this date are deliberately not indexed (if set). */
  coversOrdersFrom: string | null;
}

export interface OrderQuery {
  bookedDateStart?: string;
  bookedDateEnd?: string;
  orderDateStart?: string;
  orderDateEnd?: string;
  customerId?: string;
  plantId?: string;
  jobStatus?: string;
  salesRep?: string;
  /** Only orders that have a bookedDate at all. */
  bookedOnly?: boolean;
  excludedPlants?: Set<string>;
}

interface PersistedIndex {
  format: number;
  builtAt: number;
  entries: OrderIndexEntry[];
}

const eqIgnoreCase = (a: unknown, b: unknown): boolean =>
  String(a ?? "").toUpperCase() === String(b ?? "").toUpperCase();

export class OrderIndex {
  private readonly entries = new Map<string, OrderIndexEntry>();
  private building?: Promise<void>;
  private builtAt: number | null = null;
  private lastRefreshAt: number | null = null;
  private totalOrders: number | null = null;
  private buildFetched = 0;
  private buildRemaining = 0;
  private failedOrders = 0;
  private lastError: string | null = null;
  private loadedFromDisk = false;

  constructor(
    private readonly client: TitanClient,
    private readonly options: OrderIndexOptions
  ) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  status(): OrderIndexStatus {
    return {
      state: !this.options.enabled
        ? "disabled"
        : this.builtAt != null
          ? "ready"
          : this.building
            ? "building"
            : "empty",
      orders: this.entries.size,
      totalOrders: this.totalOrders,
      buildFetched: this.buildFetched,
      buildRemaining: this.buildRemaining,
      failedOrders: this.failedOrders,
      builtAt: this.builtAt == null ? null : new Date(this.builtAt).toISOString(),
      lastRefreshAt:
        this.lastRefreshAt == null ? null : new Date(this.lastRefreshAt).toISOString(),
      refreshing: this.building != null,
      lastError: this.lastError,
      coversOrdersFrom: this.options.minOrderDate ?? null,
    };
  }

  /**
   * Kicks off a build/refresh if one is due, then waits up to `waitMs` for the
   * index to become usable. Returns true when it can answer queries. A refresh
   * of an already-built index never blocks: the existing data keeps serving.
   */
  async ensureReady(waitMs = 0): Promise<boolean> {
    if (!this.options.enabled) return false;
    this.kick();
    if (this.builtAt != null) return true;
    const building = this.building;
    if (waitMs <= 0 || building == null) return false;
    await Promise.race([
      building,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        timer.unref?.();
      }),
    ]);
    return this.builtAt != null;
  }

  /** Starts the background build/refresh when one is due. Never throws. */
  kick(): void {
    if (!this.options.enabled || this.building != null) return;
    const now = Date.now();
    const age = this.builtAt == null ? Infinity : now - this.builtAt;
    const sinceRefresh = this.lastRefreshAt == null ? Infinity : now - this.lastRefreshAt;

    let mode: "full" | "incremental" | null = null;
    if (this.builtAt == null) mode = "full";
    else if (age >= this.options.fullRebuildMs) mode = "full";
    else if (sinceRefresh >= this.options.refreshMs) mode = "incremental";
    if (mode == null) return;

    this.building = this.run(mode)
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        console.error(`[order-index] ${mode} build failed: ${this.lastError}`);
      })
      .finally(() => {
        this.building = undefined;
        this.buildRemaining = 0;
      });
  }

  private async run(mode: "full" | "incremental"): Promise<void> {
    if (mode === "full" && this.builtAt == null && !this.loadedFromDisk) {
      this.loadedFromDisk = true;
      if (await this.loadFromDisk()) {
        // Disk snapshot restored: continue as an incremental catch-up instead
        // of re-fetching all 57k orders.
        mode = "incremental";
      }
    }

    const started = Date.now();
    console.error(`[order-index] ${mode} build starting (${this.entries.size} cached)`);

    const listing = await fetchAllPages(this.client, "/api/v1/SalesOrders", {});
    if (listing.truncated) {
      throw new Error(
        "The sales-order listing was truncated before the full order set was read; " +
          "the booked-date index would be incomplete, so it was not updated."
      );
    }
    this.totalOrders = listing.rows.length;

    const floor = this.options.minOrderDate;
    const jobNumbers = new Set<string>();
    const stale: Record<string, unknown>[] = [];
    let belowFloor = 0;
    for (const row of listing.rows) {
      const jobNumber = String(row.jobNumber ?? "");
      if (jobNumber === "") continue;
      // An order with no orderDate at all is kept: its bookedDate may still be
      // in range, and dropping it silently would be worse than one extra fetch.
      if (floor && datePart(row.orderDate) !== "" && datePart(row.orderDate) < floor) {
        belowFloor++;
        continue;
      }
      jobNumbers.add(jobNumber);
      if (mode === "full" || this.needsFetch(jobNumber, row)) stale.push(row);
    }
    if (belowFloor > 0) {
      console.error(
        `[order-index] ${belowFloor} orders entered before ${floor} excluded ` +
          "(TITAN_ORDER_INDEX_MIN_ORDER_DATE)"
      );
    }

    // Orders that vanished from the listing (deleted/purged) leave the index.
    for (const jobNumber of [...this.entries.keys()]) {
      if (!jobNumbers.has(jobNumber)) this.entries.delete(jobNumber);
    }

    this.buildFetched = 0;
    this.buildRemaining = stale.length;
    this.failedOrders = 0;

    await mapLimit(stale, this.options.concurrency, async (row) => {
      const jobNumber = String(row.jobNumber);
      const entry = await this.fetchEntry(jobNumber, row);
      if (entry) this.entries.set(jobNumber, entry);
      this.buildFetched++;
      this.buildRemaining--;
      if (this.buildFetched % PROGRESS_EVERY === 0) {
        console.error(
          `[order-index] ${this.buildFetched}/${stale.length} orders fetched ` +
            `(${this.failedOrders} failed)`
        );
      }
    });

    const now = Date.now();
    this.lastRefreshAt = now;
    if (mode === "full" || this.builtAt == null) this.builtAt = now;
    this.lastError = null;

    const seconds = Math.round((now - started) / 1000);
    console.error(
      `[order-index] ${mode} build done in ${seconds}s: ${this.entries.size} orders indexed, ` +
        `${stale.length} fetched, ${this.failedOrders} failed`
    );
    await this.saveToDisk();
  }

  /** Incremental-refresh rule: which listing rows need a fresh detail fetch. */
  private needsFetch(jobNumber: string, row: Record<string, unknown>): boolean {
    const entry = this.entries.get(jobNumber);
    if (!entry) return true; // new order

    // The listing's jobStatus is authoritative and cheap — a change means the
    // order moved (e.g. Quote -> Booked), so its detail is stale.
    if (!eqIgnoreCase(entry.jobStatus, row.jobStatus)) return true;

    const modified = Date.parse(String(row.lastModifiedDate ?? ""));
    if (Number.isFinite(modified) && modified > entry.indexedAt) return true;

    // The remaining rules are date-window guesses rather than evidence of a
    // change, so they are rate-limited per entry.
    const now = Date.now();
    if (now - entry.indexedAt < RECHECK_MS) return false;

    const ageInDays = (dateYmd: string | null): number => {
      if (!dateYmd) return NaN;
      return (now - Date.parse(`${dateYmd}T00:00:00Z`)) / 86_400_000;
    };

    if (entry.bookedDate == null) {
      // Not booked yet: it still might be, unless the order is dead or ancient.
      if (TERMINAL_STATUSES.has(String(entry.jobStatus ?? "").toLowerCase())) return false;
      const orderDate = entry.orderDate ?? (datePart(row.orderDate) || null);
      if (!orderDate) return true;
      const age = ageInDays(orderDate);
      return Number.isFinite(age) && age <= UNBOOKED_LOOKBACK_DAYS;
    }

    // Recently booked orders can still have their value revised.
    const bookedAge = ageInDays(entry.bookedDate);
    return Number.isFinite(bookedAge) && bookedAge <= RECENT_BOOKING_DAYS;
  }

  private async fetchEntry(
    jobNumber: string,
    listRow: Record<string, unknown>
  ): Promise<OrderIndexEntry | null> {
    try {
      const data = await this.client.get(
        `/api/v1/SalesOrders/${encodeURIComponent(jobNumber)}`
      );
      const order = (data.result ?? {}) as Record<string, unknown>;
      return {
        jobNumber,
        orderDate: dateOrNull(order.orderDate) ?? dateOrNull(listRow.orderDate),
        bookedDate: dateOrNull(order.bookedDate),
        quotedDate: dateOrNull(order.quotedDate),
        customerId: (order.customerId as string) ?? null,
        customerName: (order.customerName as string) ?? (listRow.customerName as string) ?? null,
        jobName: (order.jobName as string) ?? null,
        plantId: (order.plantId as string) ?? null,
        jobStatus: (order.jobStatus as string) ?? (listRow.jobStatus as string) ?? null,
        salesRep: (order.salesRep as string) ?? null,
        bookedValue: toNumber(order.bookedValue),
        estimatedValue: toNumber(order.estimatedValue),
        indexedAt: Date.now(),
      };
    } catch (err) {
      // Individual orders 500 on corrupt records; skip rather than abort the
      // whole build, and keep whatever we already had for that job number.
      this.failedOrders++;
      if (this.failedOrders <= 5) {
        console.error(
          `[order-index] skipping order ${jobNumber}: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
      return null;
    }
  }

  query(filter: OrderQuery): OrderIndexEntry[] {
    const excluded = filter.excludedPlants ?? new Set<string>();
    const wantBooked = filter.bookedOnly || filter.bookedDateStart != null || filter.bookedDateEnd != null;
    const out: OrderIndexEntry[] = [];
    for (const entry of this.entries.values()) {
      if (wantBooked && entry.bookedDate == null) continue;
      if (
        (filter.bookedDateStart != null || filter.bookedDateEnd != null) &&
        !inRange(entry.bookedDate ?? "", filter.bookedDateStart, filter.bookedDateEnd)
      ) {
        continue;
      }
      if (
        (filter.orderDateStart != null || filter.orderDateEnd != null) &&
        !inRange(entry.orderDate ?? "", filter.orderDateStart, filter.orderDateEnd)
      ) {
        continue;
      }
      if (filter.customerId != null && !eqIgnoreCase(entry.customerId, filter.customerId)) continue;
      if (filter.plantId != null && !eqIgnoreCase(entry.plantId, filter.plantId)) continue;
      if (filter.jobStatus != null && !eqIgnoreCase(entry.jobStatus, filter.jobStatus)) continue;
      if (filter.salesRep != null && !eqIgnoreCase(entry.salesRep, filter.salesRep)) continue;
      if (!plantAllowed(excluded, entry.plantId)) continue;
      out.push(entry);
    }
    return out;
  }

  private async loadFromDisk(): Promise<boolean> {
    const path = this.options.persistPath;
    if (!path) return false;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as PersistedIndex;
      if (parsed.format !== INDEX_FORMAT || !Array.isArray(parsed.entries)) return false;
      for (const entry of parsed.entries) {
        if (entry?.jobNumber) this.entries.set(entry.jobNumber, entry);
      }
      this.builtAt = parsed.builtAt;
      this.lastRefreshAt = parsed.builtAt;
      console.error(
        `[order-index] restored ${this.entries.size} orders from ${path} ` +
          `(built ${new Date(parsed.builtAt).toISOString()})`
      );
      return this.entries.size > 0;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.error(
          `[order-index] could not read ${path}: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
      return false;
    }
  }

  private async saveToDisk(): Promise<void> {
    const path = this.options.persistPath;
    if (!path || this.builtAt == null) return;
    const payload: PersistedIndex = {
      format: INDEX_FORMAT,
      builtAt: this.builtAt,
      entries: [...this.entries.values()],
    };
    try {
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(payload), "utf8");
      await rename(tmp, path);
    } catch (err) {
      console.error(
        `[order-index] could not write ${path}: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }
}
