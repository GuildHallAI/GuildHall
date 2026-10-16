import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Keypair, Transaction } from "@solana/web3.js";
import request from "supertest";
import { app, markStartupReady } from "../src/app.js";
import {
  commissionTermsDocument, commissionTermsHash, MEMO_PROGRAM_ID, termsMemoInstruction, termsMemoText, transactionAnchorsTerms,
} from "../src/commission-terms.js";
import { pool } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

const clientWallet = Keypair.generate().publicKey;
const terms = {
  id: "8f6b9c7e-1d2a-4b3c-9d8e-7f6a5b4c3d2e", client_wallet: clientWallet.toBase58(), title: "Audit the escrow",
  description: "Review the settlement path.", asset_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount_atomic: "5000000", work_category: "security", sla_hours: 48, requires_tribunal: true,
  deadline_at: new Date("2026-11-01T12:00:00.000Z"),
};
let userId = "";
let commissionId = "";

beforeAll(async () => {
  await migrate();
  markStartupReady();
  const user = await pool.query<{ id: string }>("INSERT INTO wallet_users (wallet_address) VALUES ($1) RETURNING id", [clientWallet.toBase58()]);
  userId = user.rows[0]!.id;
  const commission = await pool.query<{ id: string }>(
    `INSERT INTO commissions (client_user_id, client_wallet, title, description, asset_mint, amount_atomic, status, deadline_at,
       work_category, sla_hours, requires_tribunal, funding_signature, funded_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'funded', $7, $8, $9, $10, $11, now()) RETURNING id`,
    [userId, terms.client_wallet, terms.title, terms.description, terms.asset_mint, terms.amount_atomic, terms.deadline_at,
      terms.work_category, terms.sla_hours, terms.requires_tribunal, `terms-${crypto.randomUUID()}`],
  );
  commissionId = commission.rows[0]!.id;
});

afterAll(async () => {
  await pool.query("DELETE FROM commissions WHERE id = $1", [commissionId]);
  await pool.query("DELETE FROM wallet_users WHERE id = $1", [userId]);
});

describe("commission terms hash", () => {
  it("is a stable SHA-256 of the canonical terms document", () => {
    const document = commissionTermsDocument(terms);
    expect(document.amountAtomic).toBe("5000000");
    expect(document.deadlineAt).toBe("2026-11-01T12:00:00.000Z");
    expect(commissionTermsHash(terms)).toBe(createHash("sha256").update(JSON.stringify(document)).digest("hex"));
    expect(commissionTermsHash({ ...terms, deadline_at: "2026-11-01T12:00:00Z", amount_atomic: 5_000_000n })).toBe(commissionTermsHash(terms));
    expect(commissionTermsHash({ ...terms, description: "Review the settlement path!" })).not.toBe(commissionTermsHash(terms));
  });

  it("puts a client-signed memo into the funding transaction", () => {
    const hash = commissionTermsHash(terms);
    const instruction = termsMemoInstruction(hash, clientWallet);
    expect(instruction.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(instruction.keys).toEqual([{ pubkey: clientWallet, isSigner: true, isWritable: false }]);
    const transaction = new Transaction({ feePayer: clientWallet, recentBlockhash: "11111111111111111111111111111111" }).add(instruction);
    const decoded = Transaction.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }));
    expect(Buffer.from(decoded.instructions[0]!.data).toString("utf8")).toBe(`guildhall:terms:v1:${hash}`);
  });

  it("only treats the exact memo as an anchor", () => {
    const hash = commissionTermsHash(terms);
    expect(transactionAnchorsTerms([{ programId: MEMO_PROGRAM_ID, parsed: termsMemoText(hash) }], hash)).toBe(true);
    expect(transactionAnchorsTerms([{ programId: MEMO_PROGRAM_ID, parsed: termsMemoText("0".repeat(64)) }], hash)).toBe(false);
    expect(transactionAnchorsTerms([{ programId: clientWallet, parsed: termsMemoText(hash) }], hash)).toBe(false);
  });
});

describe("GET /v1/commissions/:id/terms", () => {
  it("lets anyone recompute the hash and detects later edits", async () => {
    const before = (await request(app).get(`/v1/commissions/${commissionId}/terms`).expect(200)).body.data;
    expect(before.frozenHash).toBeNull();
    expect(createHash("sha256").update(JSON.stringify(before.document)).digest("hex")).toBe(before.currentHash);

    await pool.query("UPDATE commissions SET terms_hash = $2, terms_hashed_at = now(), terms_anchored = true WHERE id = $1", [commissionId, before.currentHash]);
    const frozen = (await request(app).get(`/v1/commissions/${commissionId}/terms`).expect(200)).body.data;
    expect(frozen.matchesFrozen).toBe(true);
    expect(frozen.anchoredOnChain).toBe(true);
    expect(frozen.memo).toBe(`guildhall:terms:v1:${before.currentHash}`);

    await pool.query("UPDATE commissions SET description = 'Moved goalposts.' WHERE id = $1", [commissionId]);
    const edited = (await request(app).get(`/v1/commissions/${commissionId}/terms`).expect(200)).body.data;
    expect(edited.matchesFrozen).toBe(false);
    expect(edited.frozenHash).toBe(before.currentHash);
  });
});
