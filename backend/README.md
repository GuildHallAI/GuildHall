# GuildHall backend

The API is an off-chain service for wallet sessions, commission records, escrow EOAs, and the searchable work index. It uses a separate EOA for each commission; the API encrypts those private keys before storing them in Postgres. The gas payer EOA funds transaction fees. Payment workflows are handled through EOAs and PostgreSQL.

The backend exposes `/health` for process liveness and `/ready` for Postgres, applied migrations, Solana RPC, the gas payer, and settlement configuration. Readiness requires at least one configured six-decimal SPL Token mint on the selected cluster plus valid fee-recipient addresses, so the service does not report ready while commission settlement is unavailable. The response also shows which optional feature groups have their required environment configuration without exposing secrets. It applies pending database migrations before listening and coordinates commission records, escrow EOAs, and Solana settlement operations.

## Local setup

```sh
cp .env.example .env
# Set DATA_ENCRYPTION_KEY to a fresh random secret of at least 32 characters.
docker compose up -d
bun install
bun run dev
```

The web app runs at `http://localhost:3000`; the API runs at `http://localhost:3001`. Open `/health` and `/ready` on the API to check it. `bun run check` type-checks the service, and `bun test` runs the backend test suite.

## Environment

Required to start the API and check readiness:

- `DATABASE_URL`: PostgreSQL connection string.
- `SOLANA_CLUSTER`: `localnet`, `devnet`, `testnet`, or `mainnet-beta`.
- `SOLANA_RPC_URL`: RPC endpoint for the selected cluster.
- `DATA_ENCRYPTION_KEY`: random secret of at least 32 characters for escrow EOA key encryption.
- `GAS_PAYER_PRIVATE_KEY` or `GUILDHALL_GAS_WALLET_PRIVATE_KEY`: base58 encoded 64-byte Solana secret key used to pay transaction fees. The existing `GUILDHALL_GAS_WALLET_PUBLIC_KEY` is checked against it when provided. Keep private keys in the backend secret store; never expose them to the browser or Git. `/ready` checks that this key is configured and valid.
- `CRON_SECRET`: random secret of at least 32 characters for authenticated `/internal` operations, including manual or external calls to the transaction reconciler. `/ready` checks that it is configured.
- `WORKER_FEE_WALLET`, `TREASURY_WALLET`, `STAKER_FEE_WALLET`: Solana wallet addresses for the commission fee split; 5% of each 2% fee is burned from the commission token account.

`USDC_MINT` and `USDT_MINT` are the stablecoin mint addresses enabled for the selected cluster. Both are needed to create commissions in the corresponding asset. `AGENT_REGISTRY_PROGRAM_ID` and `AGENT_REGISTRY_ATOM_PROGRAM_ID` override the 8004 program IDs when using a nonstandard deployment such as localnet; the SDK supplies the public devnet and mainnet defaults. `PORT`, `TRUST_PROXY`, `SOLANA_COMMITMENT`, and `RECONCILE_INTERVAL_MS` have local defaults; the reconciliation interval defaults to 60 seconds and accepts values from 5 seconds to 1 hour. `AUTH_DOMAIN`, `AUTH_URI`, and `AUTH_TOKEN_PEPPER` configure wallet sign-in and session-token hashing. `AUTH_TOKEN_PEPPER` falls back to `DATA_ENCRYPTION_KEY` when unset. The frontend server calls this API, so browser CORS configuration is not used. The API applies pending migrations on startup; use `bun run db:migrate` to apply them manually.

`$GHALL` uses an extension-free, 9-decimal Token-2022 mint configured as `GHALL_MINT`. `POST /v1/ghall/stake-instructions` prepares a wallet-signed transfer into the user's encrypted stake EOA; `/stake-confirm` verifies the confirmed transaction. `POST /withdraw` returns the full stake after active listing allocations and the caller's open proposal votes are released. Withdrawals are idempotent and `/internal/reconcile` retries or confirms signed transactions. Evaluator capacity boosts use `GHALL_EVALUATOR_BOOST_THRESHOLD_ATOMIC` and `GHALL_EVALUATOR_MAX_CAPACITY_BPS` (10,000–12,500); they are disabled by default until a positive threshold and mint are configured. Warden/Panel assignment, Warden votes, and Bounty evaluator selection share this capacity check. `GHALL_LISTING_MINIMUM_STAKE_ATOMIC` sets the amount reserved for a linked Registry agent's front-page listing; `/front-page` sorts eligible listings by stake, and `PUT` or `DELETE /v1/ghall/listing` reserves or releases the allocation. `GHALL_BOUNTY_PRIORITY_THRESHOLD_ATOMIC` prioritizes staked evaluators when GuildHall assigns Bounties. Governance is configured with `GHALL_GOVERNANCE_MIN_QUORUM_ATOMIC` and `GHALL_GOVERNANCE_VOTING_DAYS`; staked holders can propose and vote on Warden or Panel appeal windows, and `/internal/reconcile` applies passed rule changes after voting closes. `GET /v1/ghall/me` reports the authenticated wallet's transferable and staked balance and evaluator capacity.

Tribunal appeal fees are configured in USDC atomic units with `TRIBUNAL_APPEAL_FEE_ATOMIC` (zero disables the fee). `GHALL_TRIBUNAL_FEE_DISCOUNT_THRESHOLD_ATOMIC` and `GHALL_TRIBUNAL_FEE_DISCOUNT_BPS` enable an on-chain GHALL-balance discount. Each appeal fee is paid into an encrypted per-case EOA; a successful appeal returns the fee to the appellant, while an unsuccessful appeal routes it to `TREASURY_WALLET`. Both outcomes use persisted signed transactions and `/internal/reconcile` confirmation/retry. `TRIBUNAL_PANEL_VOTE_HOURS` (default 24, maximum 168) sets the Panel voting window. When it expires, uncast seats are released and reassigned to eligible staked evaluators; the reconciler retries if a complete replacement group is not available.

Bounty commands can be submitted by mentioning `@GuildHall bounty 500 USDC for <task> by <YYYY-MM-DD>`. X-originated Bounties are created only for authors who linked their X account from an authenticated GuildHall wallet session. Link an account with `POST /v1/bounty-x/account/link`; the returned authorization URL opens X's OAuth 2.0 flow and the configured callback records the verified X user ID. The command deadline is interpreted as 23:59:59 UTC on the stated date. X commands use the configured entry bond and entry cap (`X_BOUNTY_ENTRY_BOND_ATOMIC`, default 1 USDC, and `X_BOUNTY_MAX_ENTRIES`, default 20). The internal reconciler polls bot mentions, creates Bounties through the same validation and escrow path as the API, and replies to the command with a funding Blink. Authors can see the linked X identity at `GET /v1/bounty-x/account` and unlink it with `DELETE /v1/bounty-x/account`.

`X_USER_ACCESS_TOKEN` must be an OAuth 2.0 user-context token for the GuildHall X account with read and post scopes; set `X_BOT_USER_ID` to the same account's numeric ID. Configure an X OAuth 2.0 app with `X_CLIENT_ID` and the exact `X_OAUTH_REDIRECT_URI` (`https://api.guildhallai.com/v1/bounty-x/account/callback` in production); set `X_CLIENT_SECRET` only for a confidential client. Creating a Bounty queues an announcement with a funding Blink; final settlement queues a receipt post. X posts use a durable outbox with safe rate-limit retries and ambiguous outcomes are not retried automatically. `GUILDHALL_ACTIONS_BASE_URL` defaults to `AUTH_URI`; X posts point at the frontend Solana Actions proxy at `/api/actions/bounties/:id`, which forwards requests to the backend Bounty Action endpoints.

Interop jobs can be imported as GuildHall commissions with a source marketplace and external job ID. GuildHall creates the commission escrow EOA and applies its 1% routing fee when the job settles; imported jobs use the same funding confirmation, work submissions, Tribunal, and paid work record as other commissions. GuildHall clients can publish an eligible open commission to the public `guildhall-interop/v1` offer feed; external marketplaces can poll the feed and use its funding, accept, and submission links. Publishing assigns the 1% routing fee. Unpublishing an offer before funding or acceptance restores the standard commission fee; an offer already in progress keeps its Interop terms. `GET /v1/interop/jobs/:id` provides a public status view for an imported job. The agent account x402 route supports owner-approved seller requests using exact-payment SVM x402; it records each request and payment outcome with an idempotency key.

Proving Ground uses `PYTH_API_KEY` and `PROVING_GROUND_SOL_USD_FEED_ID` to fetch current SOL/USD marks from Pyth Hermes. Defaults are a 1,000 USDC virtual account, 25 USDC challenge fee, 14 days, an 8% target, and 5% daily / 10% total drawdown limits. The configured Treasury wallet receives challenge fees. A successful challenge is allocated USDC from the pool EOA; funded account SOL/USDC swaps use Jupiter and require `JUPITER_API_KEY`. Charter buybacks use the same Jupiter order path. Because GuildHall supplies the gas payer separately from the funded EOA, Jupiter routes these orders through Metis; the backend validates the order metadata and required signers before signing. These controls are configurable through the `PROVING_GROUND_*` settings.

Charter defaults are a 1,000,000,000-token supply, a 20% creator allocation, and 52 weekly creator vesting periods. Each vesting period is earned only when its published on-time work threshold is met. The remaining 80% is held in a separate EOA until a DEX is selected; the backend does not set a timed unlock. `CHARTER_LAUNCH_FEE_ATOMIC` configures the one-time USDC launch fee, paid to `TREASURY_WALLET` and confirmed on Solana before mint creation; zero disables it. Charter agent tokens use an immutable 1% Token-2022 transfer fee. The reconciler collects withheld fees and pays 70% to the agent's treasury wallet and 30% to `TREASURY_WALLET`. `$GHALL` is a separate token design and has no Token-2022 extensions. `CHARTER_INCOME_BUYBACK_BPS=500` reserves 5% of agent income for buyback-and-burn operations. `/internal/reconcile` routes eligible Charter buybacks through Jupiter and burns the confirmed Token-2022 output; this requires `JUPITER_API_KEY` and available market liquidity for the Charter mint. If a swap's chain outcome is unclear after its blockhash expires, its attempt stays `outcome_unknown` and no replacement swap is created until reconciliation verifies the original.

Keep `DATA_ENCRYPTION_KEY` and the gas payer key in the backend host's secret store and local `.env`; never expose them to the browser or Git. The encryption key must be backed up securely because losing it makes the commission EOAs unrecoverable.

The per-commission escrow private keys are generated by the backend and encrypted in Postgres with AES-256-GCM. Solana transactions and Postgres updates cannot commit as one transaction, so escrow actions use a durable, idempotent operation ledger and reconciliation.

## API

REST endpoints are under `/v1`. Wallet sign-in issues a ten-minute, single-use message challenge, verifies a wallet's detached Ed25519 signature, then returns a seven-day opaque bearer session. The database stores only a hash of the session token.

The stateless MCP Streamable HTTP server is available at `https://api.guildhallai.com/mcp`. Public tools list supported assets, open commissions, individual commission status, unsigned funding instructions, Bounties, Human Tasks, and the latest Rate Board snapshot. Send the normal GuildHall session as `Authorization: Bearer <session-token>` to expose `create_commission`, `create_hand`, `create_bounty`, `claim_commission`, `submit_commission_work`, and `review_commission_submission`. Commission, Hands, and Bounty creation use the same safety attestation, idempotency, and dedicated escrow EOA flows as REST. Claims, submissions, and reviews are tied to the authenticated wallet; submissions use the same deadline, encryption, and Hands proof checks as REST. Accepting work opens the independent Warden sign-off flow. Funding instructions are unsigned; the client wallet signs and submits them. The endpoint does not require browser CORS configuration.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/nonce` | Public | Create a sign-in challenge. Body: `{ "walletAddress": "..." }`. |
| `POST` | `/auth/verify` | Public | Verify `{ "walletAddress", "nonce", "signature" }`; signature is base58. |
| `GET` | `/auth/me` | Session | Return the signed-in wallet identity. |
| `DELETE` | `/auth/session` | Session | Revoke the current bearer session. |
| `POST` | `/reports/tasks` | Session | Report a commission, Bounty, Hands task, or team commission for unsafe or prohibited content. Body: `{ "commissionId", "reason", "details" }`; requires `Idempotency-Key`. |
| `GET` | `/reports/me` | Session | Read the signed-in wallet's task reports and their moderation state. |
| `GET` | `/commissions/assets` | Public | List configured stablecoin mints and cluster. |
| `GET` | `/commissions` | Public | Browse open commissions. Supports `limit` and `before`. |
| `GET` | `/commissions/mine` | Session | Read commissions posted by or assigned to the signed-in wallet. Supports `limit` and `before`. |
| `POST` | `/commissions` | Session | Create a commission and its dedicated escrow EOA in one database transaction. Body includes `title`, `description`, `asset`, `amount`, `safetyAttestation: true`, optional `providerWallet`, `deadlineAt`, `category`, and `slaHours`. If omitted, the deadline is the SLA duration or seven days. Supplied deadlines must be at least one minute ahead. Requires an `Idempotency-Key` header. |
| `POST` | `/interop/jobs` | Session | Import a marketplace job into a GuildHall commission and escrow. Requires `Idempotency-Key`; body includes `source`, `externalJobId`, `title`, `description`, `asset`, `amount`, and `safetyAttestation: true`, with optional `sourceUrl`, `providerWallet`, `deadlineAt`, `category`, and `slaHours`. |
| `GET` | `/interop/jobs/:id` | Public | Read the imported job's GuildHall status and source reference. |
| `POST` | `/interop/offers/:id/publish` | Commission client | Publish an open, unaccepted, unfunded commission to the public Interop feed and apply its 1% routing fee. |
| `POST` | `/interop/offers/:id/unpublish` | Commission client | Remove the commission from public Interop discovery. |
| `GET` | `/interop/offers` | Public | Read paginated `guildhall-interop/v1` offers with stable terms and links to the GuildHall workflow. Supports `limit` and `before`. |
| `GET` | `/interop/offers/:id` | Public | Read one published Interop manifest. |
| `GET` | `/commissions/:id` | Public | Read commission terms and status. |
| `GET` | `/commissions/:id/funding-instructions` | Public | Return an unsigned SPL transaction that creates the token accounts and transfers the exact amount to escrow. The client wallet must sign and submit it. |
| `POST` | `/commissions/:id/accept` | Session | Accept an open commission as the signed-in provider. |
| `POST` | `/commissions/:id/funding/confirm` | Public chain proof | Verify the client's confirmed Solana transfer to the exact escrow ATA and record funding. A session is not required because the transaction must prove the client wallet signed the exact amount. Body: `{ "signature": "..." }`. |
| `POST` | `/commissions/:id/submissions` | Provider session | Submit a revision with a summary and structured evidence items (`url`, `text`, or `hash`). |
| `GET` | `/commissions/:id/submissions` | Participant session | Read the submission history and evidence for the commission. |
| `POST` | `/commissions/:id/review` | Client session | Request changes, open a dispute, or accept a submission and start the required independent evaluator sign-off. Requires a rationale. |
| `POST` | `/commissions/:id/disputes` | Participant session | Open a dispute with a reason and supporting evidence. |
| `GET` | `/commissions/:id/disputes` | Participant session | Read the dispute record and Tribunal vote history. |
| `POST` | `/commissions/:id/settle` | Client session | Broadcast or resume the release after an evaluator signs off and the appeal window closes. Returns `202` while Solana confirms the transaction and `200` after confirmation. |
| `POST` | `/commissions/:id/refund-expired` | Public | Permissionlessly refund an expired funded commission to its client, when no on-time submission exists. |
| `POST` | `/internal/reconcile` | `X-Cron-Secret` | Run the reconciliation batch for Bounty commands and posts, Wardens, stale Tribunal Panel seats, Tribunal decisions, slashes, escrow settlements, agent operations, bond returns, Surety, Charter operations, Proving Ground, and the Rate Board. The persistent Bun service also runs this batch every `RECONCILE_INTERVAL_MS` using a PostgreSQL advisory lock shared with manual or external invocations. Body: `{ "limit": 25 }`. |
| `GET` | `/registry/:wallet` | Public | Read a wallet's settled work totals, earnings, distinct clients, acceptance rate, and appeal losses. |
| `GET` | `/registry/:wallet/work-records` | Public | Read paid work records, outcome, amount, and the confirmed Solana Memo transaction when available. Supports `limit` and `before`. |
| `POST` | `/registry/agent-asset` | Session | Link an 8004 Solana Agent Registry asset after the API verifies current on-chain ownership by the signed-in wallet. |
| `DELETE` | `/registry/agent-asset` | Session | Unlink the caller's Registry asset. |
| `POST` | `/registry/:wallet/feedback` | Session | Rate a paid participant from a settled commission with `{ commissionId, rating, comment }`. |
| `POST` | `/registry/:wallet/feedback/:feedbackId/onchain` | Feedback author | Prepare an unsigned 8004 Registry feedback transaction. The signed-in wallet pays and signs it. |
| `POST` | `/registry/:wallet/feedback/:feedbackId/onchain/confirm` | Feedback author | Verify that the confirmed transaction exactly matches the prepared Registry feedback message. Body: `{ "signature": "..." }`. |
| `GET` | `/registry/:wallet/feedback` | Public | Read feedback earned only from settled work. Supports `limit` and `before`. |
| `GET` | `/registry/:wallet/charter-eligibility` | Public | Check the published earned-launch thresholds against settled work records. |
| `GET` | `/charters/me` | Session | Read the caller's Charter status, launch details, vesting totals, and current eligibility. |
| `POST` | `/charters/launch-fee-instructions` | Eligible session | Prepare the configured USDC launch-fee payment to the treasury. |
| `POST` | `/charters/launch-fee-confirm` | Eligible session | Verify a confirmed exact launch-fee payment. Body: `{ "signature": "..." }`. |
| `POST` | `/charters/launch` | Eligible session | Create the fixed-supply Token-2022 mint after launch-fee confirmation when a fee is configured. Hold its 80% allocation in a separate EOA pending DEX selection; `/internal/reconcile` confirms launch. |
| `POST` | `/charters/vesting/claim` | Charter owner | Evaluate elapsed weekly periods against on-time settled work and queue eligible creator token transfers. |
| `GET` | `/proving-ground/markets` | Public | Read available oracle markets and the published challenge parameters. |
| `GET` | `/proving-ground/pool` | Public | Read the USDC funding pool address, on-chain balance, outstanding allocation reservations, and available balance. |
| `GET` | `/proving-ground/me` | Session | Read the caller's current challenge, simulated position, latest oracle mark, and recent trades. |
| `POST` | `/proving-ground/challenges` | Session | Prepare an exact USDC challenge fee transaction. Requires `Idempotency-Key`. |
| `POST` | `/proving-ground/challenges/:accountId/fee-confirm` | Session | Verify the confirmed fee transaction and start the 14-day challenge. Body: `{ "signature": "..." }`. |
| `POST` | `/proving-ground/accounts/:accountId/trades` | Session | Record an idempotent simulated SOL spot buy or sell at a fresh Pyth price. Body: `{ "side": "buy"|"sell", "quantity": "0.1" }`. Enforces the daily and total drawdown limits. |
| `POST` | `/proving-ground/accounts/:accountId/funded-trades` | Session | Execute an idempotent Jupiter SOL/USDC swap from a funded account EOA. Body: `{ "side": "buy"|"sell", "amount": "25.00" }` (USDC amount for a buy; SOL amount for a sell). A prepared trade is retried or confirmed by `/internal/reconcile`. Requires `JUPITER_API_KEY`. |
| `POST` | `/proving-ground/accounts/:accountId/profit-settlements` | Session | Settle USDC profit above the account's high-water mark after all SOL has been sold. Sends 80% to the account owner, 15% back to the pool, and 5% to the protocol. Requires `Idempotency-Key`; signed transfers are retried or confirmed by `/internal/reconcile`. |
| `POST` | `/evaluators/stake-instructions` | Session | Create/load the evaluator stake EOA and return an unsigned USDC deposit transaction. |
| `POST` | `/evaluators/stake-confirm` | Session | Verify a confirmed USDC stake deposit and activate evaluator capacity. |
| `GET` | `/evaluators/me` | Session | Read the signed-in evaluator's stake address, balance, and capacity. |
| `GET` | `/ghall/me` | Session | Read the signed-in wallet's GHALL balance and effective evaluator capacity. |
| `POST` | `/ghall/stake-instructions` | Session | Prepare an unsigned Token-2022 GHALL deposit into the wallet's encrypted stake EOA. |
| `POST` | `/ghall/stake-confirm` | Session | Verify and record a confirmed GHALL stake deposit. |
| `POST` | `/ghall/withdraw` | Session | Withdraw GHALL stake after its listing allocation and active votes are released. Requires `Idempotency-Key`. |
| `GET` | `/ghall/front-page` | Public | List linked Registry agents with active GHALL listing allocations. |
| `PUT` | `/ghall/listing` | Session | Reserve part of the wallet's GHALL stake for a linked Agent Registry asset. |
| `DELETE` | `/ghall/listing` | Session | Release the wallet's front-page listing allocation. |
| `GET` | `/ghall/proposals` | Public | List Tribunal rule proposals, vote totals, and enacted settings. |
| `POST` | `/ghall/proposals` | Session | Propose a Warden or Panel appeal window change. |
| `POST` | `/ghall/proposals/:proposalId/votes` | Session | Cast a one-wallet, staked-balance-weighted yes/no vote. |
| `POST` | `/ghall/proposals/:proposalId/finalize` | Public | Close a proposal after its voting period and enact a passing rule. |
| `POST` | `/evaluators/withdraw` | Session | Withdraw USDC stake when the evaluator has no open assignments or unresolved slashes. Requires `Idempotency-Key`. |
| `POST` | `/agent-accounts` | Session | Create the owner's encrypted agent EOA and set per-action, daily, asset, program, x402-host, and expiry limits. |
| `GET` | `/agent-accounts/me` | Session | Read agent account rules, approved x402 hosts, and current UTC-day spending. |
| `PUT` | `/agent-accounts/me/policy` | Session | Update the owner's limits, assets, supported programs, x402 hosts, or expiry without changing the EOA. Updates wait until in-flight transfers and x402 requests resolve. |
| `POST` | `/agent-accounts/me/api-keys` | Session | Issue a one-time agent API key. |
| `DELETE` | `/agent-accounts/me/api-keys/:keyId` | Session | Revoke one agent API key. |
| `POST` | `/agent-accounts/me/kill-switch` | Session | Disable the agent account and revoke all its API keys. |
| `POST` | `/agent-accounts/me/enable` | Session | Re-enable an unexpired account; a new API key is required. |
| `POST` | `/agent-accounts/:accountId/transfers` | Agent API key | Transfer an allowed stablecoin under its action and daily limits. Requires `Idempotency-Key`. |
| `POST` | `/agent-accounts/:accountId/x402` | Agent API key | Make an idempotent GET or JSON POST request to an owner-approved HTTPS x402 seller. Exact Solana mainnet/devnet and allowed six-decimal stablecoin payment requirements are filtered against the caller's maximum, per-action cap, and reserved daily budget. The response is encrypted for replay; ambiguous outcomes are retained and never auto-replayed. Requires `Idempotency-Key`; body: `{ "url": "https://seller.example/resource", "maxPayment": "2.00", "method": "POST", "body": { "query": "..." } }`. |
| `GET` | `/agent-accounts/me/transfers` | Session | Read recent agent transfer ledger entries. |
| `GET` | `/agent-accounts/me/x402-requests` | Session | Read recent x402 payment requests, including reserved and charged amounts and any ambiguous outcome. |
| `POST` | `/agent-accounts/me/recover` | Session | Recover an allowed stablecoin to the owner's wallet, including after account expiry or kill switch. Requires `Idempotency-Key`. |
| `GET` | `/hands` | Public | Browse safe, unclaimed human tasks. Supports `limit` and `before`. |
| `POST` | `/hands` | Session | Create a human task with its own commission escrow EOA. Requires `Idempotency-Key` and `{ title, description, category, asset, amount, deadlineAt, safetyAttestation: true }`. |
| `GET` | `/hands/:id` | Public | Read task terms and its category-specific proof schema. |
| `GET` | `/rate-board` | Public | Read settled-work market rates and outcomes by category and optional `slaHours`. Supports `category`, `slaHours`, and `limit`. |
| `GET` | `/rate-board/guilds` | Public | Rank Guilds by settled jobs, acceptance rate, delivery time, and total paid amount. |
| `GET` | `/bounties` | Public | Browse funded and fundable bounties with entrant counts. Supports `limit` and `before`. |
| `POST` | `/bounties` | Session | Create a bounty commission, escrow EOA, and stake-qualified random evaluator. Requires `Idempotency-Key`; body includes `title`, `description`, `asset`, `amount`, `bondAmount`, `maxEntries` (1–100), `category`, `deadlineAt`, and `safetyAttestation: true`. |
| `POST` | `/bounty-x/account/link` | Session | Start X OAuth 2.0 account linking for the signed-in wallet; returns an authorization URL. |
| `GET` | `/bounty-x/account/callback` | Public OAuth callback | Consume a single-use OAuth state, verify identity with X `/2/users/me`, and associate that X user ID with the wallet account. |
| `GET` | `/bounty-x/account` | Session | Read the linked X account for the signed-in wallet. |
| `DELETE` | `/bounty-x/account` | Session | Remove the X account link. |
| `GET` | `/bounties/:id` | Public | Read the bounty pot, entry bond, deadline, evaluator, and entrant count. |
| `GET` | `/bounties/:id/x-post` | Public | Read announcement and receipt publication states and X post URLs. |
| `GET` | `/bounties/:id/action` | Public | Return Solana Action metadata for the bounty funding Blink. |
| `POST` | `/bounties/:id/action` | Public | Return the unsigned funding transaction for the bounty creator's wallet. The frontend Action callback confirms its signature through `/commissions/:id/funding/confirm`. |
| `POST` | `/bounties/:id/entries` | Session | Enter a funded bounty and receive an unsigned stablecoin bond-deposit transaction for the entrant's dedicated bond EOA. |
| `POST` | `/bounties/:id/entries/:entryId/bond-confirm` | Entrant session | Verify the confirmed exact bond deposit from the entrant wallet. |
| `POST` | `/bounties/:id/entries/:entryId/submissions` | Entrant session | Submit encrypted summary and evidence after the bond confirms. |
| `GET` | `/bounties/:id/entries` | Client, evaluator, or entrant | Read entry status; only the assigned evaluator receives every encrypted entry decrypted for ranking. |
| `POST` | `/bounties/:id/evaluate` | Assigned evaluator | Rank every submitted entry once with a rationale. The winner enters the ordinary client review and Tribunal workflow. |
| `POST` | `/bounties/:id/bond-returns` | Public | Start or resume durable returns of entrant bonds after the bounty settles or refunds. |
| `POST` | `/crews` | Session | Create a crew; its creator becomes the lead. |
| `GET` | `/crews/mine` | Session | List crews the signed-in wallet belongs to. |
| `GET` | `/crews/invitations` | Session | List pending crew invitations for the signed-in wallet. |
| `GET` | `/crews/:crewId` | Public | Read crew name, description, lead, and membership. |
| `POST` | `/crews/:crewId/invitations` | Crew lead | Invite a registered wallet by `walletAddress`. |
| `POST` | `/crews/:crewId/invitations/:invitationId/accept` | Invitee session | Accept a pending crew invitation. |
| `POST` | `/crews/:crewId/commissions` | Client session | Post a crew commission with fixed `contributors` shares totaling 10,000 basis points and one or more subtasks per member. Requires `Idempotency-Key` and `safetyAttestation: true`. |
| `GET` | `/crews/:crewId/commissions/:commissionId/tasks` | Crew member | Read subtask status and decrypted team submissions. |
| `POST` | `/crews/:crewId/commissions/:commissionId/tasks/:taskId/submission` | Assigned member | Submit encrypted subtask evidence. |
| `POST` | `/crews/:crewId/commissions/:commissionId/tasks/:taskId/review` | Crew lead | Accept subtask work or request changes with a rationale. |
| `GET` | `/crews/:crewId/commissions/:commissionId/payout-shares` | Crew member | Read the fixed commission shares. |
| `POST` | `/guilds` | Session | Create a standing Guild with a target shared USDC bond and response SLA. The creator becomes lead. |
| `GET` | `/guilds/mine` | Session | List Guilds the signed-in wallet belongs to, including bond status and share plan. |
| `GET` | `/guilds/invitations` | Session | Read pending Guild invitations for the signed-in wallet. |
| `GET` | `/guilds/:guildId` | Public | Read Guild membership, shared bond target and balance, SLA, and fixed payout shares. |
| `POST` | `/guilds/:guildId/invitations` | Guild lead | Invite a registered wallet by `walletAddress`. |
| `POST` | `/guilds/:guildId/invitations/:invitationId/accept` | Invitee session | Accept a pending Guild invitation. |
| `PUT` | `/guilds/:guildId/shares` | Guild lead | Set a 10,000 basis point payout split for every Guild member. |
| `POST` | `/guilds/:guildId/bond-instructions` | Guild member | Receive an unsigned USDC deposit transaction for the shared Guild bond. |
| `POST` | `/guilds/:guildId/bond-confirm` | Depositor session | Confirm the exact USDC bond deposit. |
| `POST` | `/guilds/:guildId/close` | Guild lead | Close a Guild with no unresolved commissions or bond deposits, then start durable returns of each confirmed member contribution. |
| `POST` | `/guilds/:guildId/commissions` | Client session | Post work through a fully bonded Guild; the Guild SLA sets the deadline and the posted shares are fixed. Requires `Idempotency-Key` and `safetyAttestation: true`. |
| `GET` | `/guilds/:guildId/commissions/:commissionId/tasks` | Guild member | Read task status and decrypted Guild submissions. |
| `POST` | `/guilds/:guildId/commissions/:commissionId/tasks/:taskId/submission` | Assigned member | Submit encrypted Guild task evidence. |
| `POST` | `/guilds/:guildId/commissions/:commissionId/tasks/:taskId/review` | Guild lead | Accept task work or request changes with a rationale. |
| `GET` | `/tribunal/cases/:caseId` | Participant or assigned member | Read case materials and recorded votes. |
| `GET` | `/tribunal/precedents` | Public | Read anonymized final rulings; detailed case material appears only after both commission parties consent. |
| `POST` | `/tribunal/cases/:caseId/precedent-consent` | Commission client or provider | Opt in or revoke consent to publish case details. Body: `{ "publishDetails": true }`. |
| `POST` | `/tribunal/cases/:caseId/warden-vote` | Assigned Warden | Record a reasoned evaluator sign-off or ruling and open the configured appeal window. |
| `POST` | `/tribunal/cases/:caseId/appeal-fee-instructions` | Commission participant | Prepare the configured USDC appeal fee payment and apply any eligible GHALL discount. |
| `POST` | `/tribunal/cases/:caseId/appeal-fee-confirm` | Commission participant | Verify a confirmed USDC payment; an unused fee is refunded if its appeal window closes. |
| `POST` | `/tribunal/cases/:caseId/appeal` | Commission participant | Appeal the Warden's ruling to a random panel of five eligible staked evaluators or a Panel ruling to the final Bench. Include the confirmed `feeSignature` when an appeal fee is configured. |
| `POST` | `/tribunal/cases/:caseId/panel-vote` | Assigned panel member | Record a reasoned Panel vote; the five votes determine the Panel verdict. |
| `POST` | `/tribunal/cases/:caseId/bench-vote` | Assigned vetted human | Record a final Bench juror vote; the result tallies the assigned AI jurors and two humans. |
| `GET` | `/surety/pool` | Public | Read Surety pool USDC balance, active coverage, share supply, and queued withdrawals. |
| `POST` | `/surety/pool/deposit-instructions` | Session | Prepare an exact USDC contribution transaction for the underwriter pool. Body: `{ "amount": "100.00" }`. |
| `POST` | `/surety/pool/deposit-confirm` | Depositor session | Verify the prepared contribution after Solana confirmation and mint pool shares. Body: `{ "depositId", "signature" }`. |
| `DELETE` | `/surety/pool/deposits/:depositId` | Depositor session | Cancel an unconfirmed contribution after its blockhash expires and the pool balance confirms no transfer landed. |
| `GET` | `/surety/pool/position` | Session | Read the caller's pool shares, confirmed contributions, queued withdrawals, and pool overview. |
| `POST` | `/surety/pool/withdrawals` | Session | Queue a USDC withdrawal by share amount. Body: `{ "shares": "10.00" }`. Payments wait until all coverage obligations and premium operations resolve. |
| `DELETE` | `/surety/pool/withdrawals/:withdrawalId` | Session | Cancel a withdrawal that remains queued. |
| `POST` | `/surety/commissions/:commissionId/quote` | Client session | Quote coverage up to the commission amount using settled Tribunal overturn rates for the category and SLA. Body: `{ "coverage": "50.00" }`. |
| `POST` | `/surety/commissions/:commissionId/purchase-instructions` | Client session | Prepare the exact premium payment for the quoted coverage. Funding stays blocked until premium confirmation or cancellation. |
| `POST` | `/surety/commissions/:commissionId/premium-confirm` | Client session | Verify the exact prepared premium transaction after confirmation on Solana. |
| `POST` | `/surety/commissions/:commissionId/policy-cancel` | Client session | Cancel an unpaid policy after its transaction blockhash expires and no premium reached the pool. |
| `POST` | `/internal/jurors/:userId/approve` | `X-Cron-Secret` | Vet a signed-in human for final Bench assignment. |
| `POST` | `/internal/jurors/:userId/revoke` | `X-Cron-Secret` | Revoke a human juror from future Bench assignments. |
| `GET` | `/internal/launch-metrics?launchAt=<ISO-8601>` | `X-Cron-Secret` | Measure the overview's day 7, day 30, and day 45 launch criteria, plus each Warden's rolling seven-day appeal rate. |
| `GET` | `/internal/task-reports` | `X-Cron-Secret` | Read open task reports with the related commission content for operator review. Supports `limit`. |
| `POST` | `/internal/task-reports/:reportId/resolve` | `X-Cron-Secret` | Record the outcome of a task report review. Body: `{ "resolution": "action_taken" | "no_violation" | "needs_followup", "note": "..." }`. |

The funding confirmation checks the cluster transaction, client signer, client's token balance change, mint, destination account, and exact atomic amount before it marks a commission funded. Retries with the same confirmed signature are idempotent. When a client accepts a submission, GuildHall opens a Tribunal case for an independent staked evaluator to sign off as Warden. Escrow stays frozen through the Warden decision and its appeal window; a Panel or final Bench can overturn that decision. The client authorizes settlement after the Warden sign-off becomes final; the backend signs provider and fee transfers from the commission EOA and pays network fees with the gas payer EOA. The 2% commission fee is split 80% to the worker fee wallet, 10% to the treasury wallet, 5% to the staker fee wallet, and 5% burned. Signed transactions and each attempt are persisted before broadcast, so retries resume the same transaction while its blockhash is valid. Expired funded jobs can be refunded by any caller after the deadline if the provider did not submit on time. The in-process reconciler checks submitted releases and refunds and updates commission state after chain confirmation even when the caller does not retry. A confirmed release marks the commission complete and creates its paid work record. Use `Authorization: Bearer <session-token>` for session-protected requests.

Submissions and reviews are append-only so revisions and decision history remain available. Submission summaries and evidence payloads are encrypted at rest with AES-256-GCM using a key derived from `DATA_ENCRYPTION_KEY`; only authenticated commission participants can request decrypted commission evidence, and only assigned team members and leads can view their crew work. Provide durable content URLs or cryptographic hashes for large artifacts instead of embedding files. Every confirmed work record is queued for a privacy-preserving Solana Memo transaction containing public settlement facts and a SHA-256 record digest; the in-process reconciler retries the on-chain write. Registry feedback can be submitted only by a paid participant of a confirmed settled work record, with its value weighted by the settled amount. The recipient can link an 8004 Solana Agent Registry asset after on-chain ownership verification; the reviewer signs the resulting Registry feedback transaction from their wallet. A dispute creates one Tribunal case per commission and moves the commission into `disputed` while keeping escrow funds reserved. Eligible active evaluators are assigned as Wardens or randomly selected for a five-member appeal Panel; evaluator capacity is limited to commissions worth at most one fifth of their confirmed USDC stake. A Panel ruling can be appealed to a final Bench with two internally vetted humans and the configured AI jurors. The reconciliation task closes Warden and Panel appeal windows, applies the ruling, and settles the resulting provider payout, client refund, or even split.

`TRIBUNAL_AI_JURORS` is a JSON array of at least three OpenAI-compatible juror configurations, each with a unique `id`, `endpoint`, `apiKey`, and `model`. AI jurors receive commission terms, dispute evidence, appeal rationale, earlier rulings, and decrypted submissions when the final Bench is opened. Their reasons and response hashes are stored with the case. The reconciliation job also settles final outcomes and transfers a Warden's commission-sized USDC slash to the prevailing party if the final ruling overturns the Warden.

Hands tasks use the same funded commission, submission, review, dispute, and settlement lifecycle. The first categories are `public_place_photo`, `inventory_count`, and `accessibility_observation`; each assigns a fixed proof schema. Submissions can contain an HTTPS photo URL, ISO timestamp, coarse geohash cell, or structured checklist as required by that schema. Raw latitude/longitude and uploaded binary data are not accepted by the API. Commission, Bounty, and Hands task creation require a safety attestation and apply a conservative restricted-activity keyword check; operators still need to review reports and enforce task policy. The Rate Board refreshes hourly and aggregates category, SLA, payment, delivery time, acceptance, and appeal overturn figures only from settled work records, including Tribunal refunds. Provider-favoring Tribunal outcomes count as accepted, and appeal overturn rates use decided appeals as the denominator. Surety pricing uses that same appeal-only overturn definition. `/rate-board/guilds` ranks Guilds on settled work.

Bounties use a separate encrypted EOA for each entrant bond. Entrants sign their own exact USDC or USDT bond deposit; an eligible staked evaluator ranks the encrypted entries after the entry slots fill or the deadline passes. The selected entry becomes a normal commission submission, so the client retains review and dispute rights. On final settlement or refund, the reconciliation task transfers each entrant's remaining bond from its EOA and closes its token account. Bounty and Hands completions use a 5% protocol fee; standard commissions use 2%. Each fee follows the 80% workers, 10% treasury, 5% stakers, and 5% burn allocation.

Crews invite registered wallet identities and create commissions with a fixed payout share for each participating member. Each member receives one or more assigned subtasks and submits encrypted evidence; the lead accepts or requests changes before submitting the complete commission to the client. On approval, the commission EOA pays each crew member and the fee recipients through individually persisted transactions, keeping the workflow within Solana transaction-size limits. The database records each member's actual share as paid work for the Registry and Charters.

Crew and Guild payout steps keep the same signed transaction across retries while its blockhash is valid. If a blockhash expires while the RPC cannot determine whether a step landed, that step is marked `outcome_unknown`; the reconciler pauses later transfers and retries signature lookup until it can confirm success or a failed transaction. It does not replace an ambiguous payout with a new transfer.

Guilds add a shared USDC bond and a standing response SLA to the team model. Guild members contribute to an encrypted Guild EOA; only a fully funded Guild can take work. The Guild's lead sets member shares, clients post work against the Guild SLA, and each member completes an assigned encrypted task. Guild payouts use the same separately persisted transactions and per-member paid-work records as Crew payouts. A lead can close the Guild after all commissions settle; the in-process reconciler returns every confirmed contribution through individually persisted Solana transfers.

Surety underwriters deposit USDC into one encrypted pool EOA and receive database-tracked shares priced against pool balance. A client can buy one policy for an open commission before escrow funding; policy premiums are priced from the settled Tribunal overturn rate for the work category and SLA, with defaults configured by `SURETY_BASE_PREMIUM_BPS`, `SURETY_OVERTURN_RISK_BPS`, and `SURETY_MAX_PREMIUM_BPS`. The current default is 1% base plus up to 1% for a 100% overturn rate, capped at 5%. Ten percent of each premium is routed to `TREASURY_WALLET` when the commission resolves. Client-favoring final Tribunal refunds queue a pool payout up to the policy coverage after the escrow refund confirms; other final outcomes release the coverage reserve. Underwriter withdrawals queue until active and pending policies, claims, and premium operations are resolved. The `/internal/reconcile` job persists signed pool transactions and retries them through the operation ledger. Pool shares do not promise a yield; their value follows the pool's USDC balance and outstanding obligations.

An eligible wallet can launch one Token-2022 Charter. Eligibility counts work records with confirmed Solana Memo transactions and excludes same-wallet work, reciprocal client/provider work, and paid work inside two-hop circular funding paths. Each Charter mint has a fixed one-billion-token supply, an immutable 1% transfer fee, and a revoked mint authority. Twenty percent is held in the creator vesting EOA; eighty percent goes to a separate EOA and remains there until a DEX is selected. Each elapsed seven-day period is evaluated once: at least 90% of funded commissions due in that period must settle by their deadlines for that week's creator tranche to vest. A period with no funded commission due is considered compliant. An ineligible period earns no tranche. The launch, creator transfers, transfer-fee collection and 70/30 distribution, and buybacks are persisted and retried by `/internal/reconcile`.
