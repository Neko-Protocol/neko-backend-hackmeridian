# Launchpad issuer assistant behaviour eval

Deterministic, versioned checks for the Launchpad issuer assistant backend. No network and no API keys: the Anthropic client and the RAG client are faked per scenario.

## What is under test

With a **scripted model**, most checks exercise the **backend's real behaviour**:

1. **Tool trace** - which tools the service offered (legal KB tools, `find_precedents`, propose) and which ones ran.
2. **KB unavailable** - the SSE `notice` event and the turn `form_context` that says the legal KB is unavailable.
3. **Permissions** - tool_result payloads must not contain other issuers' names, emails, IDs, reviewer notes or exact amounts from the precedent fixtures.
4. **Injection** - retrieved or uploaded text reaches the model only inside tool_result or document data blocks, and the system prompt says documents and tool results are data, not instructions.

**Citation validity** (every article or precedent ref in the final answer must appear in a tool_result from the same turn) tests the **checker and the plumbing**, not model quality. The scripted final answer is written to include only refs the tools returned; a separate self-test proves the checker fails on a fabricated citation.

## Layout

- `scenarios.ts` - about 20 named cases (mixed Spanish and English)
- `checkers.ts` - reusable check functions
- `fakes.ts` / `fixtures.ts` / `harness.ts` - scripted clients, precedent PII fixtures, runner
- `../assistant.eval.spec.ts` - one `it` per scenario plus the citation checker self-test

## Running

```bash
npx jest src/domains/launchpad/assistant/assistant.eval.spec.ts
# or the whole Launchpad suite:
npx jest src/domains/launchpad
```

## Later: live model runs

The same `EVAL_SCENARIOS` and checkers can drive a live run later:

1. Keep scenario inputs (messages, form, documents, RAG fixtures or a real RAG).
2. Replace the scripted Anthropic client with a real one (requires `ANTHROPIC_API_KEY`).
3. Drop the scripted `script` rounds; let the model choose tools and write the final answer.
4. Reuse `checkToolTrace` (offered tools, and called tools from the capture), `checkCitationValidity` on the real answer (this becomes a model-quality signal), `checkKbUnavailable`, `checkPermissions`, and `checkInjection`.

Pin scenario ids when you add cases so diffs stay reviewable over time.
