import type { OrderIndexOptions } from "./orderIndex.js";

export interface TitanConfig {
  baseUrl: string;
  appId: string;
  apiKey: string;
  /** Plant IDs (uppercased) excluded from the summarize_* aggregate tools. */
  excludedPlants: Set<string>;
  /** Background sales-order index that makes bookedDate queryable. */
  orderIndex: OrderIndexOptions;
}

function num(value: string | undefined, fallback: number, label: string): number {
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${label}: ${value} (expected a positive number).`);
  }
  return n;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TitanConfig {
  const baseUrl = env.TITAN_BASE_URL?.trim();
  const appId = env.TITAN_APP_ID?.trim();
  const apiKey = env.TITAN_API_KEY?.trim();

  const missing: string[] = [];
  if (!baseUrl) missing.push("TITAN_BASE_URL");
  if (!appId) missing.push("TITAN_APP_ID");
  if (!apiKey) missing.push("TITAN_API_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "See .env.example for the expected configuration."
    );
  }

  const excludedPlants = new Set(
    (env.TITAN_EXCLUDED_PLANTS ?? "")
      .split(",")
      .map((p) => p.trim().toUpperCase())
      .filter((p) => p.length > 0)
  );

  const persistPath = env.TITAN_ORDER_INDEX_PATH?.trim();
  const minOrderDate = env.TITAN_ORDER_INDEX_MIN_ORDER_DATE?.trim();
  if (minOrderDate && !/^\d{4}-\d{2}-\d{2}$/.test(minOrderDate)) {
    throw new Error(
      `Invalid TITAN_ORDER_INDEX_MIN_ORDER_DATE: ${minOrderDate} (expected YYYY-MM-DD).`
    );
  }

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    appId: appId!,
    apiKey: apiKey!,
    excludedPlants,
    orderIndex: {
      enabled: bool(env.TITAN_ORDER_INDEX, true),
      concurrency: num(env.TITAN_ORDER_INDEX_CONCURRENCY, 12, "TITAN_ORDER_INDEX_CONCURRENCY"),
      refreshMs:
        num(env.TITAN_ORDER_INDEX_REFRESH_MINUTES, 15, "TITAN_ORDER_INDEX_REFRESH_MINUTES") *
        60_000,
      fullRebuildMs:
        num(env.TITAN_ORDER_INDEX_REBUILD_HOURS, 24, "TITAN_ORDER_INDEX_REBUILD_HOURS") *
        3_600_000,
      ...(persistPath ? { persistPath } : {}),
      ...(minOrderDate ? { minOrderDate } : {}),
    },
  };
}
