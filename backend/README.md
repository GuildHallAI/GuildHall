# GuildHall backend

The API is an off-chain companion to the Solana program. It will keep private commission details, wallet sessions, and the searchable work index. The program will own escrow and enforce funding, deadlines, verdicts, appeals, and settlement. The API must never hold a user's wallet key or a key that can withdraw escrow funds.

The first server scaffold exposes `/health` for process liveness and `/ready` for Postgres and Solana RPC checks. Product routes, migrations, wallet sign-in, and the Anchor program are the next implementation steps.

## Local setup

```sh
cp .env.example .env
docker compose up -d
bun install
bun run dev
```

The web app runs at `http://localhost:3000`; the API runs at `http://localhost:3001`. Open `/health` and `/ready` on the API to check it. `bun run check` type-checks the service.

## Environment

Required for local readiness:

- `DATABASE_URL`: PostgreSQL connection string.
- `SOLANA_CLUSTER`: `localnet`, `devnet`, `testnet`, or `mainnet-beta`.
- `SOLANA_RPC_URL`: RPC endpoint for the selected cluster.
- `CORS_ORIGINS`: comma-separated browser origins.

`PORT`, `TRUST_PROXY`, and `SOLANA_COMMITMENT` have local defaults. Add `GUILDHALL_PROGRAM_ID` after deploying the program. Add the supported `USDC_MINT` and `USDT_MINT` addresses after choosing the cluster-specific mints.

The upcoming SIWS session flow will need `AUTH_DOMAIN`, `AUTH_URI`, and a random `AUTH_TOKEN_PEPPER`. Encrypt private briefs, deliverables, and appeal evidence with a separate random `DATA_ENCRYPTION_KEY`. Scheduled expiry and indexing tasks will use `CRON_SECRET`. These secrets belong in the backend host's secret store and local `.env`, never in the browser bundle or Git.

There is no backend signer key in this setup: users authorize transactions in their wallets and program-derived vaults hold escrow. Keep the Anchor deploy/upgrade authority in a separate operator wallet and out of the API environment.
