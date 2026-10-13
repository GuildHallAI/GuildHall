import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { config } from "./config.js";
import { pool } from "./db/index.js";

const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);

/** Returns the confirmed GHALL balance held by a wallet, or zero while the feature is unconfigured. */
export async function ghallBalanceAtomic(walletAddress: string): Promise<bigint> {
  if (!config.GHALL_MINT) return 0n;
  const owner = new PublicKey(walletAddress);
  const mint = new PublicKey(config.GHALL_MINT);
  const account = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const info = await connection.getAccountInfo(account, config.SOLANA_COMMITMENT);
  const walletBalance = info ? await connection.getTokenAccountBalance(account, config.SOLANA_COMMITMENT) : null;
  if (walletBalance && walletBalance.value.decimals !== 9) throw new Error("GHALL mint must use 9 decimals.");
  const stake = await pool.query<{ stake_wallet_public_key: string }>(
    `SELECT s.stake_wallet_public_key FROM ghall_stake_accounts s JOIN wallet_users u ON u.id = s.user_id
      WHERE u.wallet_address = $1 AND s.mint = $2`, [walletAddress, mint.toBase58()],
  );
  let stakeBalance = 0n;
  if (stake.rows[0]) {
    const stakeAta = getAssociatedTokenAddressSync(mint, new PublicKey(stake.rows[0].stake_wallet_public_key), false, TOKEN_2022_PROGRAM_ID);
    if (await connection.getAccountInfo(stakeAta, config.SOLANA_COMMITMENT)) {
      const balance = await connection.getTokenAccountBalance(stakeAta, config.SOLANA_COMMITMENT);
      if (balance.value.decimals !== 9) throw new Error("GHALL mint must use 9 decimals.");
      stakeBalance = BigInt(balance.value.amount);
    }
  }
  return BigInt(walletBalance?.value.amount ?? "0") + stakeBalance;
}

/** GHALL holdings can raise USDC stake capacity up to the documented 1.25× maximum. */
export async function evaluatorCapacityAtomic(walletAddress: string, usdcStakeAtomic: string | bigint): Promise<bigint> {
  const stake = BigInt(usdcStakeAtomic);
  if (stake <= 0n || !config.GHALL_MINT || config.GHALL_EVALUATOR_BOOST_THRESHOLD_ATOMIC <= 0n
    || config.GHALL_EVALUATOR_MAX_CAPACITY_BPS <= 10_000) return stake;
  const balance = await ghallBalanceAtomic(walletAddress);
  const multiplier = balance >= config.GHALL_EVALUATOR_BOOST_THRESHOLD_ATOMIC
    ? BigInt(config.GHALL_EVALUATOR_MAX_CAPACITY_BPS) : 10_000n;
  return stake * multiplier / 10_000n;
}

export async function evaluatorHasCapacity(
  walletAddress: string,
  usdcStakeAtomic: string | bigint,
  commissionAtomic: string | bigint,
): Promise<boolean> {
  return (await evaluatorCapacityAtomic(walletAddress, usdcStakeAtomic)) >= BigInt(commissionAtomic) * 5n;
}
