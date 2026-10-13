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
    DATA_ENCRYPTION_KEY: z.string().min(32),
  })
  .parse(process.env);

export const config = env;
