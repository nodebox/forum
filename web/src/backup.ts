/**
 * The database as SQL, for the nightly backup (backup/backup.sh fetches it from
 * /backup.sql). The Worker's own binding reaches only this database, which an API
 * token can't be limited to.
 *
 * The schema comes from sqlite_master, then every row, all read in one batch so
 * the dump is one moment of the database. Sessions, sign-in links and rate limits
 * are left out: they are short-lived and hold tokens, and after a restore people
 * sign in again. The search tables are left out too; their triggers fill them
 * again while the rows load. The last line counts each table's rows, so a dump
 * that was cut off is noticed.
 */
const SKIPPED = new Set(["sessions", "login_tokens", "rate_limits"]);

type MasterRow = { type: string; name: string; sql: string | null };

export async function dumpDatabase(db: D1Database): Promise<string> {
  const { results: master } = await db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL").all<MasterRow>();
  const isVirtual = (r: MasterRow) => r.type === "table" && /^CREATE VIRTUAL TABLE/i.test(r.sql ?? "");
  const virtual = master.filter(isVirtual).map((r) => r.name);
  // SQLite's and Cloudflare's own tables, and the tables an FTS5 table keeps its index in.
  const internal = (name: string) => /^(sqlite_|_cf_)/.test(name) || virtual.some((v) => name.startsWith(v + "_"));
  const rank = (r: MasterRow) => (r.type === "table" ? (isVirtual(r) ? 1 : 0) : r.type === "index" ? 2 : 3);
  const schema = master
    .filter((r) => !(r.type === "table" && internal(r.name)))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const tables = schema.filter((r) => rank(r) === 0 && !SKIPPED.has(r.name)).map((r) => r.name);

  const results = await db.batch(tables.map((t) => db.prepare(`SELECT * FROM ${ident(t)}`)));
  const out = ["-- NodeBox forum, D1 database nodebox-forum. Schema, then data.", ...schema.map((r) => `${r.sql};`), "PRAGMA defer_foreign_keys = TRUE;"];
  const counts: string[] = [];
  tables.forEach((table, i) => {
    const rows = (results[i]!.results ?? []) as Record<string, unknown>[];
    counts.push(`${table}=${rows.length}`);
    for (const row of rows) {
      const columns = Object.keys(row);
      out.push(`INSERT INTO ${ident(table)} (${columns.map(ident).join(",")}) VALUES (${columns.map((c) => literal(row[c])).join(",")});`);
    }
  });
  out.push(`-- rows: ${counts.join(" ")}`);
  return out.join("\n") + "\n";
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  // D1 hands BLOBs over as an array of bytes.
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : Array.isArray(value) ? Uint8Array.from(value) : null;
  if (bytes) return `X'${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
  throw new Error(`Can't write a ${typeof value} as SQL`);
}

/** Whether the request carries the backup token. Compares digests, so the time taken says nothing about the token. */
export async function isBackupRequest(token: string | undefined, authorization: string | undefined): Promise<boolean> {
  if (!token || !authorization?.startsWith("Bearer ")) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(token), digest(authorization.slice("Bearer ".length))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
