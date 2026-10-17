import { createHash } from "node:crypto";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { ApiError } from "./http.js";
import { loadSolanaFeePayer } from "./solana-fee-payer.js";
import { commissionTermsDocument, commissionTermsHash, termsMemoText } from "./commission-terms.js";

type ReceiptRole =
  | "provider" | "crew_member" | "charter_buyback" | "client"
  | "fee_workers" | "fee_treasury" | "fee_stakers" | "fee_burn";

export type ReceiptLine = { role: ReceiptRole; wallet: string | null; amountAtomic: string; shareOfFeeBps?: number };

const FEE_SHARES_BPS = { fee_workers: 8_000, fee_treasury: 1_000, fee_stakers: 500, fee_burn: 500 } as const;

export function explorerTransactionUrl(signature: string, cluster: string = config.SOLANA_CLUSTER) {
  return `https://solscan.io/tx/${signature}${cluster === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(cluster)}`}`;
}

export function explorerAccountUrl(address: string, cluster: string = config.SOLANA_CLUSTER) {
  return `https://solscan.io/account/${address}${cluster === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(cluster)}`}`;
}

/** Rebuild who received what from a settlement operation's recorded distribution. */
export function settlementLines(
  kind: "release" | "refund" | "split",
  grossAtomic: string,
  distribution: Record<string, string>,
  wallets: { provider: string | null; client: string },
): ReceiptLine[] {
  if (kind === "refund") return [{ role: "client", wallet: wallets.client, amountAtomic: distribution.client ?? grossAtomic }];
  const lines: ReceiptLine[] = [];
  const crewOrders = Object.keys(distribution)
    .map((key) => /^crewWallet(\d+)$/.exec(key)?.[1])
    .filter((order): order is string => order !== undefined)
    .sort((left, right) => Number(left) - Number(right));
  if (crewOrders.length) {
    for (const order of crewOrders) {
      const amount = BigInt(distribution[`crewAmount${order}`] ?? "0");
      const buyback = BigInt(distribution[`crewBuybackAtomic${order}`] ?? "0");
      lines.push({ role: "crew_member", wallet: distribution[`crewWallet${order}`]!, amountAtomic: (amount - buyback).toString() });
      if (buyback > 0n) {
        lines.push({ role: "charter_buyback", wallet: distribution[`crewBuybackWallet${order}`] ?? null, amountAtomic: buyback.toString() });
      }
    }
  } else {
    const buyback = BigInt(distribution.charterBuybackAtomic ?? "0");
    lines.push({ role: "provider", wallet: wallets.provider, amountAtomic: (BigInt(distribution.provider ?? "0") - buyback).toString() });
    if (buyback > 0n) lines.push({ role: "charter_buyback", wallet: distribution.charterBuybackWallet ?? null, amountAtomic: buyback.toString() });
  }
  if (kind === "split" && distribution.client) lines.push({ role: "client", wallet: wallets.client, amountAtomic: distribution.client });
  lines.push(
    { role: "fee_workers", wallet: distribution.feeWorkerWallet ?? null, amountAtomic: distribution.workers ?? "0", shareOfFeeBps: FEE_SHARES_BPS.fee_workers },
    { role: "fee_treasury", wallet: distribution.feeTreasuryWallet ?? null, amountAtomic: distribution.treasury ?? "0", shareOfFeeBps: FEE_SHARES_BPS.fee_treasury },
    { role: "fee_stakers", wallet: distribution.feeStakerWallet ?? null, amountAtomic: distribution.stakers ?? "0", shareOfFeeBps: FEE_SHARES_BPS.fee_stakers },
    { role: "fee_burn", wallet: null, amountAtomic: distribution.burn ?? "0", shareOfFeeBps: FEE_SHARES_BPS.fee_burn },
  );
  return lines.filter((line) => BigInt(line.amountAtomic) > 0n);
}

function gasPayerAddress() {
  if (config.GUILDHALL_GAS_WALLET_PUBLIC_KEY) return config.GUILDHALL_GAS_WALLET_PUBLIC_KEY;
  try { return loadSolanaFeePayer().publicKey.toBase58(); }
  catch { return null; }
}

/** Canonical commission terms, their live hash, and the hash frozen when the client funded the escrow. */
export async function commissionTermsRecord(commissionId: string) {
  const result = await pool.query<{
    id: string; client_wallet: string; title: string; description: string; asset_mint: string; amount_atomic: string;
    work_category: string | null; sla_hours: number | null; requires_tribunal: boolean; deadline_at: Date;
    work_type: string; watch_terms: unknown;
    funding_signature: string | null; terms_hash: string | null; terms_hashed_at: Date | null; terms_anchored: boolean;
    cluster: string | null;
  }>(
    `SELECT c.id, c.client_wallet, c.title, c.description, c.asset_mint, c.amount_atomic::text, c.work_category,
            c.sla_hours, c.requires_tribunal, c.deadline_at, c.work_type, c.watch_terms, c.funding_signature, c.terms_hash, c.terms_hashed_at,
            c.terms_anchored, w.cluster
       FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id WHERE c.id = $1`, [commissionId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "commission_not_found", "Commission not found.");
  const currentHash = commissionTermsHash(row);
  return {
    document: commissionTermsDocument(row),
    algorithm: "sha256(JSON.stringify(document))",
    currentHash,
    frozenHash: row.terms_hash,
    frozenAt: row.terms_hashed_at,
    matchesFrozen: row.terms_hash ? row.terms_hash === currentHash : null,
    anchoredOnChain: row.terms_anchored,
    memo: row.terms_hash ? termsMemoText(row.terms_hash) : null,
    fundingTransaction: row.funding_signature
      ? { signature: row.funding_signature, url: explorerTransactionUrl(row.funding_signature, row.cluster ?? config.SOLANA_CLUSTER) }
      : null,
  };
}

/** Public proof receipt: every Solana transaction that moved or recorded this commission's funds. */
export async function commissionReceipt(commissionId: string) {
  const commission = await pool.query<{
    id: string; title: string; status: string; work_type: string; work_category: string | null;
    client_wallet: string; provider_wallet: string | null; asset_mint: string; amount_atomic: string;
    funding_signature: string | null; funded_at: Date | null; created_at: Date;
    escrow_address: string | null; escrow_cluster: string | null;
    provider_agent_id: string | null; provider_agent_name: string | null;
  }>(
    `SELECT c.id, c.title, c.status, c.work_type, c.work_category, c.client_wallet, c.provider_wallet,
            c.asset_mint, c.amount_atomic::text, c.funding_signature, c.funded_at, c.created_at,
            w.public_key AS escrow_address, w.cluster AS escrow_cluster,
            c.provider_agent_id, a.name AS provider_agent_name
       FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
       LEFT JOIN work_agents a ON a.id = c.provider_agent_id
      WHERE c.id = $1`, [commissionId],
  );
  const row = commission.rows[0];
  if (!row) throw new ApiError(404, "commission_not_found", "Commission not found.");
  if (!row.funding_signature) throw new ApiError(409, "receipt_not_available", "A receipt is available once the commission is funded on Solana.");
  const cluster = row.escrow_cluster ?? config.SOLANA_CLUSTER;

  const settlement = await pool.query<{
    id: string; operation: "release" | "refund" | "split"; state: string; transaction_signature: string | null;
    fee_atomic: string; distribution: Record<string, string>; updated_at: Date;
  }>(
    `SELECT id, operation, state, transaction_signature, fee_atomic::text, distribution, updated_at
       FROM commission_escrow_operations
      WHERE commission_id = $1 AND parent_operation_id IS NULL AND operation IN ('release', 'refund', 'split')
      ORDER BY (state = 'confirmed') DESC, created_at DESC LIMIT 1`, [commissionId],
  );
  const parent = settlement.rows[0];
  const settled = parent?.state === "confirmed" && ["complete", "refunded"].includes(row.status);
  const childTransfers = parent ? await pool.query<{ transaction_signature: string; destination: string; amount_atomic: string; distribution: Record<string, string> }>(
    `SELECT transaction_signature, destination, amount_atomic::text, distribution FROM commission_escrow_operations
      WHERE parent_operation_id = $1 AND state = 'confirmed' AND transaction_signature IS NOT NULL
      ORDER BY operation_index`, [parent.id],
  ) : { rows: [] };

  const workRecord = await pool.query<{
    id: string; outcome: string; paid_amount_atomic: string; finalized_at: Date;
    record_hash: string | null; memo_data: string | null; chain_state: string | null; chain_signature: string | null;
    integrity_flags: string[]; reputation_weight: number;
  }>(
    `SELECT wr.id, wr.outcome, wr.paid_amount_atomic::text, wr.finalized_at,
            chain.record_hash, chain.memo_data, chain.state AS chain_state, chain.transaction_signature AS chain_signature,
            integrity.flags AS integrity_flags, integrity.reputation_weight::float AS reputation_weight
       FROM work_records wr LEFT JOIN work_record_chain_operations chain ON chain.work_record_id = wr.id
       JOIN work_record_integrity_flags integrity ON integrity.work_record_id = wr.id
      WHERE wr.commission_id = $1`, [commissionId],
  );
  const record = workRecord.rows[0];

  const transactions: { kind: "funding" | "settlement" | "work_record"; signature: string; url: string; label: string }[] = [
    { kind: "funding", signature: row.funding_signature, url: explorerTransactionUrl(row.funding_signature, cluster), label: "Client funded the escrow" },
  ];
  if (settled && parent) {
    if (childTransfers.rows.length) {
      for (const child of childTransfers.rows) transactions.push({
        kind: "settlement", signature: child.transaction_signature, url: explorerTransactionUrl(child.transaction_signature, cluster),
        label: child.distribution.kind === "burn" ? "Fee burn" : `Payout to ${child.destination}`,
      });
    } else if (parent.transaction_signature) {
      transactions.push({
        kind: "settlement", signature: parent.transaction_signature, url: explorerTransactionUrl(parent.transaction_signature, cluster),
        label: parent.operation === "refund" ? "Escrow refunded the client" : "Escrow paid the provider and fee split",
      });
    }
  }
  if (record?.chain_state === "confirmed" && record.chain_signature) {
    transactions.push({ kind: "work_record", signature: record.chain_signature, url: explorerTransactionUrl(record.chain_signature, cluster), label: "Work record written on-chain" });
  }

  const gross = BigInt(row.amount_atomic);
  const fee = parent ? BigInt(parent.fee_atomic) : 0n;
  const gasPayer = gasPayerAddress();
  let recordPayload: Record<string, unknown> | null = null;
  let recordHashValid: boolean | null = null;
  if (record?.memo_data && record.record_hash) {
    try {
      const { h, ...payload } = JSON.parse(record.memo_data) as Record<string, unknown>;
      recordPayload = payload;
      recordHashValid = h === record.record_hash
        && createHash("sha256").update(JSON.stringify(payload)).digest("hex") === record.record_hash;
    } catch { recordHashValid = false; }
  }

  const terms = await commissionTermsRecord(commissionId);
  return {
    commissionId: row.id,
    title: row.title,
    status: row.status,
    workType: row.work_type,
    category: row.work_category ?? "general",
    cluster,
    settled,
    outcome: record?.outcome ?? (settled && parent?.operation === "refund" ? "refunded" : null),
    assetMint: row.asset_mint,
    grossAtomic: row.amount_atomic,
    feeAtomic: fee.toString(),
    feeBps: gross > 0n ? Number(fee * 10_000n / gross) : 0,
    createdAt: row.created_at,
    fundedAt: row.funded_at,
    settledAt: settled ? record?.finalized_at ?? parent!.updated_at : null,
    parties: {
      client: { wallet: row.client_wallet, url: explorerAccountUrl(row.client_wallet, cluster) },
      provider: row.provider_wallet ? { wallet: row.provider_wallet, url: explorerAccountUrl(row.provider_wallet, cluster),
        agentId: row.provider_agent_id, agentName: row.provider_agent_name } : null,
      escrow: row.escrow_address ? { wallet: row.escrow_address, url: explorerAccountUrl(row.escrow_address, cluster) } : null,
      gasPayer: gasPayer ? { wallet: gasPayer, url: explorerAccountUrl(gasPayer, cluster) } : null,
    },
    distribution: settled && parent
      ? settlementLines(parent.operation, row.amount_atomic, parent.distribution, { provider: row.provider_wallet, client: row.client_wallet })
      : [],
    transactions,
    terms: {
      hash: terms.frozenHash ?? terms.currentHash,
      frozenAtFunding: terms.frozenHash !== null,
      matchesFrozen: terms.matchesFrozen,
      anchoredOnChain: terms.anchoredOnChain,
      memo: terms.memo,
    },
    workRecord: record ? {
      id: record.id,
      outcome: record.outcome,
      paidAmountAtomic: record.paid_amount_atomic,
      recordHash: record.record_hash,
      recordHashValid,
      payload: recordPayload,
      chainState: record.chain_state,
      integrityFlags: record.integrity_flags,
      reputationWeight: record.reputation_weight,
    } : null,
  };
}
