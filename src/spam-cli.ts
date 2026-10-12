import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { openDb } from "./db.ts";
import * as spam from "./spam.ts";

const USAGE = `Usage: npm run spam -- <command>

Commands:
  estimate        count what the model would see and what it would cost
  classify        classify every exported discussion that has no verdict yet
  review [file]   write the review CSV (default data/spam-review.csv)
  apply <file>    read your decisions back from the review CSV
  stats           show verdicts and what the import will leave out

Options for classify and estimate:
  --redo          classify everything again, not only new discussions
  --limit=N       only the first N pending discussions (for a trial)

Environment: ANTHROPIC_API_KEY (or an \`ant auth login\` profile),
SPAM_MODEL (default claude-opus-5-5), SPAM_EFFORT (default low),
SPAM_CONCURRENCY (default 4), DATA_DIR (default data).`;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

async function main() {
  const args = process.argv.slice(2);
  const [command, ...rest] = args.filter((a) => !a.startsWith("--"));
  if (!command || args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const limit = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
  const effort = env("SPAM_EFFORT") ?? "low";
  if (!["low", "medium", "high"].includes(effort)) throw new Error(`SPAM_EFFORT must be low, medium or high`);
  const cfg: spam.SpamConfig = {
    model: env("SPAM_MODEL") ?? "claude-opus-5-5",
    effort: effort as spam.SpamConfig["effort"],
    concurrency: Number(env("SPAM_CONCURRENCY") ?? 4),
    limit: limit ? Number(limit) : undefined,
    redo: args.includes("--redo"),
  };
  const dataDir = path.resolve(env("DATA_DIR") ?? "data");
  const db = openDb(path.join(dataDir, "forum.sqlite"));
  try {
    switch (command) {
      case "estimate":
        spam.estimate(db, cfg);
        break;
      case "classify":
        await spam.classify(db, cfg, new Anthropic({ maxRetries: 6 }));
        break;
      case "review":
        spam.writeReview(db, rest[0] ?? path.join(dataDir, "spam-review.csv"));
        break;
      case "apply":
        if (!rest[0]) throw new Error("apply needs the CSV file");
        spam.applyReview(db, rest[0]);
        break;
      case "stats":
        spam.stats(db);
        break;
      default:
        throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
