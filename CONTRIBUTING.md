# Contributing to GuildHall

GuildHall is in active development. Contributions that improve the prototype, backend foundations, documentation, accessibility, or reliability are welcome.

## Where help is useful

- Frontend fixes and accessible, responsive product flows.
- Backend migrations, SIWS authentication, API validation, and observability.
- Idempotent escrow state transitions and reconciliation.
- Documentation and focused bug reports.

Discuss larger changes in an issue before starting. Contributions should fit GuildHall's EOA and database-backed payment architecture.

## Development setup

Install the root dependencies with Bun 1.4.x:

```sh
bun install
bun run dev
```

For backend work, copy `backend/.env.example` to `backend/.env`, configure PostgreSQL and Solana RPC, and set a strong `DATA_ENCRYPTION_KEY`. Then run:

```sh
cd backend
bun install
bun run db:migrate
bun run dev
bun run check
```

Never commit `.env` files, access tokens, wallet secrets, encryption keys, or real user data. Use local or development-chain assets while developing.

## Workflow

1. Open or find an issue for the change. Ask first for changes that affect escrow policy, auth, database compatibility, or public API behavior.
2. Create a focused branch from `main`.
3. Keep each pull request centered on one concern and describe its behavior and operational impact.
4. Run the relevant checks and include the commands and results in the pull request.
5. Link related issues and update documentation when behavior or setup changes.

The public GitHub repository is a sanitized mirror of the private source repository. Maintainers publish updates through the dual-repository sync workflow; do not push directly to `public-origin` or force-push the mirror.

## Pull request guidelines

- Keep changes small enough to review and avoid unrelated formatting changes.
- Add or update tests when changing behavior, especially authentication, escrow, or transaction processing.
- Do not introduce contract deployment or on-chain program dependencies.
- For a security vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Commit messages

Use a short imperative sentence in plain English, for example:

```text
Add escrow operation reconciliation
Fix commission form validation
```

## Bug reports

Include:

- What page, API route, or workflow you used.
- Steps to reproduce, with sample data that contains no secrets or personal information.
- What you expected and what happened instead.
- Browser/runtime, OS, and relevant logs with credentials and private data removed.

Please do not include wallet seed phrases, private keys, session tokens, or production database records in issues.
