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
let reconcileInFlight: Promise<void> | null = null;
let shutdownPromise: Promise<void> | null = null;

function runScheduledReconcile() {
  if (reconcileInFlight) return;
  reconcileInFlight = reconcileOnce().then((result) => {
    if ("skipped" in result && result.skipped) return;
    const errors = Object.entries(result).filter(([key, value]) => key !== "skipped" && value
      && typeof value === "object" && "error" in value);
    if (errors.length) console.error(`[reconcile] ${errors.length} task group(s) reported errors.`);
  }).catch((error) => {
    console.error("[reconcile] worker cycle failed", error);
  }).finally(() => {
    reconcileInFlight = null;
  });
}

try {
  await migrate();
  markStartupReady();
  console.log("GuildHall API startup migrations complete.");
  reconcileTimer = setInterval(runScheduledReconcile, config.RECONCILE_INTERVAL_MS);
} catch (error) {
  console.error("GuildHall API startup migrations failed.", error);
  server.close(async () => {
    await closeDatabase();
    process.exitCode = 1;
  });
}

function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  if (reconcileTimer) clearInterval(reconcileTimer);
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  shutdownPromise = (async () => {
    await Promise.all([serverClosed, reconcileInFlight ?? Promise.resolve()]);
    await closeDatabase();
    process.exit(0);
  })().catch((error) => {
    console.error("GuildHall API shutdown failed.", error);
    process.exit(1);
  });
  return shutdownPromise;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
