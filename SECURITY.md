# Security Policy

## Reporting a vulnerability

Please report security issues privately to **[security@guildhallai.com](mailto:security@guildhallai.com)**. Do not open a public issue or pull request for an exploitable vulnerability.

Include the affected component, impact, reproduction steps, and any relevant transaction signatures or logs. Remove personal data, access tokens, seed phrases, and private keys. You may use an encrypted message if you need to share sensitive evidence; request the project’s current PGP key by email.

We aim to acknowledge reports within three business days and provide an initial assessment within seven business days. We will coordinate a fix and disclosure timeline with the reporter. Please allow time for users to receive a fix before publishing details.

## Scope

In scope:

- `guildhallai.com` and the GuildHall web application.
- The GuildHall backend and APIs operated by the project.
- Authentication, authorization, commission data, escrow EOAs, and transaction processing.
- The public source repository and its release/sync workflow.

Out of scope:

- Third-party services and infrastructure that GuildHall does not operate.
- Denial-of-service testing, spam, or social engineering.
- Vulnerabilities in Solana, wallets, RPC providers, or external token programs without a GuildHall-specific impact.
- Smart contracts or on-chain programs: GuildHall does not deploy custom contracts.

## Project-specific areas to review

- SIWS challenge validation, nonce reuse, and session authorization.
- Access control for commission records and encrypted EOA private keys.
- Encryption-key handling, rotation, backups, and database access.
- Duplicate, reordered, or partially confirmed Solana transactions and their PostgreSQL ledger updates.
- Input validation and injection risks in API routes and database queries.

## Research expectations

Please act in good faith, avoid accessing or modifying other users’ data, and do not move funds or disrupt service. If you follow this policy, make a reasonable effort to avoid privacy violations and promptly report findings, GuildHall will not pursue legal action for your research. We will credit reporters who request recognition, subject to their consent and applicable law.

## Deployed contracts

GuildHall has no custom deployed contracts or program addresses to report.
