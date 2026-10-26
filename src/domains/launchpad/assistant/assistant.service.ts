import Anthropic from "@anthropic-ai/sdk";
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { AccountsService } from "../accounts.service";
import {
  LaunchpadErrorCode,
  type LaunchpadAccountView,
} from "../launchpad.types";
import {
  AssistantStorageService,
  assistantFileType,
  type TranscriptTurn,
} from "./assistant-storage.service";
import { knownSimilarityFields } from "../application-similarity";
import { PrecedentsService } from "../precedents.service";
import {
  PRECEDENTS_TOOL,
  PRECEDENTS_TOOL_DEF,
  PROPOSE_TOOL,
  PROPOSE_TOOL_DEF,
  SUMMARY_PROMPT,
  SYSTEM_PROMPT,
  formContext,
  parseProposals,
  toolLabel,
  type Proposal,
} from "./assistant.prompt";
import { FIELD_BY_KEY } from "./assistant.fields";
import type { AssistantChatDto } from "./dto/assistant-chat.dto";
import { RAG_PREFIX, RagClient } from "./rag.client";

type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

const MAX_TOOL_ROUNDS = 8;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const BETAS = ["server-side-fallback-2026-07-01"];

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private client: Anthropic | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly accounts: AccountsService,
    private readonly storage: AssistantStorageService,
    private readonly rag: RagClient,
    private readonly precedents: PrecedentsService
  ) {}

  private get model(): string {
    return (
      this.config.get<string>("ANTHROPIC_MODEL")?.trim() || "claude-opus-5-5"
    );
  }

  private anthropic(): Anthropic {
    if (this.client) return this.client;
    const apiKey = this.config.get<string>("ANTHROPIC_API_KEY")?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException({
        code: "ASSISTANT_NOT_CONFIGURED",
        message:
          "The assistant isn't configured: set ANTHROPIC_API_KEY in the backend.",
      });
    }
    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  async verifiedAccount(accessToken: string): Promise<LaunchpadAccountView> {
    const account = await this.accounts.getByAccessToken(accessToken);
    if (account.verification.status !== "approved") {
      throw new ConflictException({
        code: LaunchpadErrorCode.ISSUER_NOT_VERIFIED,
      });
    }
    return account;
  }

  async openSession(accessToken: string, sessionId: string): Promise<string> {
    const account = await this.verifiedAccount(accessToken);
    const prefix = this.storage.prefix(account.account.id, sessionId);
    if (await this.storage.isClosed(prefix)) {
      throw new GoneException({ code: "SESSION_CLOSED" });
    }
    return prefix;
  }

  private async documentBlocks(prefix: string): Promise<ContentBlock[]> {
    const docs = await this.storage.listDocuments(prefix);
    if (docs.length === 0) return [];
    const blocks: ContentBlock[] = [];
    const skipped: string[] = [];
    let total = 0;

    for (const doc of docs) {
      const type = assistantFileType(doc.name);
      if (!type) continue;
      let data: Buffer;
      try {
        data = await this.storage.downloadDocument(doc.path);
      } catch {
        skipped.push(doc.name);
        continue;
      }
      if (total + data.length > MAX_DOCUMENT_BYTES) {
        skipped.push(doc.name);
        continue;
      }
      total += data.length;
      if (type.kind === "pdf") {
        blocks.push({
          type: "document",
          title: doc.name,
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: data.toString("base64"),
          },
        });
      } else if (type.kind === "text") {
        blocks.push({
          type: "document",
          title: doc.name,
          source: {
            type: "text",
            media_type: "text/plain",
            data: data.toString("utf8"),
          },
        });
      } else {
        blocks.push({ type: "text", text: `Image: ${doc.name}` });
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: type.mediaType as "image/png",
            data: data.toString("base64"),
          },
        });
      }
    }

    const last = blocks.at(-1);
    if (last && (last.type === "document" || last.type === "image")) {
      last.cache_control = { type: "ephemeral" };
    }
    blocks.unshift({
      type: "text",
      text: `The issuer shared ${docs.length} document(s) for this application${
        skipped.length
          ? ` (not loaded, too large or unavailable: ${skipped.join(", ")})`
          : ""
      }:`,
    });
    return blocks;
  }

  /** Streams the reply as server-sent events: notice, text, tool, proposal, break, error, done. */
  async streamChat(
    accessToken: string,
    dto: AssistantChatDto,
    res: Response
  ): Promise<void> {
    const prefix = await this.openSession(accessToken, dto.session_id);
    const client = this.anthropic();
    const turns = dto.messages.filter((m) => m.text.trim());
    if (turns.length === 0 || turns.at(-1)?.role !== "user") {
      throw new BadRequestException({ code: "INVALID_MESSAGES" });
    }
    const activeField =
      dto.active_field && FIELD_BY_KEY.has(dto.active_field)
        ? dto.active_field
        : null;

    let docs: ContentBlock[] = [];
    try {
      docs = await this.documentBlocks(prefix);
    } catch (err) {
      this.logger.warn(
        `Assistant documents unavailable: ${err instanceof Error ? err.message : err}`
      );
    }

    const ragTools = await this.rag.tools();
    const kbAvailable = ragTools.length > 0;

    // Documents on the first turn, live form context on the last: keeps the prefix cacheable.
    const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((turn, i) => {
      if (turn.role === "assistant")
        return { role: "assistant", content: turn.text };
      const content: ContentBlock[] = [];
      if (i === 0) content.push(...docs);
      content.push({ type: "text", text: turn.text });
      if (i === turns.length - 1) {
        content.push({
          type: "text",
          text: formContext(dto.form, activeField, { kbAvailable }),
        });
      }
      return { role: "user", content };
    });
    const tools = [PROPOSE_TOOL_DEF, PRECEDENTS_TOOL_DEF, ...ragTools];
    const trace = {
      started: Date.now(),
      tools: [] as string[],
      precedentRefs: [] as string[],
    };

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    // no-transform keeps the global compression middleware from buffering the stream.
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let replyText = "";
    const proposals: Proposal[] = [];
    if (!kbAvailable) {
      send({
        type: "notice",
        code: "KB_UNAVAILABLE",
        message:
          "The legal knowledge base is not reachable right now, so legal points in this reply are not verified against the law.",
      });
    }
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const stream = client.beta.messages.stream(
          {
            model: this.model,
            max_tokens: 16000,
            system: [
              {
                type: "text",
                text: SYSTEM_PROMPT,
                cache_control: { type: "ephemeral" },
              },
            ],
            messages,
            tools,
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            betas: BETAS,
            fallbacks: "default",
          },
          { signal: abort.signal }
        );
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            replyText += event.delta.text;
            send({ type: "text", text: event.delta.text });
          }
        }
        const message = await stream.finalMessage();

        if (message.stop_reason === "refusal") {
          send({
            type: "error",
            message:
              "I can't help with that one. Try rephrasing your question.",
          });
          break;
        }
        const toolUses = message.content.filter(
          (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use"
        );
        // max_tokens may have cut a tool input short.
        if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

        messages.push({ role: "assistant", content: message.content });
        const results = await Promise.all(
          toolUses.map(
            async (use): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
              if (use.name === PROPOSE_TOOL) {
                const parsed = parseProposals(use.input);
                if (!parsed) {
                  return {
                    type: "tool_result",
                    tool_use_id: use.id,
                    is_error: true,
                    content:
                      "Invalid input: expected { proposals: [{ field, value, reason }] } with field keys from the form.",
                  };
                }
                proposals.push(...parsed);
                send({ type: "proposal", id: use.id, proposals: parsed });
                return {
                  type: "tool_result",
                  tool_use_id: use.id,
                  content:
                    "Shown to the issuer with Apply buttons. They decide whether to apply each value.",
                };
              }
              trace.tools.push(use.name);
              if (use.name === PRECEDENTS_TOOL) {
                send({ type: "tool", label: toolLabel(use.name, use.input) });
                return this.precedentsResult(use.id, dto.form, trace);
              }
              if (use.name.startsWith(RAG_PREFIX)) {
                send({ type: "tool", label: toolLabel(use.name, use.input) });
                const input =
                  use.input && typeof use.input === "object"
                    ? (use.input as Record<string, unknown>)
                    : {};
                const result = await this.rag.call(use.name, input);
                return {
                  type: "tool_result",
                  tool_use_id: use.id,
                  is_error: result.isError,
                  content: result.text,
                };
              }
              return {
                type: "tool_result",
                tool_use_id: use.id,
                is_error: true,
                content: `Unknown tool ${use.name}`,
              };
            }
          )
        );
        messages.push({ role: "user", content: results });
        replyText += "\n\n";
        send({ type: "break" });
      }
      send({ type: "done" });
    } catch (err) {
      if (!abort.signal.aborted) {
        this.logger.error(
          `Assistant chat failed: ${err instanceof Error ? err.message : err}`
        );
        send({
          type: "error",
          message:
            err instanceof Anthropic.RateLimitError
              ? "The assistant is busy right now. Try again in a moment."
              : err instanceof Anthropic.APIError
                ? `The assistant request failed (${err.status ?? "network"}). Try again.`
                : "Something went wrong talking to the assistant. Try again.",
        });
      }
    } finally {
      res.end();
      // Trace without form values or text: which tools ran and what they returned.
      this.logger.log({
        event: "launchpad_assistant_turn",
        session: dto.session_id,
        model: this.model,
        kb_available: kbAvailable,
        tools: trace.tools,
        precedent_refs: trace.precedentRefs,
        proposals: proposals.length,
        ms: Date.now() - trace.started,
      });
    }

    if (!abort.signal.aborted && (replyText.trim() || proposals.length)) {
      const suggested = proposals.length
        ? `\n\n[Suggested: ${proposals.map((p) => `${p.field} = ${JSON.stringify(p.value)}`).join("; ")}]`
        : "";
      const record: TranscriptTurn[] = [
        { role: "user", text: turns.at(-1)!.text },
        { role: "assistant", text: `${replyText.trim()}${suggested}` },
      ];
      await this.storage
        .appendTranscript(prefix, record)
        .catch((err) =>
          this.logger.warn(
            `Transcript not saved: ${err instanceof Error ? err.message : err}`
          )
        );
    }
  }

  private async precedentsResult(
    toolUseId: string,
    form: Record<string, unknown>,
    trace: { precedentRefs: string[] }
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    try {
      const result = await this.precedents.forIssuer(
        knownSimilarityFields(form)
      );
      trace.precedentRefs.push(...result.cases.map((c) => c.ref));
      const note =
        result.basis.length === 0
          ? "The form has none of the fields the search uses yet. Ask the issuer for the asset type, country and offering details first."
          : result.cases.length === 0
            ? "No decided case matches the known fields. Say there is no comparable precedent yet; do not infer an outcome."
            : "Precedents are earlier human decisions, not law and not a prediction. Cite refs, say what matched and what differs.";
      return {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: JSON.stringify({ ...result, note }),
      };
    } catch (err) {
      this.logger.warn(
        `Precedent search failed: ${err instanceof Error ? err.message : err}`
      );
      return {
        type: "tool_result",
        tool_use_id: toolUseId,
        is_error: true,
        content:
          "Precedent search is unavailable right now. Tell the issuer you could not check past decisions.",
      };
    }
  }

  /** Ends the session when the application is submitted and returns what was said. */
  async finishSession(
    accountId: string,
    sessionId: string
  ): Promise<TranscriptTurn[]> {
    const prefix = this.storage.prefix(accountId, sessionId);
    const transcript = await this.storage.readTranscript(prefix);
    await this.storage.closeSession(prefix);
    return transcript;
  }

  /** One paragraph for the compliance reviewer, or null when it can't be written. */
  async reviewSummary(
    application: unknown,
    transcript: TranscriptTurn[]
  ): Promise<string | null> {
    if (!this.config.get<string>("ANTHROPIC_API_KEY")?.trim()) return null;
    const conversation = transcript
      .slice(-40)
      .map(
        (m) =>
          `${m.role === "user" ? "Issuer" : "Assistant"}: ${m.text.slice(0, 2000)}`
      )
      .join("\n\n");
    try {
      const message = await this.anthropic().beta.messages.create({
        model: this.model,
        max_tokens: 2000,
        output_config: { effort: "low" },
        betas: BETAS,
        fallbacks: "default",
        system: SUMMARY_PROMPT,
        messages: [
          {
            role: "user",
            content: `Application:\n${JSON.stringify(application)}\n\nConversation with the assistant:\n${conversation || "(none)"}`,
          },
        ],
      });
      if (message.stop_reason === "refusal") return null;
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return text ? text.slice(0, 4000) : null;
    } catch (err) {
      this.logger.warn(
        `Review summary failed: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }
}
