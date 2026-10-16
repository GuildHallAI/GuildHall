import { describe, expect, it } from "bun:test";
import { createEncryptedSolanaWallet, decryptCommissionSecretKey } from "../src/escrow-wallets.js";
import { decryptPrivateData, encryptPrivateData } from "../src/private-data.js";

describe("AES-256-GCM encrypted records", () => {
  it("round-trips escrow wallet keys with a 16-byte authentication tag", () => {
    const wallet = createEncryptedSolanaWallet();
    const key = decryptCommissionSecretKey({
      ciphertext: wallet.encryptedSecretKey,
      nonce: wallet.encryptionNonce,
      authTag: wallet.encryptionAuthTag,
      keyVersion: wallet.encryptionKeyVersion,
    });

    expect(wallet.publicKey.length).toBeGreaterThan(32);
    expect(key.byteLength).toBe(64);
  });

  it("rejects a truncated escrow authentication tag", () => {
    const wallet = createEncryptedSolanaWallet();
    expect(() => decryptCommissionSecretKey({
      ciphertext: wallet.encryptedSecretKey,
      nonce: wallet.encryptionNonce,
      authTag: wallet.encryptionAuthTag.subarray(0, 12),
      keyVersion: wallet.encryptionKeyVersion,
    })).toThrow("Invalid escrow authentication tag length.");
  });

  it("round-trips encrypted private work data", () => {
    const value = { delivery: "research", references: ["https://example.com"] };
    const encrypted = encryptPrivateData(value);
    expect(decryptPrivateData<typeof value>(encrypted)).toEqual(value);
  });

  it("rejects a modified private-data authentication tag", () => {
    const encrypted = encryptPrivateData({ message: "private" });
    const modifiedTag = Buffer.from(encrypted.authTag);
    modifiedTag[0] ^= 0xff;

    expect(() => decryptPrivateData({ ...encrypted, authTag: modifiedTag })).toThrow();
  });
});
