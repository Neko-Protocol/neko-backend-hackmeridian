/**
 * Behaviour eval for the Launchpad issuer assistant.
 *
 * With a scripted Anthropic client, checks 1 (tool trace), 3 (KB unavailable),
 * 4 (permissions) and 5 (injection) test the backend's real behaviour.
 * Check 2 (citation validity) tests the checker and the plumbing that surfaces
 * tool results, not model quality. See eval/README.md.
 *
 * No network. No API keys. Anthropic and RAG are faked per scenario; precedents
 * use the real PrecedentsService over fixture rows from two other issuers.
 */

import {
  checkCitationValidity,
  extractCitations,
} from "./eval/checkers";
import { evaluateScenario, runScenario } from "./eval/harness";
import { EVAL_SCENARIOS } from "./eval/scenarios";
import { LEGAL_ARTICLE_HIT } from "./eval/fixtures";

describe("Launchpad assistant behaviour eval", () => {
  it("citation checker fails on a fabricated article ref (negative self-test)", () => {
    const answer = `According to Ley 9999, art. 99 and ${LEGAL_ARTICLE_HIT.citation}, you are fine. Also see P9.`;
    const toolResults = [
      {
        tool_use_id: "tu_1",
        content: LEGAL_ARTICLE_HIT.text,
      },
      {
        tool_use_id: "tu_2",
        content: JSON.stringify({
          cases: [{ ref: "P1", decision: "approved" }],
        }),
      },
    ];

    expect(extractCitations(answer)).toEqual(
      expect.arrayContaining(["Ley 9999, art. 99", LEGAL_ARTICLE_HIT.citation, "P9"])
    );

    const result = checkCitationValidity(answer, toolResults);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fabricated|unretrieved/i);
    expect(result.reason).toMatch(/Ley 9999/);
    expect(result.reason).toMatch(/P9/);
  });

  it("citation checker passes when every ref was retrieved", () => {
    const answer = `See ${LEGAL_ARTICLE_HIT.citation} and precedent P1.`;
    const result = checkCitationValidity(answer, [
      { tool_use_id: "a", content: LEGAL_ARTICLE_HIT.text },
      {
        tool_use_id: "b",
        content: JSON.stringify({ cases: [{ ref: "P1" }] }),
      },
    ]);
    expect(result).toEqual({ ok: true });
  });

  for (const scenario of EVAL_SCENARIOS) {
    it(`${scenario.id}: ${scenario.name}`, async () => {
      const run = await runScenario(scenario);
      evaluateScenario(run);
    });
  }
});
