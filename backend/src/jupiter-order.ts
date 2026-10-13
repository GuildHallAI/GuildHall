import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

export type JupiterSwapOrder = {
  transaction?: string | null;
  requestId?: string;
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  router?: string;
  taker?: string | null;
  signatureFeePayer?: string | null;
  transactionVersion?: number;
  lastValidBlockHeight?: string | number;
};

const MAX_DATABASE_BIGINT = 9_223_372_036_854_775_807n;

export function validateJupiterSwapOrder(
  order: JupiterSwapOrder,
  expected: {
    inputMint: PublicKey;
    outputMint: PublicKey;
    inputAmountAtomic: string;
    taker: Keypair;
    payer: Keypair;
  },
) {
  const lastValidBlockHeight = typeof order.lastValidBlockHeight === "number"
    ? (Number.isSafeInteger(order.lastValidBlockHeight) ? String(order.lastValidBlockHeight) : "")
    : order.lastValidBlockHeight ?? "";
  const outputAmount = order.outAmount ?? "";
  const minimumOutput = order.otherAmountThreshold ?? "";
  if (!order.transaction || !order.requestId || order.router !== "metis"
    || order.inputMint !== expected.inputMint.toBase58()
    || order.outputMint !== expected.outputMint.toBase58()
    || order.inAmount !== expected.inputAmountAtomic
    || !/^\d+$/.test(outputAmount) || BigInt(outputAmount) <= 0n
    || !/^\d+$/.test(minimumOutput) || BigInt(minimumOutput) <= 0n || BigInt(minimumOutput) > BigInt(outputAmount)
    || order.taker !== expected.taker.publicKey.toBase58()
    || order.signatureFeePayer !== expected.payer.publicKey.toBase58()
    || order.transactionVersion !== 0
    || !/^\d+$/.test(lastValidBlockHeight) || BigInt(lastValidBlockHeight) <= 0n
    || BigInt(lastValidBlockHeight) > MAX_DATABASE_BIGINT
    || expected.taker.publicKey.equals(expected.payer.publicKey)) {
    throw new Error("Jupiter returned an order outside the requested Metis swap policy.");
  }

  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  } catch {
    throw new Error("Jupiter returned an invalid serialized swap transaction.");
  }
  const requiredSigners = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  if (requiredSigners.length !== 2
    || !requiredSigners[0]?.equals(expected.payer.publicKey)
    || !requiredSigners[1]?.equals(expected.taker.publicKey)) {
    throw new Error("Jupiter swap transaction must require only the configured payer and funded account signatures.");
  }
  return { transaction, lastValidBlockHeight, outputAmount, requestId: order.requestId, router: order.router };
}
