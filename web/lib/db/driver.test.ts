import { describe, expect, it } from "vitest";
import { pgPoolConfig, selectPgDriver } from "./index";

describe("PostgreSQL driver selection & TLS enforcement (Azure + Neon, SEC-01)", () => {
  it("selects neon for *.neon.tech and pg for Azure / standard PostgreSQL", () => {
    expect(selectPgDriver("postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/neondb?sslmode=require", "")).toBe("neon");
    expect(selectPgDriver("postgresql://u:p@tmc-doccenter.postgres.database.azure.com:5432/tmc_document_center?sslmode=require", "")).toBe(
      "pg",
    );
    expect(selectPgDriver("postgresql://u:p@localhost:5432/dev", "")).toBe("pg");
  });

  it("honors explicit DATABASE_DRIVER override", () => {
    expect(selectPgDriver("postgresql://u:p@ep-1.neon.tech/db", "pg")).toBe("pg");
    expect(selectPgDriver("postgresql://u:p@custom.host/db", "neon")).toBe("neon");
  });

  it("strips SSL query params and enforces verified TLS on Azure PostgreSQL in production", () => {
    const cfg = pgPoolConfig(
      "postgresql://u:p@tmc-doccenter.postgres.database.azure.com/db?sslmode=require&application_name=dc",
      { NODE_ENV: "production" },
    );
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    expect(cfg.connectionString).not.toContain("sslmode");
    expect(cfg.connectionString).toContain("application_name=dc");

    const libpqVerifyFull = pgPoolConfig(
      "postgresql://u:p@tmc-doccenter.postgres.database.azure.com/db?uselibpqcompat=true&sslmode=verify-full",
      { NODE_ENV: "production" },
    );
    expect(libpqVerifyFull.ssl).toEqual({ rejectUnauthorized: true });
    expect(libpqVerifyFull.connectionString).not.toContain("uselibpqcompat");
  });

  it("blocks every SSL-weakening query parameter and invalid URL in production (SEC-01)", () => {
    const badUrls = [
      "postgresql://u:p@db.internal/app?sslmode=disable",
      "postgresql://u:p@db.internal/app?sslmode=no-verify",
      "postgresql://u:p@db.internal/app?sslmode=prefer",
      "postgresql://u:p@db.internal/app?sslmode=allow",
      "postgresql://u:p@db.internal/app?ssl=0",
      "postgresql://u:p@db.internal/app?SSL=false",
      "postgresql://u:p@db.internal/app?ssl=no-verify",
      "postgresql://u:p@db.internal/app?uselibpqcompat=true&sslmode=require",
      "not-a-valid-url",
      "http://db.internal/app",
    ];
    for (const u of badUrls) {
      expect(() => pgPoolConfig(u, { NODE_ENV: "production" })).toThrow();
    }
    // Local dev allows sslmode=disable cleanly.
    const dev = pgPoolConfig("postgresql://u:p@localhost:5432/dev?sslmode=disable", { NODE_ENV: "development" });
    expect(dev.ssl).toBe(false);
    expect(dev.connectionString).not.toContain("sslmode");
  });
});
