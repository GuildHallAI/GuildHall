import { describe, expect, it } from "bun:test";
import request from "supertest";
import { app } from "../src/app.js";

describe("GET /health", () => {
  it("returns service status, timestamp, and version", async () => {
    const response = await request(app).get("/health").expect(200);

    expect(response.body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
    expect(response.body.version).toBe("0.1.0");
  });
});
