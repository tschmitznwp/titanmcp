export interface TitanConfig {
  baseUrl: string;
  appId: string;
  apiKey: string;
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

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    appId: appId!,
    apiKey: apiKey!,
  };
}
