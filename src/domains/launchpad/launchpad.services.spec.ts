import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { StrKey } from "@stellar/stellar-sdk";
import type { SupabaseService } from "@core/supabase/supabase.service";
import type { DiditService } from "@core/didit/didit.service";
import type { PrivyService } from "@core/privy/privy.service";
import { fundWithFriendbot } from "@shared/stellar/friendbot";
import { AccountsService } from "./accounts.service";
import { ApplicationsService } from "./applications.service";
import { InvestorsService } from "./investors.service";
import type { ProIdentityService } from "./pro-identity.service";
import type { AssistantService } from "./assistant/assistant.service";
import type { OnchainIdentityService } from "./chain/onchain-identity.service";
import type { CreateApplicationDto } from "./dto/create-application.dto";
import {
  toApplicationView,
  type ApplicationRow,
} from "./launchpad.types";
import { VerificationsService } from "./verifications.service";

jest.mock("@shared/stellar/friendbot", () => ({
  fundWithFriendbot: jest.fn(),
}));

type Row = Record<string, unknown>;

function fakeSupabase() {
  const tables: Record<string, Row[]> = {};
  const rows = (t: string) => (tables[t] ??= []);

  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row = {};
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    const match = () =>
      rows(table).filter((r) => filters.every(([k, v]) => r[k] === v));
    const run = () => {
      if (op === "insert") {
        const now = new Date().toISOString();
        const row = {
          id: randomUUID(),
          claimed_at: null,
          provider_session_id: null,
          created_at: now,
          updated_at: now,
          ...payload,
        };
        rows(table).push(row);
        return [row];
      }
      if (op === "update") {
        const hit = match();
        hit.forEach((r) => Object.assign(r, payload));
        return hit;
      }
      if (op === "delete") {
        const hit = match();
        tables[table] = rows(table).filter((r) => !hit.includes(r));
        return hit;
      }
      let out = match();
      if (orderCol) {
        const col = orderCol;
        out = [...out].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN != null) out = out.slice(0, limitN);
      return out;
    };
    const builder = {
      select: () => builder,
      insert: (v: Row) => ((op = "insert"), (payload = v), builder),
      update: (v: Row) => ((op = "update"), (payload = v), builder),
      delete: () => ((op = "delete"), builder),
      eq: (k: string, v: unknown) => (filters.push([k, v]), builder),
      order: (col: string, opts?: { ascending?: boolean }) => (
        (orderCol = col),
        (orderAsc = opts?.ascending !== false),
        builder
      ),
      limit: (n: number) => ((limitN = n), builder),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: run(), error: null }),
    };
    return builder;
  }

  return {
    tables,
    service: { client: { from } } as unknown as SupabaseService,
  };
}

function config(env: Record<string, string>) {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

const BASE_ENV = {
  DIDIT_KYC_WORKFLOW_ID: "11111111-1111-1111-1111-111111111111",
  LAUNCHPAD_APP_URL: "http://localhost:3000",
  KYC_MOCK_ENABLED: "true",
  REVIEW_SKIP_ENABLED: "true",
};

function setup(env: Record<string, string> = BASE_ENV) {
  const db = fakeSupabase();
  const didit = {
    isConfigured: () => true,
    createSession: jest.fn().mockResolvedValue({
      session_id: "sess-1",
      url: "https://verify.didit.me/session/x",
      status: "Not Started",
    }),
    getDecision: jest.fn().mockResolvedValue({
      session_id: "sess-1",
      status: "Approved",
      id_verifications: [{ first_name: "Ana", last_name: "Mora" }],
    }),
  } as unknown as jest.Mocked<DiditService>;
  const privy = {
    verifyAccessToken: jest
      .fn()
      .mockResolvedValue({ userId: "did:privy:1", sessionId: "s" }),
    ensureUserWithStellarWallet: jest.fn().mockResolvedValue({
      userId: "did:privy:1",
      email: "ana@x.com",
      stellarWallets: [],
      wallet: { address: "GWALLET", walletId: "w-1" },
    }),
  } as unknown as jest.Mocked<PrivyService>;
  const verifications = new VerificationsService(
    db.service,
    didit,
    config(env)
  );
  const accounts = new AccountsService(
    db.service,
    privy,
    verifications,
    config(env)
  );
  const assistant = {
    finishSession: jest
      .fn()
      .mockResolvedValue([
        { role: "user", text: "Is a private offering right for me?" },
      ]),
    reviewSummary: jest
      .fn()
      .mockResolvedValue("Private raise for a coffee harvest."),
  } as unknown as jest.Mocked<AssistantService>;
  const applications = new ApplicationsService(
    db.service,
    accounts,
    assistant,
    config(env)
  );
  const onchainIdentity = {
    register: jest.fn().mockResolvedValue("CIDENTITY"),
  } as unknown as jest.Mocked<OnchainIdentityService>;
  const identities = {
    ensureRegistered: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ProIdentityService>;
  const investors = new InvestorsService(
    db.service,
    verifications,
    onchainIdentity,
    identities
  );
  return {
    db,
    didit,
    privy,
    verifications,
    accounts,
    applications,
    assistant,
    investors,
    onchainIdentity,
    identities,
  };
}

const SAMPLE_APPLICATION: CreateApplicationDto = {
  issuer_name: "Neko Coffee SA",
  issuer_country: "CR",
  asset_name: "Coffee Inventory Note",
  asset_type: "agriculture",
  description: "Tokenized harvest receivables.",
  target_amount: 250000,
  currency: "USD",
  min_ticket: 1000,
  min_target: 125000,
  expected_yield_pct: 8.5,
  term_months: 12,
  max_investors: 50,
  offering_type: "public",
  investor_countries: ["CR", "PA"],
  accepts_us_investors: false,
  uses_mass_marketing: false,
  milestones: [{ title: "Close", amount_pct: 100, due: "2099-01-01" }],
  documents: [{ name: "Deck", url: "https://example.com/deck.pdf" }],
};

beforeEach(() => {
  (fundWithFriendbot as jest.Mock).mockResolvedValue({
    funded: true,
    txHash: "tx-1",
  });
});

describe("VerificationsService", () => {
  it("starts a Didit session bound to the verification id", async () => {
    const { verifications, didit, db } = setup();
    const started = await verifications.start("kyc");

    expect(didit.createSession).toHaveBeenCalledWith({
      workflowId: BASE_ENV.DIDIT_KYC_WORKFLOW_ID,
      vendorData: started.verification.id,
      callback: "http://localhost:3000/didit-callback",
      metadata: { verification_id: started.verification.id, kind: "kyc" },
    });
    expect(started.session_url).toContain("didit.me");
    const row = db.tables.launchpad_verifications[0];
    expect(row.provider_session_id).toBe("sess-1");
    expect(row.claim_token_hash).not.toBe(started.claim_token);
  });

  it("refuses KYB when its workflow is not configured", async () => {
    const { verifications } = setup();
    await expect(verifications.start("kyb")).rejects.toMatchObject({
      response: { code: "WORKFLOW_NOT_CONFIGURED" },
    });
  });

  it("pulls the decision and stores the verified name", async () => {
    const { verifications } = setup();
    const started = await verifications.start("kyc");
    const view = await verifications.get(
      started.verification.id,
      started.claim_token
    );
    expect(view).toMatchObject({ status: "approved", full_name: "Ana Mora" });
  });

  it("rejects a wrong claim token", async () => {
    const { verifications } = setup();
    const started = await verifications.start("kyc");
    await expect(
      verifications.get(started.verification.id, "nope")
    ).rejects.toMatchObject({ response: { code: "CLAIM_TOKEN_INVALID" } });
  });

  it("hides the mock endpoint unless KYC_MOCK_ENABLED=true", async () => {
    const { verifications } = setup({ ...BASE_ENV, KYC_MOCK_ENABLED: "" });
    await expect(
      verifications.startMock("kyc", "Demo Judge")
    ).rejects.toMatchObject({ status: 404 });
  });

  it("creates an approved mock verification with the typed name", async () => {
    const { verifications, didit } = setup();
    const started = await verifications.startMock("kyb", "  Neko Coffee  ");
    expect(started.verification).toMatchObject({
      provider: "mock",
      status: "approved",
      business_name: "Neko Coffee",
      full_name: null,
    });
    expect(didit.createSession).not.toHaveBeenCalled();
  });
});

const WALLET_A = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const WALLET_B = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));

describe("VerificationsService callback", () => {
  it("returns Neko Pro sessions to PRO_APP_URL", async () => {
    const { verifications, didit } = setup({
      ...BASE_ENV,
      PRO_APP_URL: "http://localhost:3001/",
    });
    await verifications.start("kyc", "pro");
    expect(didit.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        callback: "http://localhost:3001/didit-callback",
      })
    );
  });
});

describe("InvestorsService", () => {
  it("whitelists the wallet and claims the verification", async () => {
    const { verifications, investors, onchainIdentity, db } = setup();
    // Hold the background on-chain registration so the first view is off-chain.
    onchainIdentity.register.mockReturnValue(new Promise(() => undefined));
    const started = await verifications.startMock("kyb", "Neko Coffee");

    const view = await investors.create(
      started.verification.id,
      started.claim_token,
      ` ${WALLET_A} `
    );

    expect(view).toMatchObject({
      wallet_address: WALLET_A,
      network: "testnet",
      whitelisted: true,
      verification: { kind: "kyb", business_name: "Neko Coffee" },
    });
    expect(view.verification.claimed).toBe(true);
    expect(db.tables.launchpad_investors).toHaveLength(1);
    await expect(investors.get(WALLET_A)).resolves.toEqual(view);
  });

  it("registers a skipped (mock) verification's wallet on-chain", async () => {
    const { verifications, investors, identities } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    await investors.create(
      started.verification.id,
      started.claim_token,
      WALLET_A
    );
    expect(identities.ensureRegistered).toHaveBeenCalledWith(WALLET_A);
  });

  it("does not whitelist when the on-chain registration fails", async () => {
    const { verifications, investors, identities, db } = setup();
    identities.ensureRegistered.mockRejectedValueOnce(new Error("rpc down"));
    const started = await verifications.startMock("kyc", "Demo Judge");
    await expect(
      investors.create(started.verification.id, started.claim_token, WALLET_A)
    ).rejects.toMatchObject({
      response: { code: "ONCHAIN_IDENTITY_FAILED" },
    });
    expect(db.tables.launchpad_investors ?? []).toHaveLength(0);

    await expect(
      investors.create(started.verification.id, started.claim_token, WALLET_A)
    ).resolves.toMatchObject({ wallet_address: WALLET_A });
  });

  it("is idempotent for the same verification and wallet", async () => {
    const { verifications, investors, onchainIdentity, db } = setup();
    onchainIdentity.register.mockReturnValue(new Promise(() => undefined));
    const started = await verifications.startMock("kyc", "Demo Judge");
    const first = await investors.create(
      started.verification.id,
      started.claim_token,
      WALLET_A
    );
    const second = await investors.create(
      started.verification.id,
      started.claim_token,
      WALLET_A
    );
    expect(second).toEqual(first);
    expect(db.tables.launchpad_investors).toHaveLength(1);
  });

  it("registers a new investor on-chain once, after responding", async () => {
    const { verifications, investors, onchainIdentity } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    const view = await investors.create(
      started.verification.id,
      started.claim_token,
      WALLET_A
    );
    expect(view.onchain).toBe(false);

    await new Promise((r) => setImmediate(r));
    const after = await investors.registerOnchain(WALLET_A);
    expect(after).toMatchObject({ onchain: true, identity_contract: "CIDENTITY" });
    expect(onchainIdentity.register).toHaveBeenCalledTimes(1);
    expect(onchainIdentity.register).toHaveBeenCalledWith(WALLET_A, undefined, null);
  });

  it("surfaces an on-chain failure so Neko Pro can retry", async () => {
    const { verifications, investors, onchainIdentity } = setup();
    onchainIdentity.register.mockRejectedValue(new Error("rpc down"));
    const started = await verifications.startMock("kyc", "Demo Judge");
    await investors.create(started.verification.id, started.claim_token, WALLET_A);

    await expect(investors.registerOnchain(WALLET_A)).rejects.toMatchObject({
      response: { code: "CHAIN_CALL_FAILED" },
    });
    onchainIdentity.register.mockResolvedValue("CIDENTITY");
    await expect(investors.registerOnchain(WALLET_A)).resolves.toMatchObject({
      onchain: true,
    });
  });

  it("registers a Launchpad account's wallet on-chain without an investor row", async () => {
    const { verifications, accounts, investors, onchainIdentity, privy } =
      setup();
    privy.ensureUserWithStellarWallet.mockResolvedValueOnce({
      userId: "did:privy:1",
      email: "ana@x.com",
      stellarWallets: [],
      wallet: { address: WALLET_B, walletId: "w-1" },
    } as never);
    const started = await verifications.startMock("kyc", "Demo Judge");
    await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );

    await expect(investors.registerOnchain(WALLET_A)).rejects.toMatchObject({
      response: { code: "INVESTOR_NOT_FOUND" },
    });
    const view = await investors.registerOnchain(WALLET_B);
    expect(view).toMatchObject({ onchain: true, identity_contract: "CIDENTITY" });
    expect(onchainIdentity.register).toHaveBeenCalledTimes(1);
  });

  it("refuses a verification bound to another wallet", async () => {
    const { verifications, investors } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    await investors.create(
      started.verification.id,
      started.claim_token,
      WALLET_A
    );
    await expect(
      investors.create(started.verification.id, started.claim_token, WALLET_B)
    ).rejects.toMatchObject({
      response: { code: "VERIFICATION_ALREADY_CLAIMED" },
    });
  });

  it("refuses a wallet that is already whitelisted", async () => {
    const { verifications, investors } = setup();
    const a = await verifications.startMock("kyc", "A");
    const b = await verifications.startMock("kyc", "B");
    await investors.create(a.verification.id, a.claim_token, WALLET_A);
    await expect(
      investors.create(b.verification.id, b.claim_token, WALLET_A)
    ).rejects.toMatchObject({
      response: { code: "WALLET_ALREADY_VERIFIED" },
    });
  });

  it("refuses a verification that is not approved", async () => {
    const { verifications, investors, didit } = setup();
    didit.getDecision.mockResolvedValue({
      session_id: "sess-1",
      status: "In Review",
    });
    const started = await verifications.start("kyc", "pro");
    await expect(
      investors.create(started.verification.id, started.claim_token, WALLET_A)
    ).rejects.toMatchObject({
      response: { code: "VERIFICATION_NOT_APPROVED" },
    });
  });

  it("refuses a verification already claimed by a Launchpad account", async () => {
    const { verifications, accounts, investors } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );
    await expect(
      investors.create(started.verification.id, started.claim_token, WALLET_A)
    ).rejects.toMatchObject({
      response: { code: "VERIFICATION_ALREADY_CLAIMED" },
    });
  });

  it("does not let a Launchpad account reuse an investor's verification", async () => {
    const { verifications, accounts, investors } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    await investors.create(
      started.verification.id,
      started.claim_token,
      WALLET_A
    );
    await expect(
      accounts.create(started.verification.id, started.claim_token, "a@x.com")
    ).rejects.toMatchObject({
      response: { code: "VERIFICATION_ALREADY_CLAIMED" },
    });
  });

  it("answers INVESTOR_NOT_FOUND for a wallet that never verified", async () => {
    const { investors } = setup();
    await expect(investors.get(WALLET_B)).rejects.toMatchObject({
      response: { code: "INVESTOR_NOT_FOUND" },
    });
  });

  it("rejects a malformed wallet", async () => {
    const { investors } = setup();
    await expect(investors.get("GNOPE")).rejects.toMatchObject({
      response: { code: "INVALID_WALLET" },
    });
  });
});

describe("AccountsService", () => {
  it("creates the account and a wallet linked to the verification", async () => {
    const { verifications, accounts, privy, db } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");

    const result = await accounts.create(
      started.verification.id,
      started.claim_token,
      " Ana@X.com "
    );

    expect(privy.ensureUserWithStellarWallet).toHaveBeenCalledWith(
      "ana@x.com",
      {
        launchpad_verification_id: started.verification.id,
        launchpad_kind: "kyc",
      }
    );
    expect(result.wallet).toEqual({
      address: "GWALLET",
      network: "testnet",
      funded: true,
      funding_tx_hash: "tx-1",
    });
    expect(result.verification.claimed).toBe(true);
    const wallet = db.tables.launchpad_wallets[0];
    expect(wallet.verification_id).toBe(started.verification.id);
    expect(wallet.account_id).toBe(result.account.id);
    expect(db.tables.launchpad_accounts[0].display_name).toBe("Demo Judge");
  });

  it("is idempotent for the same verification and email", async () => {
    const { verifications, accounts, privy } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    const first = await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );
    const second = await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );
    expect(second).toEqual(first);
    expect(privy.ensureUserWithStellarWallet).toHaveBeenCalledTimes(1);
  });

  it("refuses a verification that is not approved", async () => {
    const { verifications, accounts, didit } = setup();
    didit.getDecision.mockResolvedValue({
      session_id: "sess-1",
      status: "In Review",
    });
    const started = await verifications.start("kyc");
    await expect(
      accounts.create(started.verification.id, started.claim_token, "a@x.com")
    ).rejects.toMatchObject({
      response: { code: "VERIFICATION_NOT_APPROVED" },
    });
  });

  it("refuses an email already used by another verification", async () => {
    const { verifications, accounts } = setup();
    const a = await verifications.startMock("kyc", "A");
    const b = await verifications.startMock("kyc", "B");
    await accounts.create(a.verification.id, a.claim_token, "same@x.com");
    await expect(
      accounts.create(b.verification.id, b.claim_token, "same@x.com")
    ).rejects.toMatchObject({ response: { code: "EMAIL_IN_USE" } });
  });

  it("still creates the account when friendbot fails", async () => {
    (fundWithFriendbot as jest.Mock).mockResolvedValue({
      funded: false,
      txHash: null,
      error: "HTTP 500",
    });
    const { verifications, accounts } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    const result = await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );
    expect(result.wallet.funded).toBe(false);
  });

  it("returns the account for the logged-in Privy user", async () => {
    const { verifications, accounts } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    const created = await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );
    await expect(accounts.getByAccessToken("token")).resolves.toEqual(created);
  });

  it("answers ACCOUNT_NOT_FOUND for a Privy user that never onboarded", async () => {
    const { accounts } = setup();
    await expect(accounts.getByAccessToken("token")).rejects.toMatchObject({
      response: { code: "ACCOUNT_NOT_FOUND" },
    });
  });
});

describe("ApplicationsService", () => {
  it("rejects create when the issuer verification is not approved", async () => {
    const { verifications, accounts, applications, db } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );
    db.tables.launchpad_verifications[0].status = "in_review";

    await expect(
      applications.create("token", SAMPLE_APPLICATION)
    ).rejects.toMatchObject({
      response: { code: "ISSUER_NOT_VERIFIED" },
    });
  });

  it("inserts a new application with status submitted", async () => {
    const { verifications, accounts, applications, db } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    const created = await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );

    const view = await applications.create("token", SAMPLE_APPLICATION);
    expect(view.status).toBe("submitted");
    expect(view.account_id).toBe(created.account.id);
    expect(view.target_amount).toBe(250000);
    expect(db.tables.launchpad_applications).toHaveLength(1);
    expect(db.tables.launchpad_applications[0].status).toBe("submitted");
  });

  it("approves a submitted application when the issuer skips pre-approval", async () => {
    const { verifications, accounts, applications, db } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );

    const created = await applications.create("token", SAMPLE_APPLICATION);
    const view = await applications.skipReview("token", created.id);
    expect(view.status).toBe("approved");
    expect(view.reviewed_at).not.toBeNull();
    expect(db.tables.launchpad_applications[0].reviewed_by).toBe("demo");
  });

  it("refuses to skip pre-approval unless REVIEW_SKIP_ENABLED=true", async () => {
    const { verifications, accounts, applications, db } = setup({
      ...BASE_ENV,
      REVIEW_SKIP_ENABLED: "",
    });
    const started = await verifications.startMock("kyc", "Demo Judge");
    await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );

    const created = await applications.create("token", SAMPLE_APPLICATION);
    await expect(
      applications.skipReview("token", created.id)
    ).rejects.toMatchObject({
      response: { code: "REVIEW_SKIP_DISABLED" },
    });
    expect(db.tables.launchpad_applications[0].status).toBe("submitted");
  });

  it.each([
    ["min_target below min_ticket", { min_target: 500 }],
    ["min_target above target_amount", { min_target: 300000 }],
    [
      "milestones not adding up to 100",
      { milestones: [{ title: "Close", amount_pct: 90, due: "2099-01-01" }] },
    ],
    [
      "milestone dates out of order",
      {
        milestones: [
          { title: "A", amount_pct: 50, due: "2099-02-01" },
          { title: "B", amount_pct: 50, due: "2099-01-01" },
        ],
      },
    ],
    [
      "a first milestone already due",
      { milestones: [{ title: "Close", amount_pct: 100, due: "2020-01-01" }] },
    ],
  ])("rejects create with %s", async (_, override) => {
    const { verifications, accounts, applications, db } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );

    await expect(
      applications.create("token", { ...SAMPLE_APPLICATION, ...override })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.tables.launchpad_applications ?? []).toHaveLength(0);
  });

  it("does not touch the assistant without a session id", async () => {
    const { verifications, accounts, applications, assistant, db } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );

    await applications.create("token", SAMPLE_APPLICATION);
    expect(assistant.finishSession).not.toHaveBeenCalled();
    expect(db.tables.launchpad_applications[0].ai_summary).toBeNull();
  });

  it("closes the assistant session and stores the reviewer summary", async () => {
    const { verifications, accounts, applications, assistant, db } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    const created = await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );
    const sessionId = randomUUID();

    const view = await applications.create("token", {
      ...SAMPLE_APPLICATION,
      assistant_session_id: sessionId,
    });
    expect(assistant.finishSession).toHaveBeenCalledWith(
      created.account.id,
      sessionId
    );
    expect(view.ai_summary).toBeNull();

    await new Promise((resolve) => setImmediate(resolve));
    expect(assistant.reviewSummary).toHaveBeenCalledWith(
      expect.objectContaining({ asset_name: SAMPLE_APPLICATION.asset_name }),
      [{ role: "user", text: "Is a private offering right for me?" }]
    );
    expect(db.tables.launchpad_applications[0].ai_summary).toBe(
      "Private raise for a coffee harvest."
    );
  });

  it("still creates the application when closing the session fails", async () => {
    const { verifications, accounts, applications, assistant, db } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );
    assistant.finishSession.mockRejectedValueOnce(new Error("storage down"));

    const view = await applications.create("token", {
      ...SAMPLE_APPLICATION,
      assistant_session_id: randomUUID(),
    });
    expect(view.status).toBe("submitted");
    expect(db.tables.launchpad_applications).toHaveLength(1);
  });

  it("rejects adminDecide when the application is already final", async () => {
    const { verifications, accounts, applications, db } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );
    const app = await applications.create("token", SAMPLE_APPLICATION);
    db.tables.launchpad_applications[0].status = "approved";

    await expect(
      applications.adminDecide(
        app.id,
        { decision: "rejected", note: "too late" },
        null
      )
    ).rejects.toMatchObject({
      response: { code: "APPLICATION_NOT_REVIEWABLE" },
    });
  });

  it("requires a note when adminDecide rejects", async () => {
    const { verifications, accounts, applications } = setup();
    const started = await verifications.startMock("kyc", "Demo Judge");
    await accounts.create(
      started.verification.id,
      started.claim_token,
      "ana@x.com"
    );
    const app = await applications.create("token", SAMPLE_APPLICATION);

    await expect(
      applications.adminDecide(app.id, { decision: "rejected" }, null)
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("toApplicationView", () => {
  it("converts numeric strings from Postgres to numbers", () => {
    const row = {
      id: "a1",
      account_id: "acc1",
      status: "submitted",
      issuer_name: "Issuer",
      issuer_country: "CR",
      asset_name: "Asset",
      asset_type: "other",
      description: "Desc",
      target_amount: "1000.50",
      currency: "USD",
      min_ticket: "100.00",
      min_target: null,
      expected_yield_pct: "7.250",
      term_months: 6,
      max_investors: 10,
      offering_type: "public",
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
    } as ApplicationRow;

    const view = toApplicationView(row);
    expect(view.target_amount).toBe(1000.5);
    expect(view.min_ticket).toBe(100);
    expect(view.expected_yield_pct).toBe(7.25);
  });
});

