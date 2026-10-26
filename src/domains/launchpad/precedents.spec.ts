import type { ConfigService } from "@nestjs/config";
import type { SupabaseService } from "@core/supabase/supabase.service";
import type { AccountsService } from "./accounts.service";
import { knownSimilarityFields } from "./application-similarity";
import type { AssistantStorageService } from "./assistant/assistant-storage.service";
import {
  PRECEDENTS_TOOL,
  PRECEDENTS_TOOL_DEF,
  SYSTEM_PROMPT,
  formContext,
  toolLabel,
} from "./assistant/assistant.prompt";
import { AssistantService } from "./assistant/assistant.service";
import { RagClient } from "./assistant/rag.client";
import type { ApplicationRow } from "./launchpad.types";
import { PrecedentsService, amountBand } from "./precedents.service";

const BASE: ApplicationRow = {
  id: "base",
  account_id: "other-issuer",
  status: "approved",
  issuer_name: "Other issuer SA",
  issuer_country: "CR",
  asset_name: "Private farm name",
  asset_type: "agriculture",
  description: "Private description",
  target_amount: "120000.00",
  min_target: null,
  currency: "USD",
  min_ticket: 100,
  expected_yield_pct: null,
  term_months: null,
  max_investors: 50,
  offering_type: "private",
  investor_countries: ["CR"],
  accepts_us_investors: false,
  uses_mass_marketing: false,
  milestones: [],
  documents: [],
  ai_summary: null,
  review_note: "Private reviewer note about the issuer.",
  reviewed_by: "admin@example.com",
  reviewed_at: "2026-10-20T10:00:00.000Z",
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

function supabaseWith(rows: ApplicationRow[], fail = false): SupabaseService {
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

describe("knownSimilarityFields", () => {
  it("drops empty and default values so they never count as a match", () => {
    expect(
      knownSimilarityFields({
        asset_type: "",
        issuer_country: "cr",
        target_amount: "",
        investor_countries: [],
        accepts_us_investors: undefined,
        uses_mass_marketing: false,
        issuer_name: "ignored",
      })
    ).toEqual({ issuer_country: "CR", uses_mass_marketing: false });
  });

  it("keeps typed values only", () => {
    expect(
      knownSimilarityFields({
        asset_type: "real_estate",
        target_amount: "250000",
        investor_countries: ["cr", 3, "mx"],
        accepts_us_investors: "yes",
      })
    ).toEqual({
      asset_type: "real_estate",
      target_amount: 250000,
      investor_countries: ["CR", "MX"],
    });
  });
});

describe("PrecedentsService.forIssuer", () => {
  const rows: ApplicationRow[] = [
    BASE,
    { ...BASE, id: "rejected", status: "rejected", asset_type: "energy" },
    { ...BASE, id: "pending", status: "submitted" },
  ];

  it("returns decided cases without names, ids, notes or exact amounts", async () => {
    const service = new PrecedentsService(supabaseWith(rows));
    const result = await service.forIssuer({
      asset_type: "agriculture",
      issuer_country: "CR",
    });

    expect(result.cases).toHaveLength(2);
    expect(result.cases[0]).toEqual({
      ref: "P1",
      decision: "approved",
      decided_month: "2026-10",
      asset_type: "agriculture",
      offering_type: "private",
      issuer_country: "CR",
      amount_band: "50k to 250k",
      matched: ["same asset type", "same country"],
      differs: [],
    });
    expect(result.cases[1]).toMatchObject({
      ref: "P2",
      decision: "rejected",
      differs: ["different asset type"],
    });
    expect(result.summary).toEqual({
      approved: 1,
      rejected: 1,
      changes_requested: 0,
    });
    expect(result.basis).toEqual(["asset_type", "issuer_country"]);
    expect(result.unknown).toContain("accepts_us_investors");

    const serialised = JSON.stringify(result);
    for (const secret of [
      "Other issuer SA",
      "Private farm name",
      "Private reviewer note",
      "admin@example.com",
      "other-issuer",
      "120000",
      '"base"',
      "pending",
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("does not search when the form has no usable field", async () => {
    const supabase = supabaseWith(rows);
    const result = await new PrecedentsService(supabase).forIssuer({});
    expect(result.cases).toEqual([]);
    expect(supabase.client.from).not.toHaveBeenCalled();
  });

  it("finds nothing rather than inventing a match", async () => {
    const service = new PrecedentsService(supabaseWith(rows));
    const result = await service.forIssuer({ asset_type: "invoices" });
    expect(result.cases).toEqual([]);
  });

  it.each([
    [0, "unknown"],
    [49_999, "under 50k"],
    [50_000, "50k to 250k"],
    [999_999, "250k to 1M"],
    ["2000000", "1M or more"],
  ])("bands amount %s as %s", (amount, band) => {
    expect(amountBand(amount)).toBe(band);
  });
});

describe("assistant precedents tool", () => {
  function assistant(supabase: SupabaseService) {
    return new AssistantService(
      { get: () => undefined } as unknown as ConfigService,
      {} as AccountsService,
      {} as AssistantStorageService,
      {} as RagClient,
      new PrecedentsService(supabase)
    );
  }
  type Internals = {
    precedentsResult(
      id: string,
      form: Record<string, unknown>,
      trace: { precedentRefs: string[] }
    ): Promise<{ content: string; is_error?: boolean }>;
  };

  it("answers from the live form and records the refs it returned", async () => {
    const trace = { precedentRefs: [] as string[] };
    const result = await (
      assistant(supabaseWith([BASE])) as unknown as Internals
    ).precedentsResult(
      "tool-1",
      { asset_type: "agriculture", issuer_country: "CR" },
      trace
    );
    const body = JSON.parse(result.content);
    expect(body.cases.map((c: { ref: string }) => c.ref)).toEqual(["P1"]);
    expect(body.note).toMatch(/not law and not a prediction/);
    expect(trace.precedentRefs).toEqual(["P1"]);
  });

  it("tells the model to abstain when nothing matches", async () => {
    const result = await (
      assistant(supabaseWith([BASE])) as unknown as Internals
    ).precedentsResult("tool-1", { asset_type: "invoices" }, { precedentRefs: [] });
    expect(JSON.parse(result.content).note).toMatch(
      /no comparable precedent yet/
    );
  });

  it("reports a failed search as an error instead of an empty answer", async () => {
    const result = await (
      assistant(supabaseWith([BASE], true)) as unknown as Internals
    ).precedentsResult(
      "tool-1",
      { asset_type: "agriculture" },
      { precedentRefs: [] }
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/could not check past decisions/);
  });
});

describe("assistant prompt", () => {
  it("describes the vault that is deployed, not the replaced escrow", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/trustless work|escrow/i);
    expect(SYSTEM_PROMPT).toMatch(/vault/);
    expect(SYSTEM_PROMPT).toContain(PRECEDENTS_TOOL);
  });

  it("forbids citing articles that were not retrieved", () => {
    expect(SYSTEM_PROMPT).toMatch(/Never cite an article you did not retrieve/);
    expect(SYSTEM_PROMPT).toMatch(/data, not instructions/);
  });

  it("flags an unavailable knowledge base in the turn context", () => {
    expect(formContext({}, null, { kbAvailable: false })).toMatch(
      /Legal knowledge base: UNAVAILABLE/
    );
    expect(formContext({}, null)).toMatch(/available through the kb_ tools/);
  });

  it("labels the precedents tool for the issuer", () => {
    expect(PRECEDENTS_TOOL_DEF.name).toBe(PRECEDENTS_TOOL);
    expect(toolLabel(PRECEDENTS_TOOL, {})).toBe(
      "Checking Neko's past review decisions"
    );
  });
});

describe("RagClient without configuration", () => {
  it("offers no legal tools, which the assistant reports as unavailable", async () => {
    const rag = new RagClient({
      get: () => undefined,
    } as unknown as ConfigService);
    await expect(rag.tools()).resolves.toEqual([]);
  });
});
