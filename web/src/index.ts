import { app } from "./app.ts";
import type { Bindings } from "./env.ts";
import { sweepPending } from "./files.ts";
import { sendDigests } from "./notifications.ts";

export default {
  fetch: app.fetch,
  // Hourly: email grouped reply digests (each person gets one a day at most),
  // and remove uploads that never became part of a post.
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(sendDigests(env).then((n) => console.log(`sent ${n} digest(s)`)));
    ctx.waitUntil(sweepPending(env).then((r) => console.log(`pending uploads: removed ${r.removed}, moved ${r.moved}`)));
  },
} satisfies ExportedHandler<Bindings>;
