import type { ApplicationRow } from "./launchpad.types";

export type ApplicationSimilarityFields = Pick<
  ApplicationRow,
  | "asset_type"
  | "offering_type"
  | "issuer_country"
  | "target_amount"
  | "investor_countries"
  | "accepts_us_investors"
  | "uses_mass_marketing"
>;

/** A target where a field the issuer has not answered yet is simply missing. */
export type PartialSimilarityFields = Partial<ApplicationSimilarityFields>;

export const SIMILARITY_FIELDS: readonly (keyof ApplicationSimilarityFields)[] =
  [
    "asset_type",
    "offering_type",
    "issuer_country",
    "target_amount",
    "investor_countries",
    "accepts_us_investors",
    "uses_mass_marketing",
  ];

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * Keeps only the similarity fields the form actually holds, with the right
 * type. Empty strings, empty lists and non-positive amounts count as unknown,
 * so a default value never turns into a match.
 */
export function knownSimilarityFields(
  form: Record<string, unknown>
): PartialSimilarityFields {
  const known: PartialSimilarityFields = {};
  if (nonEmptyString(form.asset_type))
    known.asset_type = form.asset_type as ApplicationRow["asset_type"];
  if (nonEmptyString(form.offering_type))
    known.offering_type = form.offering_type as ApplicationRow["offering_type"];
  if (nonEmptyString(form.issuer_country))
    known.issuer_country = form.issuer_country.toUpperCase();
  const amount = Number(form.target_amount);
  if (form.target_amount !== "" && Number.isFinite(amount) && amount > 0)
    known.target_amount = amount;
  if (
    Array.isArray(form.investor_countries) &&
    form.investor_countries.some(nonEmptyString)
  )
    known.investor_countries = form.investor_countries
      .filter(nonEmptyString)
      .map((c) => c.toUpperCase());
  if (typeof form.accepts_us_investors === "boolean")
    known.accepts_us_investors = form.accepts_us_investors;
  if (typeof form.uses_mass_marketing === "boolean")
    known.uses_mass_marketing = form.uses_mass_marketing;
  return known;
}

export function scoreApplicationSimilarity(
  target: PartialSimilarityFields,
  candidate: ApplicationSimilarityFields
): { score: number; matched: string[] } {
  const { score, matched } = compareApplications(target, candidate);
  return { score, matched };
}

/** Same weights as the score, plus the known fields that do not match. */
export function compareApplications(
  target: PartialSimilarityFields,
  candidate: ApplicationSimilarityFields
): { score: number; matched: string[]; differs: string[] } {
  let score = 0;
  const matched: string[] = [];
  const differs: string[] = [];
  // A criterion only counts when the target knows that field.
  const compare = (
    known: boolean,
    condition: boolean,
    points: number,
    reason: string,
    difference: string
  ) => {
    if (!known) return;
    if (condition) {
      score += points;
      matched.push(reason);
    } else {
      differs.push(difference);
    }
  };

  compare(
    target.asset_type != null,
    target.asset_type === candidate.asset_type,
    3,
    "same asset type",
    "different asset type"
  );
  compare(
    target.offering_type != null,
    target.offering_type === candidate.offering_type,
    2,
    "same offering type",
    "different offering type"
  );
  compare(
    target.issuer_country != null,
    target.issuer_country === candidate.issuer_country,
    2,
    "same country",
    "different issuer country"
  );

  const targetAmount = Number(target.target_amount);
  const candidateAmount = Number(candidate.target_amount);
  compare(
    target.target_amount != null &&
      Number.isFinite(targetAmount) &&
      targetAmount > 0,
    Number.isFinite(candidateAmount) &&
      candidateAmount >= targetAmount * 0.5 &&
      candidateAmount <= targetAmount * 2,
    1,
    "similar target amount",
    "target amount more than twice as large or less than half"
  );
  compare(
    Array.isArray(target.investor_countries) &&
      target.investor_countries.length > 0,
    (target.investor_countries ?? []).some((country) =>
      (candidate.investor_countries ?? []).includes(country)
    ),
    1,
    "overlapping investor countries",
    "no investor country in common"
  );
  compare(
    typeof target.accepts_us_investors === "boolean",
    target.accepts_us_investors === candidate.accepts_us_investors,
    1,
    "same US investor policy",
    "different US investor policy"
  );
  compare(
    typeof target.uses_mass_marketing === "boolean",
    target.uses_mass_marketing === candidate.uses_mass_marketing,
    1,
    "same mass marketing policy",
    "different mass marketing policy"
  );

  return { score, matched, differs };
}
