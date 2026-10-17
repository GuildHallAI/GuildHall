import { createHash } from "node:crypto";
import { z } from "zod";

const checkId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const checkBase = z.object({ id: checkId, label: z.string().trim().min(1).max(160) });

const summaryIncludes = checkBase.extend({ type: z.literal("summary_includes"), needle: z.string().trim().min(1).max(500) });
const evidenceKind = checkBase.extend({ type: z.literal("evidence_kind"), kind: z.enum(["url", "text", "hash", "image", "photo", "timestamp", "location_cell", "checklist"]), minCount: z.number().int().min(1).max(50).default(1) });
const evidenceLabel = checkBase.extend({ type: z.literal("evidence_label"), evidenceLabel: z.string().trim().min(1).max(160) });
const evidenceValue = checkBase.extend({ type: z.literal("evidence_value_equals"), evidenceLabel: z.string().trim().min(1).max(160), value: z.string().trim().min(1).max(4_000) });
const httpsUrl = checkBase.extend({ type: z.literal("https_url"), evidenceLabel: z.string().trim().min(1).max(160).optional() });
const sha256Evidence = checkBase.extend({ type: z.literal("sha256_evidence"), digest: z.string().regex(/^[a-f0-9]{64}$/i) });

export const acceptancePackSchema = z.object({
  version: z.literal(1).default(1),
  settlement: z.enum(["manual_review", "auto_release"]).default("manual_review"),
  checks: z.array(z.discriminatedUnion("type", [summaryIncludes, evidenceKind, evidenceLabel, evidenceValue, httpsUrl, sha256Evidence])).min(1).max(20),
}).superRefine((pack, context) => {
  const ids = new Set<string>();
  for (const check of pack.checks) {
    if (ids.has(check.id)) context.addIssue({ code: "custom", path: ["checks"], message: "Acceptance-check IDs must be unique." });
    ids.add(check.id);
  }
});

export type AcceptancePack = z.infer<typeof acceptancePackSchema>;
type Evidence = { kind: "url" | "text" | "hash" | "image" | "photo" | "timestamp" | "location_cell" | "checklist"; label: string; value: string };

export type AcceptanceCheckResult = { id: string; label: string; type: AcceptancePack["checks"][number]["type"]; passed: boolean; detail: string };

function sameLabel(item: Evidence, label: string) { return item.label.trim().toLocaleLowerCase() === label.trim().toLocaleLowerCase(); }

/** Evaluate only deterministic, bounded comparisons against a submitted proof bundle. */
export function verifyAcceptancePack(pack: AcceptancePack, submission: { summary: string; evidence: Evidence[] }) {
  const results: AcceptanceCheckResult[] = pack.checks.map((check) => {
    switch (check.type) {
      case "summary_includes": {
        const passed = submission.summary.toLocaleLowerCase().includes(check.needle.toLocaleLowerCase());
        return { id: check.id, label: check.label, type: check.type, passed, detail: passed ? "Required summary text found." : "Required summary text was not found." };
      }
      case "evidence_kind": {
        const found = submission.evidence.filter((item) => item.kind === check.kind).length;
        const passed = found >= check.minCount;
        return { id: check.id, label: check.label, type: check.type, passed, detail: `${found}/${check.minCount} required ${check.kind} evidence item(s) found.` };
      }
      case "evidence_label": {
        const passed = submission.evidence.some((item) => sameLabel(item, check.evidenceLabel));
        return { id: check.id, label: check.label, type: check.type, passed, detail: passed ? "Required evidence label found." : "Required evidence label was not found." };
      }
      case "evidence_value_equals": {
        const passed = submission.evidence.some((item) => sameLabel(item, check.evidenceLabel) && item.value === check.value);
        return { id: check.id, label: check.label, type: check.type, passed, detail: passed ? "Evidence value matches." : "Evidence value does not match." };
      }
      case "https_url": {
        const candidates = submission.evidence.filter((item) => item.kind === "url" && (!check.evidenceLabel || sameLabel(item, check.evidenceLabel)));
        const passed = candidates.some((item) => { try { return new URL(item.value).protocol === "https:"; } catch { return false; } });
        return { id: check.id, label: check.label, type: check.type, passed, detail: passed ? "HTTPS URL found." : "No valid HTTPS URL found." };
      }
      case "sha256_evidence": {
        const passed = submission.evidence.some((item) => item.kind === "hash" && item.value.toLocaleLowerCase() === check.digest.toLocaleLowerCase());
        return { id: check.id, label: check.label, type: check.type, passed, detail: passed ? "Expected SHA-256 evidence found." : "Expected SHA-256 evidence was not found." };
      }
    }
  });
  return { status: results.every((result) => result.passed) ? "passed" as const : "failed" as const, results };
}

export function acceptancePackHash(pack: AcceptancePack) {
  return createHash("sha256").update(JSON.stringify(pack)).digest("hex");
}
