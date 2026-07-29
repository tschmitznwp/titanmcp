import type { TitanConfig } from "./config.js";

export class TitanApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TitanApiError";
  }
}

interface Envelope {
  successful?: boolean;
  errorMessage?: string | null;
  errors?: { property?: string | null; errors?: string[] | null }[] | null;
  paginationData?: unknown;
  result?: unknown;
}

export interface TitanResponse {
  result: unknown;
  paginationData?: unknown;
}

// Field names verified against a live /Products row (2026-07-29): the description
// lives in `productName` and the unit in `uom` — NOT `description`/`unitOfMeasure`,
// which is why every enriched group reported productName: null while claiming
// resolved: true. type/partTypeID/productLine are carried so charges (freight, fuel
// surcharge, quote notes) can be told apart from manufactured goods.
export interface CatalogProduct {
  productID: string;
  productName?: string;
  unitOfMeasure?: string;
  type?: string;
  partTypeID?: string;
  productLine?: string;
  status?: string;
}

export type ProductCatalog = Map<string, CatalogProduct>;

export interface CatalogCustomer {
  customerID: string;
  companyName?: string;
  city?: string;
  state?: string;
  status?: string;
  salesRep?: string;
}

export type CustomerCatalog = Map<string, CatalogCustomer>;

const PRODUCT_CATALOG_TTL_MS = 30 * 60 * 1000;
const PRODUCT_CATALOG_PAGE_SIZE = 500;
const PRODUCT_CATALOG_MAX_PAGES = 200;

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatValidationErrors(errors: Envelope["errors"]): string {
  if (!errors || errors.length === 0) return "";
  const parts = errors.map((e) => {
    const msgs = (e.errors ?? []).join("; ");
    return e.property ? `${e.property}: ${msgs}` : msgs;
  });
  return ` Validation errors: ${parts.join(" | ")}`;
}

export class TitanClient {
  constructor(private readonly config: TitanConfig) {}

  private productCatalogCache?: { at: number; catalog: ProductCatalog };
  private productCatalogInFlight?: Promise<ProductCatalog>;
  private customerCatalogCache?: { at: number; catalog: CustomerCatalog };
  private customerCatalogInFlight?: Promise<CustomerCatalog>;

  get excludedPlants(): Set<string> {
    return this.config.excludedPlants;
  }

  async getProductCatalog(): Promise<ProductCatalog> {
    const cached = this.productCatalogCache;
    if (cached && Date.now() - cached.at < PRODUCT_CATALOG_TTL_MS) return cached.catalog;
    if (this.productCatalogInFlight) return this.productCatalogInFlight;
    this.productCatalogInFlight = (async () => {
      try {
        const map: ProductCatalog = new Map();
        for (let page = 1; page <= PRODUCT_CATALOG_MAX_PAGES; page++) {
          const data = await this.get("/api/v1/Products", {
            PageNumber: page,
            PageSize: PRODUCT_CATALOG_PAGE_SIZE,
          });
          const rows = Array.isArray(data.result) ? (data.result as Record<string, unknown>[]) : [];
          for (const row of rows) {
            const pid = row.productID ?? row.productId;
            if (pid == null) continue;
            const key = String(pid);
            if (map.has(key)) continue;
            const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
            map.set(key, {
              productID: key,
              productName: str(row.productName),
              unitOfMeasure: str(row.uom),
              type: str(row.type),
              partTypeID: str(row.partTypeID),
              productLine: str(row.productLine),
              status: str(row.status),
            });
          }
          const pagination = data.paginationData as { totalCount?: number } | undefined;
          if (pagination?.totalCount != null) {
            if (page >= Math.ceil(pagination.totalCount / PRODUCT_CATALOG_PAGE_SIZE)) break;
          } else if (rows.length === 0) {
            break;
          }
        }
        this.productCatalogCache = { at: Date.now(), catalog: map };
        return map;
      } finally {
        this.productCatalogInFlight = undefined;
      }
    })();
    return this.productCatalogInFlight;
  }

  /**
   * The Titan API has no name filter on /Customers, so name lookup is served from
   * a cached snapshot of the whole list. Unlike sales orders, the list rows are
   * complete records, so this is ~4 requests for the 1,843 customers at NWPX — no
   * per-record fetch, and only the search fields are retained.
   */
  async getCustomerCatalog(): Promise<CustomerCatalog> {
    const cached = this.customerCatalogCache;
    if (cached && Date.now() - cached.at < PRODUCT_CATALOG_TTL_MS) return cached.catalog;
    if (this.customerCatalogInFlight) return this.customerCatalogInFlight;
    this.customerCatalogInFlight = (async () => {
      try {
        const map: CustomerCatalog = new Map();
        for (let page = 1; page <= PRODUCT_CATALOG_MAX_PAGES; page++) {
          const data = await this.get("/api/v1/Customers", {
            PageNumber: page,
            PageSize: PRODUCT_CATALOG_PAGE_SIZE,
          });
          const rows = Array.isArray(data.result) ? (data.result as Record<string, unknown>[]) : [];
          for (const row of rows) {
            const id = row.customerID ?? row.customerId;
            if (id == null) continue;
            const key = String(id);
            if (map.has(key)) continue;
            const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
            map.set(key, {
              customerID: key,
              companyName: str(row.companyName),
              city: str(row.city),
              state: str(row.state),
              status: str(row.status),
              salesRep: str(row.salesRep),
            });
          }
          const pagination = data.paginationData as { totalCount?: number } | undefined;
          if (pagination?.totalCount != null) {
            if (page >= Math.ceil(pagination.totalCount / PRODUCT_CATALOG_PAGE_SIZE)) break;
          } else if (rows.length === 0) {
            break;
          }
        }
        this.customerCatalogCache = { at: Date.now(), catalog: map };
        return map;
      } finally {
        this.customerCatalogInFlight = undefined;
      }
    })();
    return this.customerCatalogInFlight;
  }

  async get(path: string, query: Record<string, unknown> = {}): Promise<TitanResponse> {
    const url = new URL(this.config.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "X-App-Id": this.config.appId,
          "X-Api-Key": this.config.apiKey,
          Accept: "application/json",
        },
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new TitanApiError(
        `Could not reach the Titan API at ${this.config.baseUrl} (GET ${path}): ${cause}`
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new TitanApiError(
        `Titan API returned ${response.status} ${response.statusText} for GET ${path}` +
          (text ? `: ${truncate(text)}` : "")
      );
    }
    if (!text) return { result: null };

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TitanApiError(
        `Titan API returned a non-JSON response for GET ${path}: ${truncate(text)}`
      );
    }

    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      const envelope = body as Envelope;
      if ("successful" in envelope || "result" in envelope) {
        if (envelope.successful === false) {
          throw new TitanApiError(
            `Titan API reported a failure for GET ${path}: ` +
              (envelope.errorMessage ?? "no error message provided.") +
              formatValidationErrors(envelope.errors)
          );
        }
        return {
          result: envelope.result ?? null,
          ...(envelope.paginationData != null ? { paginationData: envelope.paginationData } : {}),
        };
      }
    }
    return { result: body };
  }
}
