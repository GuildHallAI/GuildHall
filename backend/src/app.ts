import express from "express";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { pool } from "./db/index.js";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { commissionsRouter } from "./routes/commissions.js";
import { healthRouter } from "./routes/health.js";
import { internalRouter } from "./routes/internal.js";
import { registryRouter } from "./routes/registry.js";
import { evaluatorsRouter } from "./routes/evaluators.js";
import { tribunalRouter } from "./routes/tribunal.js";
import { agentAccountsRouter } from "./routes/agent-accounts.js";
import { handsRouter } from "./routes/hands.js";
import { rateBoardRouter } from "./routes/rate-board.js";
import { bountiesRouter } from "./routes/bounties.js";
import { bountyXRouter } from "./routes/bounty-x.js";
import { interopRouter } from "./routes/interop.js";
import { crewsRouter } from "./routes/crews.js";
import { guildsRouter } from "./routes/guilds.js";
import { suretyRouter } from "./routes/surety.js";
import { chartersRouter } from "./routes/charters.js";
import { provingGroundRouter } from "./routes/proving-ground.js";
import { provingGroundFundedRouter } from "./routes/proving-ground-funded.js";
import { agentsRouter, agentRuntimeRouter } from "./routes/agents.js";
import { ghallRouter } from "./routes/ghall.js";
import { mcpRouter } from "./routes/mcp.js";
import { reportsRouter } from "./routes/reports.js";
import { errorHandler } from "./http.js";
import { loadSolanaFeePayer } from "./solana-fee-payer.js";
import { migrationStatus } from "./db/migrate.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", config.TRUST_PROXY);
app.use(express.json({ limit: "256kb" }));

app.use("/health", healthRouter);
app.use("/internal", internalRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/reports", reportsRouter);
app.use("/v1/commissions", commissionsRouter);
app.use("/v1/agents", agentsRouter);
app.use("/v1/agent-runtime", agentRuntimeRouter);
app.use("/v1/registry", registryRouter);
app.use("/v1/evaluators", evaluatorsRouter);
app.use("/v1/tribunal", tribunalRouter);
app.use("/v1/agent-accounts", agentAccountsRouter);
app.use("/v1/hands", handsRouter);
app.use("/v1/rate-board", rateBoardRouter);
app.use("/v1/bounties", bountiesRouter);
app.use("/v1/bounty-x", bountyXRouter);
app.use("/v1/interop", interopRouter);
app.use("/v1/crews", crewsRouter);
app.use("/v1/guilds", guildsRouter);
app.use("/v1/surety", suretyRouter);
app.use("/v1/charters", chartersRouter);
app.use("/v1/proving-ground", provingGroundRouter);
app.use("/v1/proving-ground", provingGroundFundedRouter);
app.use("/v1/ghall", ghallRouter);
app.use("/mcp", mcpRouter);

app.get("/ready", async (_request, response) => {
  const checks: Record<string, "ok" | "error"> = {
    database: "error",
    migrations: "error",
    solanaRpc: "error",
    gasPayer: "error",
    reconcilerSecret: "error",
    stablecoinMints: "error",
    settlementRecipients: "error",
    settlementConfig: "error",
  };

  const [database, migrations, rpc, gasPayer, reconcilerSecret, stablecoinMints, settlementRecipients] = await Promise.allSettled([
    pool.query("SELECT 1"),
    migrationStatus(),
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
    Promise.resolve().then(() => loadSolanaFeePayer()),
    Promise.resolve().then(() => {
      if (config.CRON_SECRET.length < 32) throw new Error("CRON_SECRET must contain at least 32 characters.");
    }),
    Promise.resolve().then(async () => {
      const configuredMints = [config.USDC_MINT, config.USDT_MINT].filter((value): value is string => Boolean(value));
      if (configuredMints.length === 0) throw new Error("At least one stablecoin mint must be configured.");
      for (const address of configuredMints) new PublicKey(address);
      if (new Set(configuredMints).size !== configuredMints.length) {
        throw new Error("USDC_MINT and USDT_MINT must be different addresses.");
      }
      await Promise.all(configuredMints.map(async (mint) => {
        const result = await fetch(config.SOLANA_RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: mint,
            method: "getAccountInfo",
            params: [mint, { encoding: "jsonParsed", commitment: config.SOLANA_COMMITMENT }],
          }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!result.ok) throw new Error("Solana RPC could not verify a configured stablecoin mint.");
        const payload = await result.json() as {
          result?: { value?: { owner?: string; data?: { parsed?: { type?: string; info?: { decimals?: number } } } } | null };
          error?: unknown;
        };
        const account = payload.result?.value;
        if (payload.error || !account || account.owner !== TOKEN_PROGRAM_ID.toBase58()
          || account.data?.parsed?.type !== "mint" || account.data.parsed.info?.decimals !== 6) {
          throw new Error("Configured stablecoin mints must be initialized six-decimal SPL Token mints on this cluster.");
        }
      }));
    }),
    Promise.resolve().then(() => {
      const configuredRecipients = [config.WORKER_FEE_WALLET, config.TREASURY_WALLET, config.STAKER_FEE_WALLET];
      if (configuredRecipients.some((value) => !value)) {
        throw new Error("All settlement fee recipient wallets must be configured.");
      }
      for (const address of configuredRecipients) {
        const wallet = new PublicKey(address!);
        if (!PublicKey.isOnCurve(wallet.toBytes())) {
          throw new Error("Settlement fee recipients must be on-curve EOA wallet addresses.");
        }
      }
    }),
  ]);

  if (database.status === "fulfilled") checks.database = "ok";
  if (migrations.status === "fulfilled" && migrations.value.pending.length === 0) checks.migrations = "ok";
  if (rpc.status === "fulfilled") checks.solanaRpc = "ok";
  if (gasPayer.status === "fulfilled") checks.gasPayer = "ok";
  if (reconcilerSecret.status === "fulfilled") checks.reconcilerSecret = "ok";
  if (stablecoinMints.status === "fulfilled") checks.stablecoinMints = "ok";
  if (settlementRecipients.status === "fulfilled") checks.settlementRecipients = "ok";
  if (stablecoinMints.status === "fulfilled" && settlementRecipients.status === "fulfilled") checks.settlementConfig = "ok";

  const features = {
    finalTribunalAiJurorsConfigured: config.TRIBUNAL_AI_JURORS.length >= 3,
    xBountyAutomation: Boolean(config.X_USER_ACCESS_TOKEN && config.X_BOT_USER_ID),
    xBountyAccountLinking: Boolean(config.X_CLIENT_ID && config.X_OAUTH_REDIRECT_URI),
    ghallUtility: Boolean(config.GHALL_MINT),
    provingGroundChallenges: Boolean(config.USDC_MINT && config.PROVING_GROUND_SOL_USD_FEED_ID && config.TREASURY_WALLET),
    fundedProvingGroundTrading: Boolean(config.USDC_MINT && config.JUPITER_API_KEY),
    charterBuybacks: Boolean(config.JUPITER_API_KEY),
  };
  const ready = Object.values(checks).every((check) => check === "ok");
  response.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    cluster: config.SOLANA_CLUSTER,
    checks,
    features,
    pendingMigrations: migrations.status === "fulfilled" ? migrations.value.pending : null,
  });
});

app.use(errorHandler);

export { app };
