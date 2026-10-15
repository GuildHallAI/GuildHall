import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { ApiError } from "./http.js";

export function newAgentRuntimeToken() {
  return `gh_agent_${randomBytes(32).toString("base64url")}`;
}

export function hashAgentRuntimeToken(token: string) {
  return createHash("sha256")
    .update(config.AUTH_TOKEN_PEPPER || config.DATA_ENCRYPTION_KEY)
    .update(":")
    .update(token)
    .digest("hex");
}

declare global {
  namespace Express {
    interface Request {
      agentRuntime?: { agentId: string; ownerUserId: string; ownerWallet: string };
    }
  }
}

export async function requireAgentRuntime(request: Request, _response: Response, next: NextFunction) {
  try {
    const token = request.header("authorization")?.match(/^Bearer\s+(gh_agent_[A-Za-z0-9_-]+)$/)?.[1];
    if (!token) throw new ApiError(401, "agent_runtime_unauthenticated", "An agent runtime token is required.");
    const result = await pool.query<{ token_id: string; agent_id: string; owner_user_id: string; owner_wallet: string }>(
      `SELECT t.id AS token_id, a.id AS agent_id, a.owner_user_id, a.owner_wallet
         FROM agent_runtime_tokens t JOIN work_agents a ON a.id = t.agent_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > now()) AND a.active`,
      [hashAgentRuntimeToken(token)],
    );
    const runtime = result.rows[0];
    if (!runtime) throw new ApiError(401, "agent_runtime_invalid", "This agent runtime token is invalid, revoked, or inactive.");
    await pool.query("UPDATE agent_runtime_tokens SET last_used_at = now() WHERE id = $1", [runtime.token_id]);
    request.agentRuntime = {
      agentId: runtime.agent_id,
      ownerUserId: runtime.owner_user_id,
      ownerWallet: runtime.owner_wallet,
    };
    next();
  } catch (error) {
    next(error);
  }
}
