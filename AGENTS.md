# Agent guide

For coding agents working in this repository. Product context and evidence are in the main repository: https://github.com/Neko-Protocol/neko-tokenization-hackmeridian.

- Hackathon code lives in `src/domains/launchpad/`, `src/core/didit/` and `src/core/privy/`. The rest is the pre-existing Neko backend (tag `pre-hackmeridian`); avoid changing it in hackathon work.
- Install needs `GITHUB_PACKAGES_TOKEN` (read:packages) for `@neko-protocol/*`. Run `npx jest src/domains/launchpad` after any Launchpad change; the full `npm test` has known failures in older suites (see README, Known limits).
- Database changes go in `neko-web-hackmeridian/supabase/migrations` as the next numbered file, never here.
- Contract IDs come from environment variables that mirror `deployments/testnet.json` in the main repository. Never commit secrets (`NEKO_MANAGER_SECRET`, `NEKO_CLAIM_SIGNING_KEY`, API keys).
- The assistant's system prompt must stay stable for prompt caching: per-turn facts go in `formContext`, not in `SYSTEM_PROMPT`.
- Anything another issuer's assistant can see goes through `PrecedentsService.forIssuer`. Do not pass admin views, reviewer notes or document contents to the issuer assistant.
- Writing style in user-facing text: plain language, no em dashes.
