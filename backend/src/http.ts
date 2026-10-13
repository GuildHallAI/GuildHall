import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json({
      error: { code: "invalid_request", message: "The request did not match the expected format.", issues: error.issues },
    });
    return;
  }
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 500;
  if (status >= 400 && status < 500) {
    response.status(status).json({ error: { code: "invalid_request", message: "The request could not be processed." } });
    return;
  }
  console.error("Unhandled GuildHall API error.", error);
  response.status(500).json({ error: { code: "internal_error", message: "An internal error occurred." } });
};
