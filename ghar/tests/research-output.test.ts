import { describe, expect, test } from "bun:test";
import { formatSourcedAnswer } from "../src/research-output";
import { isResearchCommission } from "../src/worker";

describe("Hall Scout research output", () => {
  test("keeps only known source links and removes duplicates", () => {
    const sources = [
      { title: "One", url: "https://one.example", content: "source" },
      { title: "Two", url: "https://two.example", content: "source" },
    ];
    const result = formatSourcedAnswer("A concise answer", [
      "https://one.example", "https://one.example", "https://unknown.example",
    ], sources);
    expect(result.citedUrls).toEqual(["https://one.example"]);
    expect(result.summary).toContain("https://one.example");
    expect(result.summary).not.toContain("https://unknown.example");
  });

  test("rejects answers that lack a valid citation", () => {
    expect(() => formatSourcedAnswer("Answer", ["https://unknown.example"], [])).toThrow("source-backed");
  });

  test("only selects the research category, case-insensitively", () => {
    expect(isResearchCommission({ category: "research" })).toBe(true);
    expect(isResearchCommission({ category: " Research " })).toBe(true);
    expect(isResearchCommission({ category: "development" })).toBe(false);
  });
});
