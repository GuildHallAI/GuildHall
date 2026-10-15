import "dotenv/config";
import { app, markStartupReady } from "./app.js";
import { closeDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { config } from "./config.js";
import { reconcileOnce } from "./routes/internal.js";

const server = app.listen(config.PORT, () => {
  console.log(`GuildHall API listening on :${config.PORT}`);
});

let reconcileTimer: ReturnType<typeof setInterval> | undefined;

try {
  await migrate();
  markStartupReady();
  console.log("GuildHall API startup migrations complete.");
  reconcileTimer = setInterval(() => {
    void reconcileOnce().then((result) => {
      if ("skipped" in result && result.skipped) return;
      const errors = Object.entries(result).filter(([key, value]) => key !== "skipped" && value
        && typeof value === "object" && "error" in value);
      if (errors.length) console.error(`[reconcile] ${errors.length} task group(s) reported errors.`);
    }).catch((error) => console.error("[reconcile] worker cycle failed", error));
  }, config.RECONCILE_INTERVAL_MS);
} catch (error) {
  console.error("GuildHall API startup migrations failed.", error);
  server.close(async () => {
    await closeDatabase();
    process.exitCode = 1;
  });
}

async function shutdown() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
