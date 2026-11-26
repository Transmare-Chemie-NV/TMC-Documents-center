// Single source of truth for Azure PostgreSQL node-postgres Pool TLS config (SEC-01, L4).
// Shared by web/lib/db/index.ts and web/scripts/migrate.mjs so runtime and migrations never drift.

const INSECURE_SSLMODES = new Set(["disable", "allow", "prefer", "no-verify"]);
const INSECURE_SSL_VALS = new Set(["0", "false", "no-verify"]);
const STRIP_SSL_PARAMS = [
  "ssl",
  "sslmode",
  "uselibpqcompat",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslnegotiation",
];

/**
 * Builds a strict node-postgres Pool configuration (SEC-01):
 *   - parses DATABASE_URL strictly (fails closed on invalid URL)
 *   - refuses any SSL-weakening query params in production (ssl=0/false/no-verify,
 *     sslmode=disable/allow/prefer/no-verify, or uselibpqcompat=true without verify-full)
 *   - strips SSL query params (including sslnegotiation/sslrootcert) from connectionString so
 *     pg's ConnectionParameters cannot override `{ rejectUnauthorized: true }`.
 */
export function pgPoolConfig(rawUrl, env = process.env) {
  const isProd = env.NODE_ENV === "production" && env.DATABASE_ALLOW_INSECURE !== "1";
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }

  let sslmode = "";
  let sslParam = "";
  let libpqCompat = false;
  for (const [k, v] of parsed.searchParams.entries()) {
    const key = k.toLowerCase();
    const val = v.trim().toLowerCase();
    if (key === "sslmode") sslmode = val;
    else if (key === "ssl") sslParam = val;
    else if (key === "uselibpqcompat") libpqCompat = val === "true" || val === "1";
  }

  const wantsInsecure =
    INSECURE_SSLMODES.has(sslmode) ||
    INSECURE_SSL_VALS.has(sslParam) ||
    (libpqCompat && sslmode !== "verify-full");

  for (const k of Array.from(parsed.searchParams.keys())) {
    if (STRIP_SSL_PARAMS.includes(k.toLowerCase())) parsed.searchParams.delete(k);
  }

  if (wantsInsecure) {
    if (isProd) throw new Error("DATABASE_URL cannot disable or weaken SSL verification in production");
    return { connectionString: parsed.toString(), ssl: false, connectionTimeoutMillis: 10_000 };
  }
  return { connectionString: parsed.toString(), ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 10_000 };
}
