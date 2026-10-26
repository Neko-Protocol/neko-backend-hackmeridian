import { AssistantService } from "../assistant.service";
import type { AssistantChatDto } from "../dto/assistant-chat.dto";
import {
  assertCheck,
  checkCitationValidity,
  checkInjection,
  checkKbUnavailable,
  checkPermissions,
  checkToolTrace,
  resolveCalledTools,
} from "./checkers";
import {
  createEvalConfig,
  createFakeAccounts,
  createFakeAnthropic,
  createFakeRag,
  createFakeResponse,
  createFakeStorage,
  createPrecedentsService,
  type FakeAnthropic,
  type CapturedSseEvent,
} from "./fakes";
import { PRECEDENT_FIXTURE_ROWS } from "./fixtures";
import type { EvalScenario } from "./scenarios";

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACCESS_TOKEN = "eval-access-token";

export interface ScenarioRun {
  scenario: EvalScenario;
  anthropic: FakeAnthropic;
  events: CapturedSseEvent[];
  finalAnswer: string;
  calledTools: string[];
}

export async function runScenario(scenario: EvalScenario): Promise<ScenarioRun> {
  const anthropic = createFakeAnthropic(scenario.script);
  const rag = createFakeRag(scenario.rag);
  const precedents = createPrecedentsService(PRECEDENT_FIXTURE_ROWS);
  const storage = createFakeStorage(scenario.documents ?? []);
  const service = new AssistantService(
    createEvalConfig(),
    createFakeAccounts(),
    storage,
    rag,
    precedents
  );
  (service as unknown as { client: unknown }).client = anthropic.client;

  const { res, events } = createFakeResponse();
  const dto: AssistantChatDto = {
    session_id: SESSION_ID,
    messages: scenario.messages,
    form: scenario.form,
    active_field: scenario.active_field,
  };

  await service.streamChat(ACCESS_TOKEN, dto, res);

  const finalAnswer = events
    .filter((e) => e.type === "text" && typeof e.text === "string")
    .map((e) => e.text as string)
    .join("");

  const scriptedCalls = scenario.script
    .filter((round) => round.kind === "tool_use")
    .flatMap((round) =>
      round.kind === "tool_use" ? round.tools.map((tool) => tool.name) : []
    );

  return {
    scenario,
    anthropic,
    events,
    finalAnswer,
    calledTools: resolveCalledTools(anthropic, scriptedCalls),
  };
}

/** Apply the scenario's declared checkers. */
export function evaluateScenario(run: ScenarioRun): void {
  const { scenario, anthropic, events, finalAnswer, calledTools } = run;

  assertCheck(
    checkToolTrace(anthropic, scenario.expect.toolTrace, calledTools)
  );

  if (scenario.expect.checkCitations) {
    assertCheck(
      checkCitationValidity(finalAnswer, anthropic.allToolResults)
    );
  }

  if (scenario.expect.kbUnavailable) {
    assertCheck(checkKbUnavailable(events, anthropic));
  }

  if (scenario.expect.checkPermissions) {
    assertCheck(checkPermissions(anthropic.allToolResults));
  }

  if (scenario.expect.injectionMarkers?.length) {
    assertCheck(
      checkInjection(anthropic, scenario.expect.injectionMarkers)
    );
  }
}
