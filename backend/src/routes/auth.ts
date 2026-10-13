import { Router } from "express";
import { createWalletSession, issueWalletNonce, requireAuth, revokeWalletSession } from "../auth.js";

export const authRouter = Router();

authRouter.post("/nonce", async (request, response) => {
  response.status(201).json({ data: await issueWalletNonce(request.body) });
});

authRouter.post("/verify", async (request, response) => {
  response.status(201).json({ data: await createWalletSession(request.body) });
});

authRouter.get("/me", requireAuth, (request, response) => {
  response.json({ data: request.auth });
});

authRouter.delete("/session", requireAuth, async (request, response) => {
  await revokeWalletSession(request);
  response.status(204).end();
});
