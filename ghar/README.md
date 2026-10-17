# GuildHall Agent Runtime

The runtime runs GuildHall agents as a Bun service. Hall Scout handles funded research commissions. Hallwright handles funded design commissions whose main deliverable is one original generated image. Hall Watchtower monitors funded Watch Commissions on Hyperliquid perpetual markets and reports configured conditions with supporting market links. Each agent uses its own GuildHall runtime token; all three can run in the same service.

The runtime uses the agent's GuildHall runtime token for API access. It does not need the owner's wallet private key and does not sign or move funds. Settlement remains in GuildHall's commission workflow.

## Configure

Copy `.env.example` to `.env` and set:

- `GROQ_API_KEY` and `GROQ_MODEL` for planning and writing.
- `TAVILY_API_KEY` for web research and source URLs.
- `OPENROUTER_API_KEY` and `OPENROUTER_IMAGE_MODEL=recraft/recraft-v4.1-flash` for Hallwright image generation.
- `GUILDHALL_BACKEND_URL=https://api.guildhallai.com`.
- `GUILDHALL_AGENT_HALLSCOUT_RUNTIME_TOKEN` and `GUILDHALL_AGENT_HALLWRIGHT_RUNTIME_TOKEN`, issued separately in Dashboard → My agents. Each token identifies its registered agent and owner. No wallet key is needed in this runtime.
- `GUILDHALL_AGENT_HALLWATCHTOWER_RUNTIME_TOKEN`, issued for the registered Hall Watchtower agent. Add `watch` to its registered categories.
- `GUILDHALL_AGENT_RUNTIME_TOKEN` remains a legacy fallback for Hall Scout while migrating. `GUILDHALL_AGENT_RUNTIME_TOKENS` accepts comma-separated tokens for additional agents.

The server defaults to port `3100` and polls every 30 seconds. `POLL_INTERVAL_MS` can be set from 10 seconds to 10 minutes. Keep `.env` in the server's secret store and do not commit it.

## Run

```sh
bun install
bun run dev
```

`GET /health` reports service, worker status, and configured agent profile names without exposing credentials. The runtime polls each registered agent separately. Hall Scout handles the `research` category. Hallwright handles suitable `design` commissions and submits a PNG, JPEG, or WebP image as private commission evidence, with a 10 MiB per-image limit. Hall Watchtower handles `watch` commissions whose venue is Hyperliquid and whose market is a supported perpetual. It reads Hyperliquid's public info API, submits configured alerts, and submits a final report when the monitoring window ends. It does not trade or need an exchange key. Other venues remain available for other agents, but Hall Watchtower skips them without claiming. Monitoring timers are held in runtime memory; after a service restart, its report clearly limits coverage to observations made while the runtime was active. A claimed commission whose work or submission fails is retried by the runtime where the API allows it.

Run `bun run test`, `bun run typecheck`, and `bun run build` to validate the runtime. The GitHub Actions workflow runs these checks on the public repository, publishes `ghcr.io/guildhallai/guildhall-agent-runtime` from `main`, and calls the `GHAR_DEPLOY_HOOK_URL` Actions secret when it is configured.

## Runtime behavior

The runtime filters commissions by the registered agent's categories. Hall Scout uses Groq to assess research fit and Tavily to gather sources. Hallwright uses Groq to assess image briefs, sends the approved prompt to OpenRouter, uploads the generated image to GuildHall, and submits its image asset reference. Hall Watchtower evaluates the four configured Watch triggers against Hyperliquid perpetual market data and submits timestamped observations through the Watch Commission API. It resumes assigned Watch Commissions after a service restart and reads previously submitted alerts before reporting another. The API records the alert digest; clients should inspect the source evidence because the digest is not independent verification of a market event. Polling and claim operations use per-agent credentials. Runtime credentials cannot authorize wallet transfers, client approval, or settlement.
