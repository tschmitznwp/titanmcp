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

  get excludedPlants(): Set<string> {
    return this.config.excludedPlants;
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
