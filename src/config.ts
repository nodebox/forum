import path from "node:path";

export interface Config {
  apiKey: string;
  site: string;
  apiBase: string;
  assetBase: string;
  dataDir: string;
  dbPath: string;
  attachmentsDir: string;
  delayMs: number;
  maxRetries: number;
  includeDeleted: boolean;
  limit: number | undefined;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function loadConfig(): Config {
  const apiKey = env("TENDER_API_KEY");
  if (!apiKey) {
    throw new Error("TENDER_API_KEY is not set. Put it in .env (see .env.example) or export it in your shell.");
  }
  const site = env("TENDER_SITE") ?? "nodebox";
  const dataDir = path.resolve(env("DATA_DIR") ?? "data");
  const limit = env("TENDER_LIMIT");
  return {
    apiKey,
    site,
    apiBase: (env("TENDER_API_BASE") ?? "https://api.tenderapp.com").replace(/\/$/, "") + "/" + site,
    assetBase: (env("TENDER_ASSET_BASE") ?? `https://${site}.tenderapp.com`).replace(/\/$/, ""),
    dataDir,
    dbPath: path.join(dataDir, "forum.sqlite"),
    attachmentsDir: path.join(dataDir, "attachments"),
    delayMs: Number(env("TENDER_DELAY_MS") ?? 400),
    maxRetries: Number(env("TENDER_MAX_RETRIES") ?? 8),
    includeDeleted: env("TENDER_INCLUDE_DELETED") === "1",
    limit: limit ? Number(limit) : undefined,
  };
}
