// Database access. Online (DATABASE_URL set): Neon Postgres (serverless) OR standard PostgreSQL
// via pg (Azure Database for PostgreSQL, same schema). Laptop and tests: PGlite, a Postgres that
// runs inside Node (no install), migrated on first use.
import "server-only";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const MIGRATIONS = path.join(process.cwd(), "drizzle");

export type PgDriver = "neon" | "pg";

const INSECURE_SSLMODES = new Set(["disable", "allow", "prefer", "no-verify"]);
const INSECURE_SSL_VALS = new Set(["0", "false", "no-verify"]);
const STRIP_SSL_PARAMS = ["ssl", "sslmode", "uselibpqcompat", "sslcert", "sslkey", "sslrootcert"];

/**
 * Chooses the Postgres driver for DATABASE_URL:
 *   - DATABASE_DRIVER=neon or pg overrides auto-detection
 *   - otherwise *.neon.tech uses @neondatabase/serverless, everything else (including Azure
 *     Database for PostgreSQL *.postgres.database.azure.com) uses node-postgres (pg).
 */
export function selectPgDriver(url: string, driverOverride = process.env.DATABASE_DRIVER): PgDriver {
  const explicit = (driverOverride ?? "").trim().toLowerCase();
  if (explicit === "neon" || explicit === "pg") return explicit;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "neon.tech" || host.endsWith(".neon.tech")) return "neon";
  } catch {
    // fall through to pg
  }
  return "pg";
}

/**
 * Builds a strict node-postgres Pool configuration (SEC-01):
 *   - parses DATABASE_URL strictly (fails closed on invalid URL)
 *   - refuses any SSL-weakening query params in production (ssl=0/false/no-verify,
 *     sslmode=disable/allow/prefer/no-verify, or uselibpqcompat=true without verify-full)
 *   - strips SSL query params from connectionString so pg's ConnectionParameters cannot override
 *     the explicit `{ rejectUnauthorized: true }` TLS option.
 */
export function pgPoolConfig(
  rawUrl: string,
  env: Record<string, string | undefined> = process.env,
): { connectionString: string; ssl: false | { rejectUnauthorized: true }; connectionTimeoutMillis: number } {
  const isProd = env.NODE_ENV === "production" && env.DATABASE_ALLOW_INSECURE !== "1";
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }

  // Inspect all query parameters case-insensitively so ?SSL=0 or ?SslMode=no-verify cannot bypass.
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

// One connection per process. Kept on globalThis because Next.js loads pages and API routes
// as separate bundles; two PGlite copies on one folder would not see each other's writes.
const g = globalThis as typeof globalThis & { __tmcDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  g.__tmcDb ??= connect().catch((err) => {
    g.__tmcDb = undefined; // try again on the next request instead of failing forever
    throw err;
  });
  return g.__tmcDb;
}

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    if (selectPgDriver(url) === "neon") {
      const { Pool } = await import("@neondatabase/serverless");
      const { drizzle } = await import("drizzle-orm/neon-serverless");
      // Migrations run at build/deploy time (scripts/migrate.mjs), not per request.
      return drizzle({ client: new Pool({ connectionString: url }), schema }) as unknown as Db;
    }
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    return drizzle({ client: new Pool(pgPoolConfig(url)), schema }) as unknown as Db;
  }
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_LOCAL_DB !== "1") {
    throw new Error("DATABASE_URL is not set");
  }
  const dataDir = process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite");
  return createPgliteDb(dataDir);
}

/** Local/test database. `dataDir` undefined = in memory (tests). */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const db = drizzle({ client: new PGlite(dataDir), schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db as unknown as Db;
}
