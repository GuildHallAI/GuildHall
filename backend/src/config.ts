import "dotenv/config";
import { z } from "zod";

const env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3001),
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),
    DATABASE_URL: z.string().url(),
    SOLANA_CLUSTER: z
      .enum(["localnet", "devnet", "testnet", "mainnet-beta"])
      .default("devnet"),
    SOLANA_RPC_URL: z.string().url(),
    SOLANA_COMMITMENT: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
    GUILDHALL_PROGRAM_ID: z.string().min(32).optional(),
    CORS_ORIGINS: z.string().default("http://localhost:3000"),
  })
  .parse(process.env);

export const config = {
  ...env,
  corsOrigins: new Set(
    env.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
};
