// Bootstrap and manage admins from the command line.
//
//   npm run admin -- grant frederik@example.com            # local dev database
//   npm run admin -- grant frederik@example.com --remote   # production D1
//   npm run admin -- revoke someone@example.com --remote
//   npm run admin -- list --remote
//
// `grant` works before the person has ever signed in: it creates the account,
// and their first sign-in with that email (Google or email link) picks it up.
// After the first admin exists, admins can promote others at /admin/users.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const [command, rawEmail] = args.filter((a) => !a.startsWith("--"));
const DB = "nodebox-forum";

function d1(sql: string): string {
  return execFileSync("npx", ["wrangler", "d1", "execute", DB, remote ? "--remote" : "--local", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function emailArg(): string {
  const email = (rawEmail ?? "").trim().toLowerCase();
  // Strict pattern, so the address can be inlined in SQL without quoting tricks.
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
    console.error(`Not an email address: ${rawEmail ?? "(missing)"}`);
    process.exit(1);
  }
  return email;
}

const now = new Date().toISOString();
switch (command) {
  case "grant": {
    const email = emailArg();
    const name = email.split("@")[0]!.replace(/'/g, "");
    d1(
      `INSERT INTO users (email, name, is_admin, created_at) VALUES ('${email}', '${name}', 1, '${now}')
       ON CONFLICT (email) DO UPDATE SET is_admin = 1, banned_at = NULL;
       INSERT INTO moderation_log (admin_id, action, user_id, reason, created_at)
       SELECT NULL, 'grant_admin', id, 'command line', '${now}' FROM users WHERE email = '${email}';`,
    );
    console.log(`${email} is now an admin (${remote ? "remote" : "local"} database).`);
    break;
  }
  case "revoke": {
    const email = emailArg();
    d1(
      `UPDATE users SET is_admin = 0 WHERE email = '${email}';
       INSERT INTO moderation_log (admin_id, action, user_id, reason, created_at)
       SELECT NULL, 'revoke_admin', id, 'command line', '${now}' FROM users WHERE email = '${email}';`,
    );
    console.log(`${email} is no longer an admin.`);
    break;
  }
  case "list": {
    const out = JSON.parse(d1("SELECT id, name, email FROM users WHERE is_admin = 1 ORDER BY name"));
    const rows = out[0]?.results ?? [];
    if (rows.length === 0) console.log("No admins yet.");
    for (const r of rows) console.log(`${r.id}\t${r.name}\t${r.email}`);
    break;
  }
  default:
    console.error("Usage: npm run admin -- grant|revoke <email> [--remote]  |  npm run admin -- list [--remote]");
    process.exit(1);
}
