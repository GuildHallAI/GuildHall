import {
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "./config.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ENCRYPTION_KEY_VERSION = 1;
const encryptionKey = createHash("sha256")
  .update("guildhall:commission-escrow-key:v1:")
  .update(config.DATA_ENCRYPTION_KEY)
  .digest();

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value /= 58n;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

function generateSolanaKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" });
  const publicBytes = publicDer.subarray(-32);
  const seed = privateDer.subarray(-32);

  return {
    address: encodeBase58(publicBytes),
    secretKey: Buffer.concat([seed, publicBytes]),
  };
}

function encryptSecret(secret: Uint8Array) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

export function createEncryptedSolanaWallet() {
  const wallet = generateSolanaKeypair();
  const encrypted = encryptSecret(wallet.secretKey);
  return {
    publicKey: wallet.address,
    encryptedSecretKey: encrypted.ciphertext,
    encryptionNonce: encrypted.nonce,
    encryptionAuthTag: encrypted.authTag,
    encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
  };
}

export function decryptCommissionSecretKey(input: {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
}): Uint8Array {
  if (input.keyVersion !== ENCRYPTION_KEY_VERSION) {
    throw new Error("Unsupported escrow encryption key version.");
  }
  if (input.authTag.byteLength !== 16) throw new Error("Invalid escrow authentication tag length.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, input.nonce, { authTagLength: 16 });
  decipher.setAuthTag(input.authTag);
  return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
}

export function decryptSolanaSecretKey(input: {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
}) {
  return decryptCommissionSecretKey(input);
}

/**
 * Call inside the same Postgres transaction that creates the commission row.
 * The caller must not return or log the encrypted secret material.
 */
export async function createCommissionEscrowWallet(
  client: PoolClient,
  commissionId: string,
): Promise<{ publicKey: string; created: boolean }> {
  const existing = await client.query<{ public_key: string }>(
    "SELECT public_key FROM commission_escrow_wallets WHERE commission_id = $1",
    [commissionId],
  );
  if (existing.rows[0]) return { publicKey: existing.rows[0].public_key, created: false };

  const wallet = createEncryptedSolanaWallet();
  const inserted = await client.query<{ public_key: string }>(
    `INSERT INTO commission_escrow_wallets
       (commission_id, public_key, encrypted_secret_key, encryption_nonce,
        encryption_auth_tag, encryption_key_version, cluster)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (commission_id) DO NOTHING
     RETURNING public_key`,
    [
      commissionId,
      wallet.publicKey,
      wallet.encryptedSecretKey,
      wallet.encryptionNonce,
      wallet.encryptionAuthTag,
      wallet.encryptionKeyVersion,
      config.SOLANA_CLUSTER,
    ],
  );

  if (inserted.rows[0]) return { publicKey: inserted.rows[0].public_key, created: true };

  const raced = await client.query<{ public_key: string }>(
    "SELECT public_key FROM commission_escrow_wallets WHERE commission_id = $1",
    [commissionId],
  );
  if (!raced.rows[0]) throw new Error("Could not create or load commission escrow wallet.");
  return { publicKey: raced.rows[0].public_key, created: false };
}

export async function loadCommissionEscrowSecretKey(
  client: PoolClient,
  commissionId: string,
): Promise<Uint8Array> {
  const result = await client.query<{
    encrypted_secret_key: Buffer;
    encryption_nonce: Buffer;
    encryption_auth_tag: Buffer;
    encryption_key_version: number;
  }>(
    `SELECT encrypted_secret_key, encryption_nonce, encryption_auth_tag, encryption_key_version
       FROM commission_escrow_wallets WHERE commission_id = $1`,
    [commissionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Commission escrow wallet not found.");
  return decryptCommissionSecretKey({
    ciphertext: row.encrypted_secret_key,
    nonce: row.encryption_nonce,
    authTag: row.encryption_auth_tag,
    keyVersion: row.encryption_key_version,
  });
}
