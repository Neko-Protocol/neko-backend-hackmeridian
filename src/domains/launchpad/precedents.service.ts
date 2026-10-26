import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { ErrorCode } from "@neko-protocol/api-contracts";
import { SupabaseService } from "@core/supabase/supabase.service";
import {
  SIMILARITY_FIELDS,
  compareApplications,
  type ApplicationSimilarityFields,
  type PartialSimilarityFields,
} from "./application-similarity";
import type {
  ApplicationRow,
  DecidedApplicationStatus,
} from "./launchpad.types";

export const PRECEDENT_COLUMNS = [
  "id",
  "asset_name",
  "asset_type",
  "issuer_country",
  "offering_type",
  "target_amount",
  "currency",
  "status",
  "review_note",
  "reviewed_at",
  "investor_countries",
  "accepts_us_investors",
  "uses_mass_marketing",
].join(",");

const DECIDED: DecidedApplicationStatus[] = [
  "approved",
  "rejected",
  "changes_requested",
];

export type PrecedentRow = Pick<
  ApplicationRow,
  | "id"
  | "asset_name"
  | "currency"
  | "review_note"
  | "reviewed_at"
  | keyof ApplicationSimilarityFields
> & { status: DecidedApplicationStatus };

export interface ScoredPrecedent {
  row: PrecedentRow;
  score: number;
  matched: string[];
  differs: string[];
}

/** What another issuer's assistant may see about a decided case. */
export interface IssuerPrecedent {
  ref: string;
  decision: DecidedApplicationStatus;
  decided_month: string | null;
  asset_type: string;
  offering_type: string;
  issuer_country: string;
  amount_band: string;
  matched: string[];
  differs: string[];
}

export interface IssuerPrecedentsResult {
  basis: string[];
  unknown: string[];
  summary: Record<DecidedApplicationStatus, number>;
  cases: IssuerPrecedent[];
}

export function amountBand(amount: unknown): string {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n < 50_000) return "under 50k";
  if (n < 250_000) return "50k to 250k";
  if (n < 1_000_000) return "250k to 1M";
  return "1M or more";
}

/**
 * Decided applications ranked by fixed-weight similarity. One search serves
 * two readers with different permissions: the admin review screen gets the
 * full rows, an issuer's assistant gets `forIssuer`, which drops names, ids,
 * reviewer notes and exact amounts of other issuers' proposals.
 */
@Injectable()
export class PrecedentsService {
  private readonly logger = new Logger(PrecedentsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async search(
    target: PartialSimilarityFields,
    options: { excludeId?: string; limit?: number } = {}
  ): Promise<ScoredPrecedent[]> {
    const limit = options.limit ?? 5;
    let found: ScoredPrecedent[] = [];
    // Page through all decisions so Supabase's row cap cannot hide better matches.
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      let query = this.supabase.client
        .from("launchpad_applications")
        .select(PRECEDENT_COLUMNS)
        .in("status", DECIDED);
      if (options.excludeId) query = query.neq("id", options.excludeId);
      const { data, error } = await query
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw this.dbError("application_similar_cases", error);

      const rows = (data ?? []) as unknown as PrecedentRow[];
      for (const row of rows) {
        const comparison = compareApplications(target, row);
        if (comparison.score === 0) continue;
        found.push({ row, ...comparison });
      }
      found = found
        .sort(
          (a, b) =>
            b.score - a.score ||
            (b.row.reviewed_at ?? "").localeCompare(a.row.reviewed_at ?? "") ||
            a.row.id.localeCompare(b.row.id)
        )
        .slice(0, limit);
      if (rows.length < pageSize) break;
    }
    return found;
  }

  /** The issuer-safe view used by the Launchpad assistant before submission. */
  async forIssuer(
    form: PartialSimilarityFields,
    limit = 5
  ): Promise<IssuerPrecedentsResult> {
    const basis = SIMILARITY_FIELDS.filter((k) => form[k] !== undefined);
    const unknown = SIMILARITY_FIELDS.filter((k) => form[k] === undefined);
    const summary = { approved: 0, rejected: 0, changes_requested: 0 };
    if (basis.length === 0) return { basis, unknown, summary, cases: [] };

    const found = await this.search(form, { limit });
    const cases = found.map(({ row, matched, differs }, i) => {
      summary[row.status] += 1;
      return {
        ref: `P${i + 1}`,
        decision: row.status,
        decided_month: row.reviewed_at ? row.reviewed_at.slice(0, 7) : null,
        asset_type: row.asset_type,
        offering_type: row.offering_type,
        issuer_country: row.issuer_country,
        amount_band: amountBand(row.target_amount),
        matched,
        differs,
      };
    });
    return { basis, unknown, summary, cases };
  }

  private dbError(op: string, error: unknown) {
    this.logger.error({ event: "launchpad_application_db_error", op, error });
    return new InternalServerErrorException({ code: ErrorCode.DB_ERROR });
  }
}
