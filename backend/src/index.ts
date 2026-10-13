import "dotenv/config";
import { app } from "./app.js";
import { closeDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { config } from "./config.js";
import { reconcileOnce } from "./routes/internal.js";

await migrate();

const server = app.listen(config.PORT, () => {
  console.log(`GuildHall API listening on :${config.PORT}`);
});

const reconcileTimer = setInterval(() => {
  void reconcileOnce().then((result) => {
    if ("skipped" in result && result.skipped) return;
    const errors = Object.entries(result).filter(([key, value]) => key !== "skipped" && value
      && typeof value === "object" && "error" in value);
    if (errors.length) console.error(`[reconcile] ${errors.length} task group(s) reported errors.`);
  }).catch((error) => console.error("[reconcile] worker cycle failed", error));
}, config.RECONCILE_INTERVAL_MS);

async function shutdown() {
  clearInterval(reconcileTimer);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
