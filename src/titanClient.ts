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

export interface CatalogProduct {
  productID: string;
  description?: string;
  unitOfMeasure?: string;
}

export type ProductCatalog = Map<string, CatalogProduct>;

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
            map.set(key, {
              productID: key,
              description: typeof row.description === "string" ? row.description : undefined,
              unitOfMeasure: typeof row.unitOfMeasure === "string" ? row.unitOfMeasure : undefined,
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
