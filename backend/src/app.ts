import cors from "cors";
import express from "express";
import { Pool } from "pg";
import { config } from "./config.js";

const pool = new Pool({ connectionString: config.DATABASE_URL });
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", config.TRUST_PROXY);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed."));
    },
  }),
);
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "guildhall-api" });
});

app.get("/ready", async (_request, response) => {
  const checks: Record<string, "ok" | "error"> = {
    database: "error",
    solanaRpc: "error",
  };

  const [database, rpc] = await Promise.allSettled([
    pool.query("SELECT 1"),
    fetch(config.SOLANA_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getVersion",
      }),
      signal: AbortSignal.timeout(5_000),
    }).then(async (result) => {
      if (!result.ok) throw new Error("Solana RPC returned an unsuccessful response.");
      const payload = (await result.json()) as {
        result?: { "solana-core"?: string };
        error?: unknown;
      };
      if (payload.error || !payload.result?.["solana-core"]) {
        throw new Error("Solana RPC did not return a version.");
      }
    }),
  ]);

  if (database.status === "fulfilled") checks.database = "ok";
  if (rpc.status === "fulfilled") checks.solanaRpc = "ok";

  const ready = Object.values(checks).every((check) => check === "ok");
  response.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    cluster: config.SOLANA_CLUSTER,
    programId: config.GUILDHALL_PROGRAM_ID ?? null,
    checks,
  });
});

export async function closeDatabase() {
  await pool.end();
}

export { app };
