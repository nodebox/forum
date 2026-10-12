import { app } from "./app.ts";
import type { Bindings } from "./env.ts";
import { sendDigests } from "./notifications.ts";

export default {
  fetch: app.fetch,
  // Hourly: email grouped reply digests (each person gets one a day at most).
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(sendDigests(env).then((n) => console.log(`sent ${n} digest(s)`)));
  },
} satisfies ExportedHandler<Bindings>;
