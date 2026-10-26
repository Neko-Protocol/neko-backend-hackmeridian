import type { ConfigService } from "@nestjs/config";
import type { SupabaseService } from "@core/supabase/supabase.service";
import type { AccountsService } from "./accounts.service";
import { ApplicationsService } from "./applications.service";
import type { AssistantService } from "./assistant/assistant.service";
import type { ApplicationRow } from "./launchpad.types";

const TARGET: ApplicationRow = {
  id: "target",
  account_id: "account",
  status: "submitted",
  issuer_name: "Test issuer",
  issuer_country: "CR",
  asset_name: "Test harvest",
  asset_type: "agriculture",
  description: "Test proposal",
  target_amount: "1000.00",
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
  review_note: null,
  reviewed_by: null,
  reviewed_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function decided(
  id: string,
  changes: Partial<ApplicationRow> = {}
): ApplicationRow {
  return {
    ...TARGET,
    id,
    status: "approved",
    review_note: "Reviewed by an admin.",
    reviewed_at: "2026-01-02T00:00:00.000Z",
    ...changes,
  };
}

function setup(
  rows: ApplicationRow[],
  errors: { target?: boolean; cases?: boolean } = {}
) {
  const from = jest.fn(() => {
    const filters: Array<(row: ApplicationRow) => boolean> = [];
    const matching = () =>
      rows.filter((row) => filters.every((filter) => filter(row)));
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: (key: keyof ApplicationRow, value: unknown) => {
        filters.push((row) => row[key] === value);
        return query;
      },
      neq: (key: keyof ApplicationRow, value: unknown) => {
        filters.push((row) => row[key] !== value);
        return query;
      },
      in: (key: keyof ApplicationRow, values: unknown[]) => {
        filters.push((row) => values.includes(row[key]));
        return query;
      },
      order: jest.fn().mockReturnThis(),
      maybeSingle: async () => ({
        data: matching()[0] ?? null,
        error: errors.target ? { message: "lookup failed" } : null,
      }),
      range: async (start: number, end: number) => ({
        data: matching()
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(start, end + 1),
        error: errors.cases ? { message: "search failed" } : null,
      }),
    };
    return query;
  });
  const supabase = { client: { from } } as unknown as SupabaseService;
  const service = new ApplicationsService(
    supabase,
    {} as AccountsService,
    {} as AssistantService,
    {} as ConfigService
  );
  return { service, from };
}

describe("ApplicationsService.adminSimilar", () => {
  it("excludes the target, undecided proposals and zero-score cases", async () => {
    const { service } = setup([
      { ...TARGET, status: "approved" },
      decided("submitted", { status: "submitted" }),
      decided("in-review", { status: "in_review" }),
      decided("unrelated", {
        asset_type: "energy",
        offering_type: "public",
        issuer_country: "MX",
        target_amount: 5000,
        investor_countries: ["MX"],
        accepts_us_investors: true,
        uses_mass_marketing: true,
      }),
      decided("approved"),
      decided("rejected", { status: "rejected" }),
      decided("changes", { status: "changes_requested" }),
    ]);

    const result = await service.adminSimilar(TARGET.id);
    expect(result.cases.map((item) => item.id)).toEqual([
      "approved",
      "changes",
      "rejected",
    ]);
    expect(result.summary).toEqual({
      approved: 1,
      rejected: 1,
      changes_requested: 1,
    });
    expect(result.cases[0]).toEqual({
      id: "approved",
      asset_name: "Test harvest",
      asset_type: "agriculture",
      issuer_country: "CR",
      offering_type: "private",
      target_amount: 1000,
      currency: "USD",
      status: "approved",
      review_note: "Reviewed by an admin.",
      reviewed_at: "2026-01-02T00:00:00.000Z",
      score: 11,
      matched: expect.arrayContaining(["same asset type", "same country"]),
    });
  });

  it("ranks by score, then recency, and summarizes only the returned cases", async () => {
    const { service } = setup([
      TARGET,
      decided("low-score", {
        status: "rejected",
        asset_type: "energy",
        reviewed_at: "2026-01-05T00:00:00.000Z",
      }),
      decided("older"),
      decided("newer", {
        status: "changes_requested",
        reviewed_at: "2026-01-04T00:00:00.000Z",
      }),
    ]);
    const result = await service.adminSimilar(TARGET.id, 2);
    expect(result.cases.map((item) => item.id)).toEqual(["newer", "older"]);
    expect(result.summary).toEqual({
      approved: 1,
      rejected: 0,
      changes_requested: 1,
    });
  });

  it("searches past the first page before selecting the best five", async () => {
    const { service, from } = setup([
      TARGET,
      ...Array.from({ length: 500 }, (_, index) =>
        decided(`a-${String(index).padStart(3, "0")}`, { asset_type: "energy" })
      ),
      decided("z-best", { status: "rejected" }),
    ]);
    const result = await service.adminSimilar(TARGET.id);
    expect(result.cases).toHaveLength(5);
    expect(result.cases[0].id).toBe("z-best");
    expect(result.summary).toEqual({
      approved: 4,
      rejected: 1,
      changes_requested: 0,
    });
    expect(from).toHaveBeenCalledTimes(3);
  });

  it("returns empty memory without inventing cases", async () => {
    const { service } = setup([TARGET]);
    await expect(service.adminSimilar(TARGET.id)).resolves.toEqual({
      summary: { approved: 0, rejected: 0, changes_requested: 0 },
      cases: [],
    });
  });

  it("returns not found for a missing target", async () => {
    const { service } = setup([]);
    await expect(service.adminSimilar(TARGET.id)).rejects.toMatchObject({
      status: 404,
      response: { code: "APPLICATION_NOT_FOUND" },
    });
  });

  it.each([{ target: true }, { cases: true }])(
    "reports database failures instead of returning an empty memory: %j",
    async (errors) => {
      const { service } = setup([TARGET], errors);
      await expect(service.adminSimilar(TARGET.id)).rejects.toMatchObject({
        status: 500,
        response: { code: "DB_ERROR" },
      });
    }
  );
});
