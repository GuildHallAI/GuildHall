import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess((value) => value === "" ? undefined : value, z.string().optional());
const optionalUrl = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());
const optionalRegex = (pattern: RegExp) => z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().regex(pattern).optional(),
);

const tribunalModels = z.array(z.object({
  id: z.string().min(1).max(100),
  endpoint: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1).max(160),
})).max(8).superRefine((models, context) => {
  const ids = models.map((model) => model.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "AI juror IDs must be unique." });
});

const env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3001),
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),
    RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
    DATABASE_URL: z.string().url(),
    SOLANA_CLUSTER: z
      .enum(["localnet", "devnet", "testnet", "mainnet-beta"])
      .default("devnet"),
    SOLANA_RPC_URL: z.string().url(),
    SOLANA_COMMITMENT: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
    DATA_ENCRYPTION_KEY: z.string().min(32),
    CLOUDINARY_CLOUD_NAME: optionalString,
    CLOUDINARY_API_KEY: optionalString,
    CLOUDINARY_API_SECRET: optionalString,
    AUTH_DOMAIN: z.string().min(1).default("guildhallai.com"),
    AUTH_URI: z.string().url().default("https://guildhallai.com"),
    AUTH_TOKEN_PEPPER: z.string().default(""),
    GAS_PAYER_PRIVATE_KEY: optionalString,
    GUILDHALL_GAS_WALLET_PRIVATE_KEY: optionalString,
    GUILDHALL_GAS_WALLET_PUBLIC_KEY: optionalString,
    CRON_SECRET: z.string().default(""),
    WORKER_FEE_WALLET: optionalString,
    TREASURY_WALLET: optionalString,
    STAKER_FEE_WALLET: optionalString,
    // GHALL is an extension-free Token-2022 mint. Capacity boosts remain off until
    // both a mint and an explicit holding threshold are configured.
    GHALL_MINT: optionalString,
    GHALL_EVALUATOR_BOOST_THRESHOLD_ATOMIC: z.coerce.bigint().min(0n).default(0n),
    GHALL_EVALUATOR_MAX_CAPACITY_BPS: z.coerce.number().int().min(10_000).max(12_500).default(10_000),
    GHALL_LISTING_MINIMUM_STAKE_ATOMIC: z.coerce.bigint().min(0n).default(0n),
    GHALL_BOUNTY_PRIORITY_THRESHOLD_ATOMIC: z.coerce.bigint().min(0n).default(0n),
    GHALL_GOVERNANCE_MIN_QUORUM_ATOMIC: z.coerce.bigint().min(0n).default(0n),
    GHALL_GOVERNANCE_VOTING_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    TRIBUNAL_AI_JURORS: z.string().default("[]").transform((value, context) => {
      try { return tribunalModels.parse(JSON.parse(value)); }
      catch {
        context.addIssue({ code: "custom", message: "TRIBUNAL_AI_JURORS must be a JSON array of model configurations." });
        return z.NEVER;
      }
    }),
    TRIBUNAL_APPEAL_FEE_ATOMIC: z.coerce.bigint().min(0n).max(18_446_744_073_709_551_615n).default(0n),
    TRIBUNAL_PANEL_VOTE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    GHALL_TRIBUNAL_FEE_DISCOUNT_THRESHOLD_ATOMIC: z.coerce.bigint().min(0n).default(0n),
    GHALL_TRIBUNAL_FEE_DISCOUNT_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
    X_USER_ACCESS_TOKEN: optionalString,
    X_BOT_USER_ID: optionalRegex(/^\d{1,30}$/),
    X_CLIENT_ID: optionalString,
    X_CLIENT_SECRET: optionalString,
    X_OAUTH_REDIRECT_URI: optionalUrl,
    X_BOUNTY_ENTRY_BOND_ATOMIC: z.coerce.bigint().min(1_000_000n).max(100_000_000n).default(1_000_000n),
    X_BOUNTY_MAX_ENTRIES: z.coerce.number().int().min(1).max(100).default(20),
    GUILDHALL_ACTIONS_BASE_URL: optionalUrl,
    USDC_MINT: optionalString,
    USDT_MINT: optionalString,
    AGENT_REGISTRY_PROGRAM_ID: optionalString,
    AGENT_REGISTRY_ATOM_PROGRAM_ID: optionalString,
    SURETY_BASE_PREMIUM_BPS: z.coerce.number().int().min(1).max(5000).default(100),
    SURETY_OVERTURN_RISK_BPS: z.coerce.number().int().min(0).max(5000).default(100),
    SURETY_MAX_PREMIUM_BPS: z.coerce.number().int().min(1).max(5000).default(500),
    // Token-2022 stores supply as u64 base units. Charters use 9 decimals.
    CHARTER_TOTAL_SUPPLY_TOKENS: z.coerce.bigint().min(1n).max(18_446_744_073n).default(1_000_000_000n),
    CHARTER_CREATOR_SHARE_BPS: z.coerce.number().int().min(1).max(5000).default(2000),
    CHARTER_VESTING_WEEKS: z.coerce.number().int().min(1).max(520).default(52),
    CHARTER_SLA_MINIMUM_ON_TIME_BPS: z.coerce.number().int().min(9000).max(10000).default(9000),
    CHARTER_INCOME_BUYBACK_BPS: z.coerce.number().int().min(500).max(10000).default(500),
    CHARTER_LAUNCH_FEE_ATOMIC: z.coerce.bigint().min(0n).max(18_446_744_073_709_551_615n).default(0n),
    PYTH_HERMES_URL: z.string().url().default("https://pyth.dourolabs.app/hermes"),
    PYTH_API_KEY: optionalString,
    JUPITER_API_KEY: optionalString,
    PROVING_GROUND_SOL_USD_FEED_ID: optionalRegex(/^(0x)?[0-9a-fA-F]{64}$/),
    PROVING_GROUND_INITIAL_CAPITAL_ATOMIC: z.coerce.bigint().min(1_000_000n).max(1_000_000_000_000n).default(1_000_000_000n),
    PROVING_GROUND_CHALLENGE_FEE_ATOMIC: z.coerce.bigint().min(1_000_000n).max(10_000_000_000n).default(25_000_000n),
    PROVING_GROUND_DURATION_DAYS: z.coerce.number().int().min(14).max(14).default(14),
    PROVING_GROUND_TARGET_BPS: z.coerce.number().int().min(800).max(800).default(800),
    PROVING_GROUND_DAILY_DRAWDOWN_BPS: z.coerce.number().int().min(500).max(500).default(500),
    PROVING_GROUND_TOTAL_DRAWDOWN_BPS: z.coerce.number().int().min(1000).max(1000).default(1000),
  })
  .superRefine((value, context) => {
    const cloudinarySettings = [value.CLOUDINARY_CLOUD_NAME, value.CLOUDINARY_API_KEY, value.CLOUDINARY_API_SECRET];
    if (cloudinarySettings.some(Boolean) && cloudinarySettings.some((setting) => !setting)) {
      context.addIssue({ code: "custom", path: ["CLOUDINARY_CLOUD_NAME"], message: "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET must be configured together." });
    }
    if (value.GAS_PAYER_PRIVATE_KEY && value.GUILDHALL_GAS_WALLET_PRIVATE_KEY
      && value.GAS_PAYER_PRIVATE_KEY !== value.GUILDHALL_GAS_WALLET_PRIVATE_KEY) {
      context.addIssue({ code: "custom", path: ["GUILDHALL_GAS_WALLET_PRIVATE_KEY"],
        message: "GAS_PAYER_PRIVATE_KEY and GUILDHALL_GAS_WALLET_PRIVATE_KEY must match when both are set." });
    }
  })
  .parse(process.env);

export const config = {
  ...env,
  GAS_PAYER_PRIVATE_KEY: env.GAS_PAYER_PRIVATE_KEY ?? env.GUILDHALL_GAS_WALLET_PRIVATE_KEY,
  GUILDHALL_ACTIONS_BASE_URL: env.GUILDHALL_ACTIONS_BASE_URL ?? env.AUTH_URI,
};
