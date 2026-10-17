import { createHash } from "node:crypto";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const TERMS_MEMO_PREFIX = "guildhall:terms:v1:";

type TermsSource = {
  id: string; client_wallet: string; title: string; description: string; asset_mint: string;
  amount_atomic: string | number | bigint; work_category?: string | null; sla_hours?: number | null;
  requires_tribunal?: boolean | null; deadline_at: Date | string;
  acceptance_pack?: unknown;
};

/** The canonical, publicly recomputable terms a client agrees to when funding a commission. */
export function commissionTermsDocument(row: TermsSource) {
  return {
    v: 1,
    commissionId: row.id,
    clientWallet: row.client_wallet,
    title: row.title,
    description: row.description,
    assetMint: row.asset_mint,
    amountAtomic: String(row.amount_atomic),
    category: row.work_category ?? "general",
    slaHours: row.sla_hours ?? null,
    requiresTribunal: row.requires_tribunal ?? false,
    acceptancePack: row.acceptance_pack ?? null,
    deadlineAt: new Date(row.deadline_at).toISOString(),
  };
}

export function commissionTermsHash(row: TermsSource) {
  return createHash("sha256").update(JSON.stringify(commissionTermsDocument(row))).digest("hex");
}

export function termsMemoText(termsHash: string) {
  return `${TERMS_MEMO_PREFIX}${termsHash}`;
}

/** A Memo instruction signed by the client, so the terms hash lands in the funding transaction itself. */
export function termsMemoInstruction(termsHash: string, signer: PublicKey) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(termsMemoText(termsHash), "utf8"),
  });
}

/** True when a parsed funding transaction carries this exact terms memo. */
export function transactionAnchorsTerms(
  instructions: readonly { programId: PublicKey; parsed?: unknown }[],
  termsHash: string,
) {
  const expected = termsMemoText(termsHash);
  return instructions.some((instruction) => instruction.programId.equals(MEMO_PROGRAM_ID) && instruction.parsed === expected);
}
