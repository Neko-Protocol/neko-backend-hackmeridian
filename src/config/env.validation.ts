import * as Joi from "joi";
import { parseCorsOrigins } from "./cors-origins";

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid("development", "production", "test")
    .default("development"),
  PORT: Joi.number().integer().min(1).max(65535).default(4000),
  LOG_LEVEL: Joi.string()
    .valid("fatal", "error", "warn", "info", "debug", "trace", "silent")
    .default("info"),

  STELLAR_NETWORK: Joi.string()
    .pattern(/^(mainnet|testnet|public|pubnet|local)$/i)
    .required(),
  STELLAR_NETWORK_PASSPHRASE: Joi.string().min(1).required(),
  // Legacy single-endpoint config. Still honoured as a fallback when
  // STELLAR_RPC_ENDPOINTS is unset, so existing deployments keep booting.
  STELLAR_RPC_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .required(),
  // JSON array of { url, label?, priority?, authHeader? }, highest priority
  // first. Takes precedence over STELLAR_RPC_URL when present.
  STELLAR_RPC_ENDPOINTS: Joi.string().optional().allow(""),
  STELLAR_HORIZON_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .required(),
  STELLAR_RPC_AUTH_HEADER: Joi.string().optional().allow(""),

  // Optional. Unset means RPC response caching is disabled and every call
  // goes upstream — the app boots and behaves correctly either way.
  REDIS_URL: Joi.string()
    .uri({ scheme: ["redis", "rediss"] })
    .optional()
    .allow(""),

  // Bearer token Grafana (or any scraper) must present on GET /metrics.
  // Unset disables the endpoint entirely rather than opening it.
  METRICS_SCRAPE_TOKEN: Joi.string().min(24).optional().allow(""),

  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().min(1).required(),
  SUPABASE_ANON_KEY: Joi.string().min(1).required(),

  // Comma-separated origins, or a JSON array of origin strings. Empty rejects
  // every browser origin. See parseCorsOrigins.
  CORS_ORIGIN: Joi.string()
    .optional()
    .allow("")
    .custom((value: string, helpers) => {
      try {
        parseCorsOrigins(value);
        return value;
      } catch (err) {
        return helpers.message(
          { custom: "{{#reason}}" },
          { reason: err instanceof Error ? err.message : "Invalid CORS_ORIGIN" }
        );
      }
    }),
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(10).default(0),

  INTERNAL_API_KEY: Joi.string().min(32).required(),

  VAULT_MANAGER_SECRET_KEY: Joi.string()
    .pattern(/^S[A-Z2-7]{55}$/)
    .optional()
    .allow(""),
  DEFINDEX_API_KEY: Joi.string().optional().allow(""),

  WEB_APP_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .optional()
    .allow(""),
  CRON_SECRET: Joi.string().optional().allow(""),

  // Falls back to the public key of VAULT_MANAGER_SECRET_KEY when unset.
  ADMIN_WALLET_ADDRESS: Joi.string().optional().allow(""),
  RESEND_API_KEY: Joi.string().optional().allow(""),
  RESEND_FROM_EMAIL: Joi.string().default("noreply@nekoprotocol.xyz"),

  PRIVY_APP_ID: Joi.string().optional().allow(""),
  PRIVY_APP_SECRET: Joi.string().optional().allow(""),
  PRIVY_VERIFICATION_KEY: Joi.string().optional().allow(""),

  DIDIT_API_KEY: Joi.string().optional().allow(""),
  DIDIT_WEBHOOK_SECRET: Joi.string().optional().allow(""),
  DIDIT_KYC_WORKFLOW_ID: Joi.string().uuid().optional().allow(""),
  DIDIT_KYB_WORKFLOW_ID: Joi.string().uuid().optional().allow(""),
  DIDIT_BASE_URL: Joi.string()
    .uri({ scheme: ["https"] })
    .optional()
    .allow(""),
  LAUNCHPAD_APP_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .optional()
    .allow(""),
  PRO_APP_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .optional()
    .allow(""),
  LAUNCHPAD_FRIENDBOT_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .optional()
    .allow(""),
  KYC_MOCK_ENABLED: Joi.string().valid("true", "false", "").optional(),
  REVIEW_SKIP_ENABLED: Joi.string().valid("true", "false", "").optional(),

  ANTHROPIC_API_KEY: Joi.string().optional().allow(""),
  ANTHROPIC_MODEL: Joi.string().optional().allow(""),
  LAUNCHPAD_RAG_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .optional()
    .allow(""),
  // Launchpad contracts on testnet. Only keys and roots: every other address
  // is read off the ledger at startup. Kept apart from the mainnet STELLAR_*.
  LAUNCHPAD_RPC_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .optional()
    .allow(""),
  LAUNCHPAD_HORIZON_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .optional()
    .allow(""),
  LAUNCHPAD_NETWORK_PASSPHRASE: Joi.string().optional().allow(""),
  LAUNCHPAD_PUBLIC_API_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .optional()
    .allow(""),
  NEKO_MANAGER_SECRET: Joi.string()
    .pattern(/^S[A-Z2-7]{55}$/)
    .optional()
    .allow(""),
  NEKO_ADMIN_SECRET: Joi.string()
    .pattern(/^S[A-Z2-7]{55}$/)
    .optional()
    .allow(""),
  NEKO_USDC_ISSUER_SECRET: Joi.string()
    .pattern(/^S[A-Z2-7]{55}$/)
    .optional()
    .allow(""),
  NEKO_CLAIM_SIGNING_KEY: Joi.string()
    .pattern(/^[0-9a-fA-F]{64}$/)
    .optional()
    .allow(""),
  NEKO_USDC_ASSET: Joi.string()
    .pattern(/^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$/)
    .optional()
    .allow(""),
  NEKO_FACTORY_ID: Joi.string()
    .pattern(/^C[A-Z2-7]{55}$/)
    .optional()
    .allow(""),
  NEKO_MILESTONE_TRACKER_ID: Joi.string()
    .pattern(/^C[A-Z2-7]{55}$/)
    .optional()
    .allow(""),
  NEKO_IDENTITY_WASM_HASH: Joi.string()
    .pattern(/^[0-9a-fA-F]{64}$/)
    .optional()
    .allow(""),
  NEKO_EXIT_FEE_BPS: Joi.number().integer().min(0).max(10_000).optional(),
  NEKO_MAX_EXIT_FEE_BPS: Joi.number().integer().min(0).max(10_000).optional(),

  LAUNCHPAD_ASSISTANT_BUCKET: Joi.string().default("launchpad-assistant-docs"),
  LAUNCHPAD_APPLICATION_BUCKET: Joi.string().default(
    "launchpad-application-docs"
  ),
});
