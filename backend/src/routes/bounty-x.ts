import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { ApiError } from "../http.js";
import { decryptPrivateData, encryptPrivateData } from "../private-data.js";

export const bountyXRouter = Router();

function oauthConfig() {
  if (!config.X_CLIENT_ID || !config.X_OAUTH_REDIRECT_URI) {
    throw new ApiError(503, "x_oauth_unavailable", "X account linking is not configured.");
  }
  return { clientId: config.X_CLIENT_ID, redirectUri: config.X_OAUTH_REDIRECT_URI };
}

function frontendResult(result: "linked" | "denied" | "failed" | "conflict") {
  const url = new URL("/settings/integrations", config.AUTH_URI);
  url.searchParams.set("x", result);
  return url.toString();
}

bountyXRouter.post("/account/link", requireAuth, async (request, response) => {
  const oauth = oauthConfig();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const encrypted = encryptPrivateData({ verifier });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`x-oauth:${request.auth!.userId}`]);
    await client.query("DELETE FROM x_oauth_states WHERE expires_at <= now()");
    const active = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM x_oauth_states WHERE user_id = $1 AND expires_at > now()",
      [request.auth!.userId],
    );
    if (Number(active.rows[0].count) >= 5) {
      throw new ApiError(429, "x_link_rate_limited", "Too many X linking requests are active. Wait for one to expire and try again.");
    }
    await client.query(
      `INSERT INTO x_oauth_states
       (state_hash, user_id, encrypted_verifier, verifier_nonce, verifier_auth_tag, verifier_key_version, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')`,
      [createHash("sha256").update(state).digest(), request.auth!.userId,
        encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }

  const authorizeUrl = new URL("https://x.com/i/oauth2/authorize");
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    scope: "users.read",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  response.json({ data: { authorizeUrl: authorizeUrl.toString(), expiresInSeconds: 600 } });
});

bountyXRouter.get("/account", requireAuth, async (request, response) => {
  const linked = await pool.query<{ x_user_id: string; username: string; linked_at: Date }>(
    "SELECT x_user_id, username, linked_at FROM x_user_links WHERE user_id = $1", [request.auth!.userId],
  );
  response.json({ data: linked.rows[0] ?? null });
});

bountyXRouter.delete("/account", requireAuth, async (request, response) => {
  await pool.query("DELETE FROM x_user_links WHERE user_id = $1", [request.auth!.userId]);
  response.status(204).end();
});

bountyXRouter.get("/account/callback", async (request, response) => {
  const callback = z.object({
    state: z.string().min(40).max(100),
    code: z.string().min(1).max(2048).optional(),
    error: z.string().max(100).optional(),
  }).safeParse(request.query);
  if (!callback.success) { response.redirect(303, frontendResult("failed")); return; }
  if (callback.data.error || !callback.data.code) { response.redirect(303, frontendResult("denied")); return; }

  const oauth = oauthConfig();
  const stateHash = createHash("sha256").update(callback.data.state).digest();
  const client = await pool.connect();
  let userId: string;
  let verifier: string;
  try {
    await client.query("BEGIN");
    const found = await client.query<{
      user_id: string; encrypted_verifier: Buffer; verifier_nonce: Buffer;
      verifier_auth_tag: Buffer; verifier_key_version: number;
    }>(
      `SELECT user_id, encrypted_verifier, verifier_nonce, verifier_auth_tag, verifier_key_version
         FROM x_oauth_states WHERE state_hash = $1 AND expires_at > now() FOR UPDATE`, [stateHash],
    );
    if (!found.rows[0]) throw new ApiError(400, "x_oauth_state_invalid", "The X linking request expired or was already used.");
    userId = found.rows[0].user_id;
    verifier = decryptPrivateData<{ verifier: string }>({
      ciphertext: found.rows[0].encrypted_verifier, nonce: found.rows[0].verifier_nonce,
      authTag: found.rows[0].verifier_auth_tag, keyVersion: found.rows[0].verifier_key_version,
    }).verifier;
    await client.query("DELETE FROM x_oauth_states WHERE state_hash = $1", [stateHash]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof ApiError) { response.redirect(303, frontendResult("failed")); return; }
    throw error;
  } finally { client.release(); }

  try {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.data.code,
      redirect_uri: oauth.redirectUri,
      code_verifier: verifier,
    });
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    if (config.X_CLIENT_SECRET) {
      headers.set("authorization", `Basic ${Buffer.from(`${oauth.clientId}:${config.X_CLIENT_SECRET}`).toString("base64")}`);
    } else {
      form.set("client_id", oauth.clientId);
    }
    const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST", headers, body: form, signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) { response.redirect(303, frontendResult("failed")); return; }
    const token = z.object({ access_token: z.string().min(1) }).parse(await tokenResponse.json());
    const meResponse = await fetch("https://api.x.com/2/users/me?user.fields=username", {
      headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!meResponse.ok) { response.redirect(303, frontendResult("failed")); return; }
    const me = z.object({ data: z.object({ id: z.string().regex(/^\d{1,30}$/), username: z.string().min(1).max(50) }) })
      .parse(await meResponse.json()).data;
    await pool.query(
      `INSERT INTO x_user_links (user_id, x_user_id, username)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET x_user_id = EXCLUDED.x_user_id,
         username = EXCLUDED.username, linked_at = now()`,
      [userId, me.id, me.username],
    );
    response.redirect(303, frontendResult("linked"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      response.redirect(303, frontendResult("conflict"));
      return;
    }
    response.redirect(303, frontendResult("failed"));
  }
});
