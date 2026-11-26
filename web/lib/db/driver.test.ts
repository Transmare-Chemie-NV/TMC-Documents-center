import { describe, expect, it } from "vitest";
import { pgPoolConfig } from "./index";

describe("Azure PostgreSQL TLS enforcement (SEC-01)", () => {
  it("strips SSL query params and enforces verified TLS on Azure PostgreSQL in production", () => {
    const cfg = pgPoolConfig(
      "postgresql://u:p@tmc-doccenter-db.postgres.database.azure.com/tmc_document_center?sslmode=require&sslnegotiation=direct&application_name=dc",
      { NODE_ENV: "production" },
    );
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    expect(cfg.connectionString).not.toContain("sslmode");
    expect(cfg.connectionString).not.toContain("sslnegotiation");
    expect(cfg.connectionString).toContain("application_name=dc");

    const libpqVerifyFull = pgPoolConfig(
      "postgresql://u:p@tmc-doccenter-db.postgres.database.azure.com/tmc_document_center?uselibpqcompat=true&sslmode=verify-full",
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
