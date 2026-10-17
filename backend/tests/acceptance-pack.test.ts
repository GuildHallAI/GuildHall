import { describe, expect, it } from "bun:test";
import { acceptancePackHash, acceptancePackSchema, verifyAcceptancePack } from "../src/acceptance-pack.js";

const digest = "a".repeat(64);

describe("Proof Packs", () => {
  const pack = acceptancePackSchema.parse({
    settlement: "auto_release",
    checks: [
      { id: "result", label: "Names the finished result", type: "summary_includes", needle: "deployed" },
      { id: "live-url", label: "Provides a live URL", type: "https_url", evidenceLabel: "Live site" },
      { id: "build-hash", label: "Matches the approved build", type: "sha256_evidence", digest },
      { id: "tests", label: "Includes test evidence", type: "evidence_kind", kind: "text", minCount: 1 },
    ],
  });

  it("passes deterministic proof evidence and produces a stable terms hash", () => {
    const verification = verifyAcceptancePack(pack, {
      summary: "The app is deployed and ready.",
      evidence: [
        { kind: "url", label: "Live site", value: "https://example.com" },
        { kind: "hash", label: "Build SHA-256", value: digest },
        { kind: "text", label: "Tests", value: "42 passing" },
      ],
    });
    expect(verification.status).toBe("passed");
    expect(verification.results.every((result) => result.passed)).toBe(true);
    expect(acceptancePackHash(pack)).toBe(acceptancePackHash(acceptancePackSchema.parse(JSON.parse(JSON.stringify(pack)))));
  });

  it("holds a failing pack with actionable per-check results", () => {
    const verification = verifyAcceptancePack(pack, {
      summary: "Work is ready.",
      evidence: [{ kind: "url", label: "Live site", value: "http://example.com" }],
    });
    expect(verification.status).toBe("failed");
    expect(verification.results.filter((result) => !result.passed).map((result) => result.id)).toEqual(["result", "live-url", "build-hash", "tests"]);
  });
});
