import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";
import { ApiError } from "./http.js";

export function loadSolanaFeePayer() {
  if (!config.GAS_PAYER_PRIVATE_KEY) {
    throw new ApiError(503, "settlement_unavailable", "The backend gas payer is not configured.");
  }
  try {
    const secret = bs58.decode(config.GAS_PAYER_PRIVATE_KEY);
    if (secret.length !== 64) throw new Error("Invalid key length");
    const keypair = Keypair.fromSecretKey(secret);
    if (config.GUILDHALL_GAS_WALLET_PUBLIC_KEY
      && !keypair.publicKey.equals(new PublicKey(config.GUILDHALL_GAS_WALLET_PUBLIC_KEY))) {
      throw new Error("Configured public key does not match private key");
    }
    return keypair;
  } catch {
    throw new ApiError(503, "settlement_misconfigured", "The backend gas payer key is invalid.");
  }
}
