import type { VerificationStatus } from "@core/didit/didit.service";

/** The Launchpad demo runs on testnet regardless of the backend's STELLAR_NETWORK. */
export const LAUNCHPAD_NETWORK = "testnet" as const;

export const CLAIM_TOKEN_HEADER = "x-claim-token";

export type VerificationKind = "kyc" | "kyb";
export type VerificationProvider = "didit" | "mock";
/** Which frontend started the verification; picks Didit's callback origin. */
export type VerificationApp = "launchpad" | "pro";

export const LaunchpadErrorCode = {
  VERIFICATION_NOT_FOUND: "VERIFICATION_NOT_FOUND",
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",
  MISSING_ACCESS_TOKEN: "MISSING_ACCESS_TOKEN",
  VERIFICATION_NOT_APPROVED: "VERIFICATION_NOT_APPROVED",
  VERIFICATION_ALREADY_CLAIMED: "VERIFICATION_ALREADY_CLAIMED",
  CLAIM_TOKEN_INVALID: "CLAIM_TOKEN_INVALID",
  EMAIL_IN_USE: "EMAIL_IN_USE",
  WORKFLOW_NOT_CONFIGURED: "WORKFLOW_NOT_CONFIGURED",
  WEBHOOK_SIGNATURE_INVALID: "WEBHOOK_SIGNATURE_INVALID",
  APPLICATION_NOT_FOUND: "APPLICATION_NOT_FOUND",
  APPLICATION_NOT_REVIEWABLE: "APPLICATION_NOT_REVIEWABLE",
  ISSUER_NOT_VERIFIED: "ISSUER_NOT_VERIFIED",
  REVIEW_SKIP_DISABLED: "REVIEW_SKIP_DISABLED",
  INVESTOR_NOT_FOUND: "INVESTOR_NOT_FOUND",
  WALLET_ALREADY_VERIFIED: "WALLET_ALREADY_VERIFIED",
  ONCHAIN_IDENTITY_FAILED: "ONCHAIN_IDENTITY_FAILED",
  CHAIN_NOT_CONFIGURED: "CHAIN_NOT_CONFIGURED",
  APPLICATION_NOT_APPROVED: "APPLICATION_NOT_APPROVED",
  ISSUER_WALLET_MISSING: "ISSUER_WALLET_MISSING",
  TRUSTLINE_MISSING: "TRUSTLINE_MISSING",
  LAUNCH_IN_PROGRESS: "LAUNCH_IN_PROGRESS",
  DEPLOYMENT_NOT_LIVE: "DEPLOYMENT_NOT_LIVE",
  CHAIN_CALL_FAILED: "CHAIN_CALL_FAILED",
  FAUCET_RATE_LIMITED: "FAUCET_RATE_LIMITED",
  FAUCET_UNAVAILABLE: "FAUCET_UNAVAILABLE",
  OPPORTUNITY_NOT_FOUND: "OPPORTUNITY_NOT_FOUND",
} as const;

export type ApplicationStatus =
  "submitted" | "in_review" | "changes_requested" | "approved" | "rejected";

export type AssetType =
  | "real_estate"
  | "private_credit"
  | "invoices"
  | "agriculture"
  | "energy"
  | "other";

export type OfferingType = "private" | "public";

export interface ApplicationMilestone {
  title: string;
  amount_pct: number;
  /** YYYY-MM-DD; missing only on applications sent before it was required. */
  due?: string;
}

export type DeploymentStatus = "launching" | "live" | "failed";

/** The launch steps, in the order they run. */
export const LAUNCH_STEPS = [
  "create_vault",
  "wire_vault",
  "accept_admin",
  "bind_compliance",
  "bind_registry",
  "register_milestones",
] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];

export interface DeploymentRow {
  id: string;
  application_id: string;
  vault_id: string;
  token_symbol: string;
  funding_deadline: string;
  token: string | null;
  compliance: string | null;
  vault: string | null;
  status: DeploymentStatus;
  /** Tx hash per step that ran; `"skipped"` when there was nothing to do. */
  steps: Partial<Record<LaunchStep, string>>;
  error: { step: LaunchStep; message: string } | null;
  launched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentView {
  vault_id: string;
  token_symbol: string;
  funding_deadline: string;
  token: string | null;
  compliance: string | null;
  vault: string | null;
  status: DeploymentStatus;
  steps: Partial<Record<LaunchStep, string>>;
  error: { step: LaunchStep; message: string } | null;
  launched_at: string | null;
}

export function toDeploymentView(row: DeploymentRow): DeploymentView {
  return {
    vault_id: row.vault_id,
    token_symbol: row.token_symbol,
    funding_deadline: row.funding_deadline,
    token: row.token,
    compliance: row.compliance,
    vault: row.vault,
    status: row.status,
    steps: row.steps ?? {},
    error: row.error,
    launched_at: row.launched_at,
  };
}

export interface ApplicationDocument {
  name: string;
  url: string;
}

export interface ApplicationRow {
  id: string;
  account_id: string;
  status: ApplicationStatus;
  issuer_name: string;
  issuer_country: string;
  asset_name: string;
  asset_type: AssetType;
  description: string;
  target_amount: number | string;
  currency: string;
  min_ticket: number | string;
  min_target: number | string | null;
  expected_yield_pct: number | string | null;
  term_months: number | null;
  max_investors: number | null;
  offering_type: OfferingType;
  investor_countries: string[];
  accepts_us_investors: boolean;
  uses_mass_marketing: boolean;
  milestones: ApplicationMilestone[];
  documents: ApplicationDocument[];
  ai_summary: string | null;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Embedded by `select("*, launchpad_deployments(*)")`; object or array by PostgREST version. */
  launchpad_deployments?: DeploymentRow | DeploymentRow[] | null;
}

export interface ApplicationView {
  id: string;
  account_id: string;
  status: ApplicationStatus;
  issuer_name: string;
  issuer_country: string;
  asset_name: string;
  asset_type: AssetType;
  description: string;
  target_amount: number;
  currency: string;
  min_ticket: number;
  min_target: number | null;
  expected_yield_pct: number | null;
  term_months: number | null;
  max_investors: number | null;
  offering_type: OfferingType;
  investor_countries: string[];
  accepts_us_investors: boolean;
  uses_mass_marketing: boolean;
  milestones: ApplicationMilestone[];
  documents: ApplicationDocument[];
  ai_summary: string | null;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  deployment: DeploymentView | null;
}

export interface AdminApplicationView extends ApplicationView {
  issuer: {
    account_id: string;
    email: string;
    display_name: string | null;
    verification: VerificationView;
    wallet_address: string | null;
  };
}

export type DecidedApplicationStatus = Extract<
  ApplicationStatus,
  "approved" | "rejected" | "changes_requested"
>;

export interface SimilarApplicationCase extends Pick<
  ApplicationView,
  | "id"
  | "asset_name"
  | "asset_type"
  | "issuer_country"
  | "offering_type"
  | "target_amount"
  | "currency"
  | "review_note"
  | "reviewed_at"
> {
  status: DecidedApplicationStatus;
  score: number;
  matched: string[];
}

export interface SimilarApplicationsResponse {
  summary: Record<DecidedApplicationStatus, number>;
  cases: SimilarApplicationCase[];
}

export interface VerificationRow {
  id: string;
  kind: VerificationKind;
  provider: VerificationProvider;
  provider_session_id: string | null;
  status: VerificationStatus;
  full_name: string | null;
  business_name: string | null;
  country: string | null;
  decision: unknown;
  claim_token_hash: string;
  claimed_at: string | null;
  network: string;
  created_at: string;
  updated_at: string;
}

export interface AccountRow {
  id: string;
  email: string;
  privy_user_id: string;
  display_name: string | null;
  verification_id: string;
  created_at: string;
}

export interface WalletRow {
  id: string;
  account_id: string;
  verification_id: string;
  chain: "stellar";
  network: string;
  address: string;
  kind: "embedded" | "external";
  provider: string;
  provider_wallet_id: string | null;
  funded_at: string | null;
  funding_tx_hash: string | null;
  created_at: string;
}

export interface InvestorRow {
  id: string;
  wallet_address: string;
  verification_id: string;
  network: string;
  /** The investor's identity contract, owned by the platform manager. */
  identity_contract: string | null;
  /** When the wallet was registered in the shared identity registry. */
  onchain_registered_at: string | null;
  created_at: string;
}

export interface VerificationView {
  id: string;
  kind: VerificationKind;
  provider: VerificationProvider;
  status: VerificationStatus;
  full_name: string | null;
  business_name: string | null;
  country: string | null;
  claimed: boolean;
}

export interface StartedVerification {
  verification: VerificationView;
  session_url: string | null;
  claim_token: string;
}

export interface LaunchpadAccountView {
  account: {
    id: string;
    email: string;
    display_name: string | null;
    privy_user_id: string;
  };
  verification: VerificationView;
  wallet: {
    address: string;
    network: string;
    funded: boolean;
    funding_tx_hash: string | null;
  };
}

export interface InvestorView {
  wallet_address: string;
  network: string;
  /** True while the bound verification is approved; gates Neko Pro. */
  whitelisted: boolean;
  /** Registered on-chain with KYC/AML claims, so it can hold vault tokens. */
  onchain: boolean;
  identity_contract: string | null;
  verification: VerificationView;
  created_at: string;
}

export function toInvestorView(
  row: InvestorRow,
  verification: VerificationRow
): InvestorView {
  return {
    wallet_address: row.wallet_address,
    network: row.network,
    whitelisted: verification.status === "approved",
    onchain: Boolean(row.onchain_registered_at),
    identity_contract: row.identity_contract ?? null,
    verification: toVerificationView(verification),
    created_at: row.created_at,
  };
}

export function toVerificationView(row: VerificationRow): VerificationView {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    status: row.status,
    full_name: row.full_name,
    business_name: row.business_name,
    country: row.country,
    claimed: Boolean(row.claimed_at),
  };
}

function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function toNullableNumber(
  value: number | string | null | undefined
): number | null {
  if (value == null) return null;
  return toNumber(value);
}

export function toApplicationView(row: ApplicationRow): ApplicationView {
  return {
    id: row.id,
    account_id: row.account_id,
    status: row.status,
    issuer_name: row.issuer_name,
    issuer_country: row.issuer_country,
    asset_name: row.asset_name,
    asset_type: row.asset_type,
    description: row.description,
    target_amount: toNumber(row.target_amount),
    currency: row.currency,
    min_ticket: toNumber(row.min_ticket),
    min_target: toNullableNumber(row.min_target),
    expected_yield_pct: toNullableNumber(row.expected_yield_pct),
    term_months: row.term_months == null ? null : Number(row.term_months),
    max_investors: row.max_investors == null ? null : Number(row.max_investors),
    offering_type: row.offering_type,
    investor_countries: row.investor_countries ?? [],
    accepts_us_investors: Boolean(row.accepts_us_investors),
    uses_mass_marketing: Boolean(row.uses_mass_marketing),
    milestones: Array.isArray(row.milestones) ? row.milestones : [],
    documents: Array.isArray(row.documents) ? row.documents : [],
    ai_summary: row.ai_summary,
    review_note: row.review_note,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deployment: embeddedDeployment(row),
  };
}

function embeddedDeployment(row: ApplicationRow): DeploymentView | null {
  const embedded = row.launchpad_deployments;
  const deployment = Array.isArray(embedded) ? embedded[0] : embedded;
  return deployment ? toDeploymentView(deployment) : null;
}
