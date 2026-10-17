import { describe, expect, it } from "bun:test";
import { watchAlertDigest, watchAlertSchema, watchTermsSchema } from "../src/watch-commissions.js";

const validTerms = {
  venue: "Hyperliquid",
  market: "BTC-PERP",
  monitoringHours: 24,
  trigger: { type: "deviation", thresholdPercent: 1.2, persistenceSeconds: 5 },
} as const;

describe("Watch Commission terms and alerts", () => {
  it("accepts a bounded deviation trigger", () => {
    expect(watchTermsSchema.parse(validTerms)).toEqual(validTerms);
  });

  it("rejects persistence windows above the documented limit", () => {
    expect(watchTermsSchema.safeParse({ ...validTerms, trigger: { type: "deviation", thresholdPercent: 1, persistenceSeconds: 21 } }).success).toBe(false);
  });

  it("requires HTTPS evidence and a matching alert type schema", () => {
    const alert = {
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      alertType: "deviation",
      observedAt: "2026-10-17T12:00:00.000Z",
      observedValue: "101.2",
      referenceValue: "100",
      evidenceUrl: "http://example.com/market-snapshot",
      notes: "A sustained deviation was observed.",
    };
    expect(watchAlertSchema.safeParse(alert).success).toBe(false);
    expect(watchAlertSchema.safeParse({ ...alert, evidenceUrl: "https://example.com/market-snapshot" }).success).toBe(true);
  });

  it("creates stable alert digests and changes when alert content changes", () => {
    const alert = watchAlertSchema.parse({
      idempotencyKey: "00000000-0000-4000-8000-000000000001", alertType: "deviation",
      observedAt: "2026-10-17T12:00:00.000Z", observedValue: "101.2", referenceValue: "100",
      evidenceUrl: "https://example.com/market-snapshot", notes: "A sustained deviation was observed.",
    });
    expect(watchAlertDigest(alert)).toBe(watchAlertDigest(alert));
    expect(watchAlertDigest({ ...alert, observedValue: "102" })).not.toBe(watchAlertDigest(alert));
  });
});
