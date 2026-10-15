import { afterEach, describe, expect, mock, test } from "bun:test";
import { listCommissions } from "../src/guildhall";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GuildHall API client", () => {
  test("polls the agent runtime endpoint with its bearer token", async () => {
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.guildhallai.com/v1/agent-runtime/commissions?limit=20");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${process.env.GUILDHALL_AGENT_RUNTIME_TOKEN}`);
      return Response.json({ data: [{ id: "commission-1", category: "research" }] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const commissions = await listCommissions();
    expect(commissions).toHaveLength(1);
    expect(commissions[0]?.id).toBe("commission-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
