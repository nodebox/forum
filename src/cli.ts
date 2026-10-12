import { loadConfig } from "./config.ts";
import { TenderClient } from "./client.ts";
import { openDb } from "./db.ts";
import * as steps from "./steps.ts";

let started = false;
const ALL = ["categories", "discussions", "details", "users", "kb", "attachments"] as const;
const STEPS: Record<string, (ctx: steps.Ctx) => unknown> = {
  ping: steps.ping,
  categories: steps.categories,
  discussions: steps.discussions,
  details: steps.details,
  users: steps.users,
  kb: steps.kb,
  attachments: steps.attachments,
  "retry-failed": steps.retryFailed,
  stats: steps.stats,
};

const USAGE = `Usage: npm run export -- [--refresh] [step ...]

Steps (default: ${ALL.join(" ")}):
  ping           check the API key and site name
  categories     fetch all categories
  discussions    list every discussion in every category
  details        fetch each discussion with its comments and attachment metadata
  users          fetch user profiles for all authors
  kb             fetch knowledge base sections and articles
  attachments    download attachment files
  retry-failed   re-queue anything that failed earlier
  stats          print what is in the database

Every step resumes where it stopped. --refresh re-walks the discussion lists
so new or updated discussions are picked up on a later run.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const refresh = args.includes("--refresh");
  const names = args.filter((a) => !a.startsWith("--"));
  const unknown = names.filter((n) => !(n in STEPS));
  if (unknown.length) {
    console.error(`Unknown step(s): ${unknown.join(", ")}\n\n${USAGE}`);
    process.exit(2);
  }
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const client = new TenderClient(config);
  const ctx: steps.Ctx = { config, client, db, refresh };
  const startedAt = Date.now();
  started = true;
  for (const name of names.length ? names : [...ALL, "stats"]) {
    await STEPS[name](ctx);
  }
  console.log(`\nDone: ${client.requests} requests in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
  db.close();
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  if (started) console.error("Progress is saved; run the same command again to resume.");
  process.exit(1);
});
