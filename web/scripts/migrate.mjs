// Runs before `next build` (Vercel) or container startup (Azure). Applies database migrations
// when DATABASE_URL is set (Neon serverless or standard PostgreSQL / Azure via pg);
// does nothing otherwise (laptop and GitHub checks migrate PGlite on first use).
const url = process.env.DATABASE_URL;
if (!url) {
  console.log("migrate: no DATABASE_URL, skipped");
  process.exit(0);
}

const INSECURE_SSLMODES = new Set(["disable", "allow", "prefer", "no-verify"]);
const INSECURE_SSL_VALS = new Set(["0", "false", "no-verify"]);
const STRIP_SSL_PARAMS = ["ssl", "sslmode", "uselibpqcompat", "sslcert", "sslkey", "sslrootcert"];

function selectDriver(rawUrl) {
  const explicit = (process.env.DATABASE_DRIVER ?? "").trim().toLowerCase();
  if (explicit === "neon" || explicit === "pg") return explicit;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === "neon.tech" || host.endsWith(".neon.tech")) return "neon";
  } catch {
    // fall through to pg
  }
  return "pg";
}

function pgPoolConfig(rawUrl) {
  const isProd = process.env.NODE_ENV === "production" && process.env.DATABASE_ALLOW_INSECURE !== "1";
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

if (selectDriver(url) === "neon") {
  const { Pool } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-serverless");
  const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
  const pool = new Pool({ connectionString: url });
  await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
  await pool.end();
} else {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new pg.Pool(pgPoolConfig(url));
  await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
  await pool.end();
}
console.log("migrate: done");
