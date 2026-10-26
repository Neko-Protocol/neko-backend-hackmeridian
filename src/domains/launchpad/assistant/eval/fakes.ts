import type Anthropic from "@anthropic-ai/sdk";
import type { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import type { SupabaseService } from "@core/supabase/supabase.service";
import type { AccountsService } from "../../accounts.service";
import type { ApplicationRow } from "../../launchpad.types";
import type { LaunchpadAccountView } from "../../launchpad.types";
import {
  AssistantStorageService,
  type SessionDocument,
} from "../assistant-storage.service";
import { RAG_PREFIX, RagClient } from "../rag.client";
import { PrecedentsService } from "../../precedents.service";

export interface ScriptedToolUse {
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

export type ScriptedRound =
  | { kind: "tool_use"; tools: ScriptedToolUse[] }
  | { kind: "text"; text: string };

export interface CapturedToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface CapturedModelCall {
  system: string;
  toolNames: string[];
  messages: Anthropic.Beta.BetaMessageParam[];
  toolResults: CapturedToolResult[];
}

export interface FakeAnthropic {
  client: Anthropic;
  calls: CapturedModelCall[];
  /** All tool_result blocks the service sent across rounds. */
  allToolResults: CapturedToolResult[];
  systemPrompt: string;
  offeredToolNames: string[];
}

function betaToolDisplayName(tool: Anthropic.Beta.BetaToolUnion): string {
  return "name" in tool
    ? tool.name
    : "mcp_server_name" in tool
      ? tool.mcp_server_name
      : tool.type;
}

function extractSystem(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((block) =>
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
        ? (block as { text: string }).text
        : ""
    )
    .join("\n");
}

function extractToolResults(
  messages: Anthropic.Beta.BetaMessageParam[]
): CapturedToolResult[] {
  const out: CapturedToolResult[] = [];
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "tool_result"
      ) {
        const content =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        out.push({
          tool_use_id: block.tool_use_id,
          content,
          is_error: block.is_error,
        });
      }
    }
  }
  return out;
}

function streamFromRound(round: ScriptedRound) {
  const events: Anthropic.Beta.BetaRawMessageStreamEvent[] = [];
  if (round.kind === "text") {
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: round.text },
    } as Anthropic.Beta.BetaRawMessageStreamEvent);
  }

  const message =
    round.kind === "tool_use"
      ? {
          id: "msg_eval",
          type: "message" as const,
          role: "assistant" as const,
          model: "fake-eval",
          stop_reason: "tool_use" as const,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: round.tools.map((tool) => ({
            type: "tool_use" as const,
            id: tool.id,
            name: tool.name,
            input: tool.input ?? {},
          })),
        }
      : {
          id: "msg_eval",
          type: "message" as const,
          role: "assistant" as const,
          model: "fake-eval",
          stop_reason: "end_turn" as const,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text" as const, text: round.text }],
        };

  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    finalMessage: async () => message,
  };
}

/** Anthropic client that replays a fixed round sequence and records every call. */
export function createFakeAnthropic(script: ScriptedRound[]): FakeAnthropic {
  const calls: CapturedModelCall[] = [];
  let roundIndex = 0;

  const stream = (
    params: Anthropic.Beta.MessageCreateParams
  ): ReturnType<typeof streamFromRound> => {
    if (roundIndex >= script.length) {
      throw new Error(
        `Fake Anthropic: no scripted round left (already played ${roundIndex})`
      );
    }
    const toolNames = (params.tools ?? []).map(betaToolDisplayName);
    const messages = params.messages ?? [];
    const toolResults = extractToolResults(messages);
    calls.push({
      system: extractSystem(params.system),
      toolNames,
      messages,
      toolResults,
    });
    const round = script[roundIndex++];
    return streamFromRound(round);
  };

  const client = {
    beta: {
      messages: { stream },
    },
  } as unknown as Anthropic;

  return {
    client,
    calls,
    get allToolResults() {
      return calls.flatMap((call) => call.toolResults);
    },
    get systemPrompt() {
      return calls[0]?.system ?? "";
    },
    get offeredToolNames() {
      return calls[0]?.toolNames ?? [];
    },
  };
}

export interface FakeRagConfig {
  /** When false, tools() returns [] (KB down / discovery failure). */
  available: boolean;
  tools?: Array<{ name: string; description?: string }>;
  /** Answers keyed by unprefixed tool name (e.g. search_law). */
  answers?: Record<string, { text: string; isError?: boolean }>;
}

export function createFakeRag(config: FakeRagConfig): RagClient {
  const tools = config.tools ?? [
    {
      name: "search_law",
      description: "Search securities and compliance norms",
    },
    {
      name: "get_article",
      description: "Fetch a single article by norm and number",
    },
  ];
  const answers = config.answers ?? {};

  return {
    async tools() {
      if (!config.available) return [];
      return tools
        .map((tool) => ({
          name: `${RAG_PREFIX}${tool.name}`.slice(0, 64),
          description: `Knowledge base: ${tool.description ?? tool.name}`,
          input_schema: { type: "object" as const },
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async call(prefixedName: string, _args: Record<string, unknown>) {
      const name = prefixedName.startsWith(RAG_PREFIX)
        ? prefixedName.slice(RAG_PREFIX.length)
        : prefixedName;
      const hit = answers[name];
      if (!hit) return { text: "(no results)", isError: false };
      return { text: hit.text, isError: Boolean(hit.isError) };
    },
  } as unknown as RagClient;
}

export function supabaseWithRows(
  rows: ApplicationRow[],
  fail = false
): SupabaseService {
  const from = jest.fn(() => {
    const filters: Array<(row: ApplicationRow) => boolean> = [];
    const query = {
      select: jest.fn().mockReturnThis(),
      in: (key: keyof ApplicationRow, values: unknown[]) => {
        filters.push((row) => values.includes(row[key]));
        return query;
      },
      neq: (key: keyof ApplicationRow, value: unknown) => {
        filters.push((row) => row[key] !== value);
        return query;
      },
      order: jest.fn().mockReturnThis(),
      range: async (start: number, end: number) => ({
        data: rows
          .filter((row) => filters.every((f) => f(row)))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(start, end + 1),
        error: fail ? { message: "down" } : null,
      }),
    };
    return query;
  });
  return { client: { from } } as unknown as SupabaseService;
}

export function createPrecedentsService(
  rows: ApplicationRow[]
): PrecedentsService {
  return new PrecedentsService(supabaseWithRows(rows));
}

const ACCOUNT: LaunchpadAccountView = {
  account: {
    id: "acct-eval-issuer",
    email: "issuer@eval.example",
    display_name: "Eval Issuer",
    privy_user_id: "privy-eval",
  },
  verification: {
    id: "ver-eval",
    kind: "kyb",
    provider: "mock",
    status: "approved",
    full_name: null,
    business_name: "Eval Issuer SA",
    country: "CR",
    claimed: true,
  },
  wallet: {
    address: "GEVAL...",
    network: "testnet",
    funded: true,
    funding_tx_hash: null,
  },
};

export function createFakeAccounts(): AccountsService {
  return {
    getByAccessToken: async () => ACCOUNT,
  } as unknown as AccountsService;
}

export interface FakeDocument {
  name: string;
  text: string;
}

export function createFakeStorage(
  documents: FakeDocument[] = []
): AssistantStorageService {
  const byPath = new Map<string, Buffer>();
  const listed: SessionDocument[] = documents.map((doc, i) => {
    const path = `acct-eval-issuer/session/${String(i).padStart(2, "0")}__${doc.name}`;
    byPath.set(path, Buffer.from(doc.text, "utf8"));
    return {
      path,
      name: doc.name,
      size: Buffer.byteLength(doc.text, "utf8"),
      mediaType: "text/plain",
    };
  });

  return {
    prefix(accountId: string, sessionId: string) {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
        throw new Error("INVALID_SESSION");
      }
      return `${accountId}/${sessionId}`;
    },
    isClosed: async () => false,
    listDocuments: async () => listed,
    downloadDocument: async (path: string) => {
      const data = byPath.get(path);
      if (!data) throw new Error("DOWNLOAD_FAILED");
      return data;
    },
    appendTranscript: async () => undefined,
  } as unknown as AssistantStorageService;
}

export function createEvalConfig(): ConfigService {
  return {
    get: (key: string) => {
      if (key === "ANTHROPIC_API_KEY") return "eval-fake-key";
      if (key === "ANTHROPIC_MODEL") return "fake-eval-model";
      return undefined;
    },
  } as unknown as ConfigService;
}

export interface CapturedSseEvent {
  type: string;
  [key: string]: unknown;
}

/** Minimal Express response that records SSE `data:` frames. */
export function createFakeResponse(): {
  res: Response;
  events: CapturedSseEvent[];
} {
  const events: CapturedSseEvent[] = [];
  let ended = false;
  const res = {
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write(chunk: string) {
      const text = String(chunk);
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          events.push(JSON.parse(line.slice(6)) as CapturedSseEvent);
        } catch {
          /* ignore malformed */
        }
      }
      return true;
    },
    end: jest.fn(() => {
      ended = true;
    }),
    on: jest.fn(),
    get writableEnded() {
      return ended;
    },
  };
  return { res: res as unknown as Response, events };
}
