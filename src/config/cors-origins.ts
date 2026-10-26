/**
 * Allowed browser origins from CORS_ORIGIN.
 *
 * Accepts either form:
 *   http://localhost:3000,https://app.example.com
 *   ["http://localhost:3000","https://app.example.com"]
 */
export function parseCorsOrigins(raw: string | undefined | null): string[] {
  const value = (raw ?? "").trim();
  if (!value) return [];

  const entries =
    value.startsWith("[") || value.startsWith("{")
      ? parseJsonArray(value)
      : value.split(",");

  const origins = entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeOrigin);

  return [...new Set(origins)];
}

function parseJsonArray(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("CORS_ORIGIN JSON array is not valid JSON.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error(
      "CORS_ORIGIN JSON value must be an array of origin strings."
    );
  }
  return parsed;
}

function normalizeOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`CORS_ORIGIN entry is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`CORS_ORIGIN entry must use http or https: ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`CORS_ORIGIN entry must not include credentials: ${raw}`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      `CORS_ORIGIN entry must be an origin with no path, query, or hash: ${raw}`
    );
  }
  return parsed.origin;
}
