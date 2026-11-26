// Database access. Online (DATABASE_URL set): Azure Database for PostgreSQL (standard pg with
// strict verified TLS). Laptop and tests: PGlite, a Postgres that runs inside Node (no install),
// migrated on first use.
import "server-only";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { pgPoolConfig } from "./pg-config.mjs";
import * as schema from "./schema";

export { pgPoolConfig };
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const MIGRATIONS = path.join(process.cwd(), "drizzle");

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
