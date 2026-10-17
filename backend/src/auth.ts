import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { ApiError } from "./http.js";

const SESSION_DAYS = 7;
const NONCE_MINUTES = 10;

function canonicalWallet(value: string) {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new ApiError(400, "invalid_wallet", "A valid Solana wallet address is required.");
  }
}

const hashSessionToken = (token: string) =>
  createHash("sha256")
    .update(config.AUTH_TOKEN_PEPPER || config.DATA_ENCRYPTION_KEY)
    .update(":")
    .update(token)
    .digest("hex");

// SIWS accepts "mainnet", whereas Solana RPC configuration calls it
// "mainnet-beta". Sending the RPC name makes Phantom reject the entire prompt.
const siwsChainId = (cluster: typeof config.SOLANA_CLUSTER) => cluster === "mainnet-beta" ? "mainnet" : cluster;

const messageFor = (wallet: string, nonce: string, issuedAt: Date, expiresAt: Date) =>
  `${config.AUTH_DOMAIN} wants you to sign in with your Solana account:\n${wallet}\n\nSign in to GuildHall.\n\nURI: ${config.AUTH_URI}\nVersion: 1\nChain ID: ${siwsChainId(config.SOLANA_CLUSTER)}\nNonce: ${nonce}\nIssued At: ${issuedAt.toISOString()}\nExpiration Time: ${expiresAt.toISOString()}`;

const nonceInput = z.object({ walletAddress: z.string().min(32).max(44) });
const verifyInput = z.object({
  walletAddress: z.string().min(32).max(44),
  nonce: z.string().regex(/^[a-f0-9]{48}$/),
  signature: z.string().min(80).max(100),
});

export async function issueWalletNonce(input: unknown) {
  const { walletAddress: value } = nonceInput.parse(input);
  const walletAddress = canonicalWallet(value);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [walletAddress]);
    await client.query("DELETE FROM auth_nonces WHERE expires_at < now() - interval '1 day'");
    const existing = await client.query<{ nonce: string; issued_at: Date; expires_at: Date }>(
      `SELECT nonce, issued_at, expires_at FROM auth_nonces
        WHERE wallet_address = $1 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY issued_at DESC LIMIT 1`, [walletAddress],
    );
    const challenge = existing.rows[0];
    if (challenge) {
      await client.query("COMMIT");
      return {
        walletAddress,
        nonce: challenge.nonce,
        message: messageFor(walletAddress, challenge.nonce, challenge.issued_at, challenge.expires_at),
        expiresAt: challenge.expires_at,
      };
    }

    const nonce = randomBytes(24).toString("hex");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + NONCE_MINUTES * 60_000);
    await client.query(
      "INSERT INTO auth_nonces (nonce, wallet_address, issued_at, expires_at) VALUES ($1, $2, $3, $4)",
      [nonce, walletAddress, issuedAt, expiresAt],
    );
    await client.query("COMMIT");
    return {
      walletAddress,
      nonce,
      message: messageFor(walletAddress, nonce, issuedAt, expiresAt),
      expiresAt,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createWalletSession(input: unknown) {
  const parsed = verifyInput.parse(input);
  const walletAddress = canonicalWallet(parsed.walletAddress);
  let signature: Uint8Array;
  try {
    signature = bs58.decode(parsed.signature);
  } catch {
    throw new ApiError(400, "invalid_signature_encoding", "Signature must be base58 encoded.");
  }
  if (signature.length !== nacl.sign.signatureLength) {
    throw new ApiError(400, "invalid_signature_encoding", "Signature has an invalid length.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const nonceResult = await client.query<{ issued_at: Date; expires_at: Date }>(
      `SELECT issued_at, expires_at FROM auth_nonces
       WHERE wallet_address = $1 AND nonce = $2 AND consumed_at IS NULL FOR UPDATE`,
      [walletAddress, parsed.nonce],
    );
    const challenge = nonceResult.rows[0];
    if (!challenge || challenge.expires_at <= new Date()) {
      throw new ApiError(401, "invalid_nonce", "This sign-in request expired. Request a new nonce.");
    }

    const message = messageFor(walletAddress, parsed.nonce, challenge.issued_at, challenge.expires_at);
    const valid = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      signature,
      new PublicKey(walletAddress).toBytes(),
    );
    if (!valid) throw new ApiError(401, "invalid_signature", "The signature does not match this wallet.");

    await client.query(
      "UPDATE auth_nonces SET consumed_at = now() WHERE nonce = $1 AND consumed_at IS NULL",
      [parsed.nonce],
    );
    const user = await client.query<{ id: string }>(
      `INSERT INTO wallet_users (wallet_address) VALUES ($1)
       ON CONFLICT (wallet_address) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [walletAddress],
    );
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await client.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
      [hashSessionToken(token), user.rows[0].id, expiresAt],
    );
    await client.query("COMMIT");
    return { token, expiresAt, userId: user.rows[0].id, walletAddress };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveWalletSession(token: string) {
  const result = await pool.query<{ user_id: string; wallet_address: string }>(
    `SELECT s.user_id, u.wallet_address
       FROM sessions s JOIN wallet_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashSessionToken(token)],
  );
  return result.rows[0]
    ? { userId: result.rows[0].user_id, walletAddress: result.rows[0].wallet_address }
    : null;
}

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; walletAddress: string };
    }
  }
}

export async function requireAuth(request: Request, _response: Response, next: NextFunction) {
  try {
    const bearer = request.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) throw new ApiError(401, "unauthenticated", "A bearer session token is required.");
    const session = await resolveWalletSession(bearer);
    if (!session) throw new ApiError(401, "invalid_session", "This session is invalid or expired.");
    request.auth = session;
    next();
  } catch (error) {
    next(error);
  }
}

export async function revokeWalletSession(request: Request) {
  const bearer = request.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return;
  await pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [
    hashSessionToken(bearer),
  ]);
}
