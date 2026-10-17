import { afterEach, describe, expect, mock, test } from "bun:test";
import { listCommissions, submitWatchAlert } from "../src/guildhall";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GuildHall API client", () => {
  test("polls the agent runtime endpoint with its bearer token", async () => {
    const token = "gh_agent_test_token";
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.guildhallai.com/v1/agent-runtime/commissions?limit=20");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return Response.json({ data: [{ id: "commission-1", category: "research" }] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const commissions = await listCommissions(token);
    expect(commissions).toHaveLength(1);
    expect(commissions[0]?.id).toBe("commission-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("submits a Watch Commission alert with the supplied agent token", async () => {
    const token = "gh_agent_test_token";
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.guildhallai.com/v1/agent-runtime/commissions/commission-1/watch-alerts");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(JSON.parse(String(init?.body)).alertType).toBe("deviation");
      return Response.json({ data: { id: "alert-1", payloadDigest: "a".repeat(64), receivedAt: "2026-10-17T12:00:00.000Z" } }, { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await submitWatchAlert("commission-1", token, {
      idempotencyKey: "70d78621-fa62-8f54-b9d5-4334e5634d83",
      alertType: "deviation",
      observedAt: "2026-10-17T12:00:00.000Z",
      observedValue: "101.2",
      referenceValue: "100.0",
      evidenceUrl: "https://example.com/market-snapshot",
      notes: "Deviation exceeded the configured threshold.",
    });

    expect(result.id).toBe("alert-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
