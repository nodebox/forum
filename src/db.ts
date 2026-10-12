import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "migrations");

export type DB = DatabaseSync;

export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

export const now = () => new Date().toISOString();

/** Convert JS values to something node:sqlite accepts. */
export function v(x: unknown): string | number | null {
  if (x === undefined || x === null) return null;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "number" || typeof x === "string") return x;
  return JSON.stringify(x);
}

/** INSERT ... ON CONFLICT DO UPDATE for the given columns. */
export function upsert(db: DB, table: string, key: string[], row: Record<string, unknown>) {
  const cols = Object.keys(row);
  const updates = cols.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`);
  const sql =
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})` +
    ` ON CONFLICT (${key.join(", ")}) DO ${updates.length ? "UPDATE SET " + updates.join(", ") : "NOTHING"}`;
  db.prepare(sql).run(...cols.map((c) => v(row[c])));
}

export function getState(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setState(db: DB, key: string, value: string) {
  db.prepare(
    "INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, now());
}

export function clearState(db: DB, prefix: string) {
  db.prepare("DELETE FROM sync_state WHERE key LIKE ?").run(prefix + "%");
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
