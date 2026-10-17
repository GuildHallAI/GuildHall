import { createHash } from "node:crypto";
import { z } from "zod";

const positiveMetric = z.number().finite().positive();
export const watchTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("deviation"), thresholdPercent: positiveMetric.max(1000), persistenceSeconds: z.number().int().min(1).max(20) }),
  z.object({ type: z.literal("thin_ref"), minimumDepthUsd: positiveMetric.max(1_000_000_000), minimumOpenInterestUsd: positiveMetric.max(1_000_000_000_000) }),
  z.object({ type: z.literal("stale"), staleMinutes: z.number().int().min(1).max(1440), referenceMovePercent: positiveMetric.max(1000) }),
  z.object({ type: z.literal("funding_spike"), baselineMultiplier: z.number().finite().min(1).max(100) }),
]);

export const watchTermsSchema = z.object({
  venue: z.string().trim().min(2).max(80),
  market: z.string().trim().min(1).max(80),
  monitoringHours: z.number().int().min(1).max(720),
  trigger: watchTriggerSchema,
});

export const watchAlertSchema = z.object({
  idempotencyKey: z.string().uuid(),
  alertType: z.enum(["deviation", "thin_ref", "stale", "funding_spike"]),
  observedAt: z.string().datetime({ offset: true }),
  observedValue: z.string().trim().min(1).max(100),
  referenceValue: z.string().trim().min(1).max(100),
  evidenceUrl: z.string().url().max(2000).refine((value) => value.startsWith("https://"), "Evidence must use HTTPS."),
  notes: z.string().trim().min(1).max(2000),
});

export function watchAlertDigest(value: z.infer<typeof watchAlertSchema>) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type WatchTerms = z.infer<typeof watchTermsSchema>;
