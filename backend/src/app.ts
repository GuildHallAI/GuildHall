import express from "express";
import { pool } from "./db/index.js";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { commissionsRouter } from "./routes/commissions.js";
import { healthRouter } from "./routes/health.js";
import { errorHandler } from "./http.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", config.TRUST_PROXY);
app.use(express.json({ limit: "64kb" }));

app.use("/health", healthRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/commissions", commissionsRouter);

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
    checks,
  });
});

app.use(errorHandler);

export { app };
