jest.mock("@neko-protocol/keeper", () => ({
  getAssetsConfig: () => ({}),
  getContractToCodeMap: () => ({}),
  getCurrentNetworkId: () => "PUBLIC",
}));

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { SupabaseService } from "@core/supabase/supabase.service";
import { AuditService } from "@domains/platform/audit/audit.service";
import { MailingAudiencesService } from "../audiences/mailing-audiences.service";
import { AdminWalletBalanceService } from "../triggers/admin-wallet-balance.service";
import { MAILING_SENDS_CONFLICT_TARGET } from "../mailing-sends.constants";
import { MailingEnrollmentService } from "./mailing-enrollment.service";

const SIBLING_REPO_ROOT = join(__dirname, "../../../../../../");
const WEB_REPO_CANDIDATES = [
  "web-app",
  "neko-web-hackmeridian",
  "neko-mainnet",
] as const;

function resolveMigrationsDir(): string | null {
  const fromEnv = process.env.NEKO_WEB_MIGRATIONS_DIR?.trim();
  if (fromEnv) {
    return existsSync(fromEnv) ? fromEnv : null;
  }
  for (const repo of WEB_REPO_CANDIDATES) {
    const dir = join(SIBLING_REPO_ROOT, repo, "supabase", "migrations");
    if (existsSync(dir)) return dir;
  }
  return null;
}

const WALLET = "GDEPOSITOR";
const AUTOMATION_ID = "11111111-1111-1111-1111-111111111111";
const DEPOSITED_AT = "2026-09-14T10:00:00.000Z";

function constraintFromMigrations(migrationsDir: string): string {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let columns: string | null = null;
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const table =
      /create table (?:if not exists )?public\.mailing_sends\b[\s\S]*?\n\);/i.exec(
        sql
      );
    if (table) {
      const inline = /\n\s*unique \(([^)]+)\)/i.exec(table[0]);
      if (inline) columns = inline[1];
    }
    const added = [
      ...sql.matchAll(
        /alter table public\.mailing_sends\s+add constraint \S+\s+unique \(([^)]+)\)/gi
      ),
    ];
    if (added.length) columns = added[added.length - 1][1];
  }

  if (!columns) throw new Error("no unique constraint found for mailing_sends");
  return columns
    .split(",")
    .map((c) => c.trim())
    .join(",");
}

type UpsertCall = { rows: Record<string, unknown>[]; onConflict: string };

function makeSupabase(constraint: string, calls: UpsertCall[]) {
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of [
        "select",
        "not",
        "eq",
        "order",
        "in",
        "range",
        "limit",
      ]) {
        builder[m] = chain;
      }

      builder.upsert = (
        rows: Record<string, unknown>[],
        opts: { onConflict: string }
      ) => {
        calls.push({ rows, onConflict: opts.onConflict });
        const error =
          opts.onConflict === constraint
            ? null
            : {
                code: "42P10",
                message:
                  "there is no unique or exclusion constraint matching the ON CONFLICT specification",
              };
        return Promise.resolve({ data: null, error });
      };

      builder.then = (
        resolve: (v: { data: unknown; error: null }) => unknown
      ) => {
        if (table === "mailing_messages") {
          return resolve({
            data: [
              {
                id: AUTOMATION_ID,
                trigger_type: "first_deposit",
                trigger_params: {},
                delay_value: 0,
                delay_unit: "minutes",
                audience: "all",
                status: "active",
              },
            ],
            error: null,
          });
        }
        if (table === "users") {
          return resolve({
            data: [
              {
                email: "depositor@test.io",
                wallet_address: WALLET,
                email_verified_at: "2026-09-01T00:00:00.000Z",
              },
            ],
            error: null,
          });
        }
        return resolve({ data: [], error: null });
      };

      return builder;
    },
  };
  return { client } as unknown as SupabaseService;
}

function makeConfig(floor?: string) {
  return {
    get: (key: string) =>
      key === "MAILING_ENROLLMENT_FLOOR" ? floor : undefined,
  } as unknown as ConfigService;
}

function build(calls: UpsertCall[], constraint: string, floor?: string) {
  const audit = {
    query: jest.fn().mockResolvedValue([
      {
        wallet_address: WALLET,
        action_type: "vaults_deposit",
        created_at: DEPOSITED_AT,
      },
    ]),
  } as unknown as AuditService;

  return new MailingEnrollmentService(
    makeSupabase(constraint, calls),
    audit,
    {} as unknown as MailingAudiencesService,
    {} as unknown as AdminWalletBalanceService,
    makeConfig(floor)
  );
}

const migrationsDir = resolveMigrationsDir();
const describeMailingEnrollment = migrationsDir ? describe : describe.skip;

describeMailingEnrollment(
  migrationsDir
    ? "MailingEnrollmentService"
    : "MailingEnrollmentService — skipped: investor web repo is not checked out (no supabase/migrations)",
  () => {
    const constraint = constraintFromMigrations(migrationsDir!);

    it("targets the unique key the migrations actually declare", () => {
      expect(MAILING_SENDS_CONFLICT_TARGET).toBe(constraint);
    });

    it("enqueues a verified depositor instead of failing on ON CONFLICT", async () => {
      const calls: UpsertCall[] = [];
      const result = await build(calls, constraint).run();

      expect(result).toEqual({ automationsProcessed: 1, enrolled: 1 });
      expect(calls).toHaveLength(1);
      expect(calls[0].onConflict).toBe(constraint);
      expect(calls[0].rows[0]).toMatchObject({
        message_id: AUTOMATION_ID,
        wallet_address: WALLET,
        email: "depositor@test.io",
        trigger_at: DEPOSITED_AT,
        scheduled_send_at: DEPOSITED_AT,
        status: "pending",
      });
    });

    it("skips a candidate whose event predates the enrollment floor", async () => {
      const calls: UpsertCall[] = [];
      // The deposit is 2026-09-14; the floor is the day after.
      const result = await build(
        calls,
        constraint,
        "2026-09-15T00:00:00.000Z"
      ).run();

      expect(result).toEqual({ automationsProcessed: 1, enrolled: 0 });
      expect(calls).toHaveLength(0);
    });

    it("enrolls a candidate whose event is at or after the floor", async () => {
      const calls: UpsertCall[] = [];
      const result = await build(
        calls,
        constraint,
        "2026-09-01T00:00:00.000Z"
      ).run();

      expect(result).toEqual({ automationsProcessed: 1, enrolled: 1 });
      expect(calls[0].rows[0]).toMatchObject({ trigger_at: DEPOSITED_AT });
    });

    it("refuses to start on an unparseable floor rather than enroll all history", () => {
      expect(() => build([], constraint, "not-a-date")).toThrow(
        /MAILING_ENROLLMENT_FLOOR/
      );
    });

    it("writes nothing when the conflict target is stale", async () => {
      const calls: UpsertCall[] = [];
      const result = await build(
        calls,
        "message_id,email,trigger_at,network"
      ).run();

      expect(result).toEqual({ automationsProcessed: 0, enrolled: 0 });
    });
  }
);
