export interface TitanConfig {
  baseUrl: string;
  appId: string;
  apiKey: string;
  /** Plant IDs (uppercased) excluded from the summarize_* aggregate tools. */
  excludedPlants: Set<string>;
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

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    appId: appId!,
    apiKey: apiKey!,
    excludedPlants,
  };
}
