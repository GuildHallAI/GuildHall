import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";

const key = createHash("sha256")
  .update("guildhall:private-work-data:v1:")
  .update(config.DATA_ENCRYPTION_KEY)
  .digest();

export function encryptPrivateData(value: unknown) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: 1 };
}

export function decryptPrivateData<T>(input: {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
}): T {
  if (input.keyVersion !== 1) throw new Error("Unsupported private data encryption key version.");
  if (input.authTag.byteLength !== 16) throw new Error("Invalid private-data authentication tag length.");
  const decipher = createDecipheriv("aes-256-gcm", key, input.nonce, { authTagLength: 16 });
  decipher.setAuthTag(input.authTag);
  const plaintext = Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as T;
}
