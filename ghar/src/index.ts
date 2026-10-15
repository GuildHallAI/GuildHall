import { config } from "./config";
import { startWorker, workerStatus } from "./worker";

declare const Bun: {
  serve(options: { port: number; fetch(request: Request): Response }): { port: number };
};

const server = Bun.serve({
  port: config.port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", service: "guildhall-agent-runtime", agent: "Hall Scout", worker: workerStatus() });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

console.info(`GuildHall agent runtime listening on :${server.port}`);
startWorker();
