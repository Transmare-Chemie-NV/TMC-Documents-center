// Runs at container startup (Azure) or before `next build`. Applies database migrations to
// Azure Database for PostgreSQL when DATABASE_URL is set; does nothing otherwise (laptop and
// GitHub checks migrate PGlite on first use).
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pgPoolConfig } from "../lib/db/pg-config.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("migrate: no DATABASE_URL, skipped");
  process.exit(0);
}

const pool = new pg.Pool(pgPoolConfig(url));
try {
  await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
  console.log("migrate: done");
} finally {
  await pool.end();
}
