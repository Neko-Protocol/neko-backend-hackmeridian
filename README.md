# Neko backend (HackMeridian fork)

NestJS API behind Neko's HackMeridian 2026 tokenization project on Stellar testnet. It serves the issuer Launchpad, the tokenization admin and the Neko Pro investor app. The project overview, live sites and the end-to-end evidence live in the main repository: [neko-tokenization-hackmeridian](https://github.com/Neko-Protocol/neko-tokenization-hackmeridian) (start with its README and [docs/evidence.md](https://github.com/Neko-Protocol/neko-tokenization-hackmeridian/blob/main/docs/evidence.md)).

This repository is a fork of Neko's existing backend. The git tag `pre-hackmeridian` (`d3bea25`) marks the code that existed before the event. Evaluate the hackathon work as the diff from that tag to `main`:

```bash
git diff --stat pre-hackmeridian..main
```

## What was built during the event

Everything under `src/domains/launchpad/`, plus `src/core/didit` and `src/core/privy`:

| Area                         | Entry point                                    | What it does                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Issuer accounts and KYB/KYC  | `launchpad.controller.ts`, `verifications.service.ts`, `accounts.service.ts` | Didit verification (or a mock for the demo), Privy accounts with an embedded Stellar testnet wallet                                                                      |
| Applications and review      | `applications.controller.ts`, `applications.service.ts` | Issuer applications with a minimum raise and dated repayment schedule; admin approve, reject or request changes                                                          |
| AI assistant                 | `assistant/`                                   | Claude streams answers next to the form, proposes field values the issuer applies, searches the Legal KB over MCP (`kb_` tools) and Neko's past decisions (`find_precedents`) |
| Review memory (precedents)   | `precedents.service.ts`, `application-similarity.ts` | One fixed-weight search over decided applications. The admin sees full cases; the issuer's assistant sees anonymised cases only                                         |
| Launch and vault operations  | `chain/launch.service.ts`, `chain/vault-ops.service.ts` | Deploys token, compliance and vault through the factory; close funding, release, milestone review                                                                       |
| Investor identity            | `investors.service.ts`, `chain/onchain-identity.service.ts` | A KYC-approved wallet gets an identity contract, signed KYC and AML claims and an entry in the shared identity registry, so the token contract accepts it              |
| Opportunities for Neko Pro   | `chain/opportunities.service.ts`               | Public list of launched vaults with their terms and contract IDs                                                                                                         |

Routes are versioned under `/v1` (for example `/v1/launchpad/applications`). Swagger is at `/docs` when the server runs.

## How the assistant handles evidence

- Legal answers may only cite articles a `kb_` tool returned in the same conversation. When the Legal KB is not configured or does not answer, the chat shows the issuer a notice and the model is told to mark legal points as unverified.
- `find_precedents` uses only the form fields the issuer has filled in; empty values never count as a match. It returns a ref (P1, P2), the decision, the month, matching and differing criteria and an amount band. Other issuers' names, IDs, reviewer notes, documents and exact amounts never reach the model.
- Each turn logs `launchpad_assistant_turn` with the tools called, precedent refs returned, model, Legal KB availability and latency, without form values or text.
- After submission, the backend writes `ai_summary` with Claude from the application and the conversation. The admin labels it as AI-generated and not verified.

## Run it

```bash
cp .env.example .env          # fill Supabase, Stellar, Privy, Didit or KYC_MOCK_ENABLED, ANTHROPIC_API_KEY, LAUNCHPAD_RAG_URL, NEKO_* contract settings
export GITHUB_PACKAGES_TOKEN=  # read:packages, for the @neko-protocol/* packages in .npmrc
npm ci
npm run dev                    # http://localhost:4000, Swagger at /docs
npm run build
npx jest src/domains/launchpad # hackathon tests
```

The database is Supabase. Migrations live in [neko-web-hackmeridian/supabase/migrations](https://github.com/Neko-Protocol/neko-web-hackmeridian/tree/main/supabase/migrations); the Launchpad needs `0029` to `0033`. Hosting steps are in the [deploy guide](https://github.com/Neko-Protocol/neko-tokenization-hackmeridian/blob/main/docs/deploy.md).

## Known limits

- Testnet only. The manager key signs launches and identity registration; keys live in environment variables, never in the repository.
- The precedent search uses fixed weights over seven fields. It does not learn, predict approval or replace the reviewer.
- Pre-existing test debt from the fork, not introduced at the event: suites for CORS text, mailing (expects a sibling `web-app/supabase/migrations` folder), vault APY (Blend types) and pool rates (ESM loading) fail or do not load. `npm run lint` has no ESLint config in this fork (it lived in the original monorepo).
- No CI workflow in this repository yet.
