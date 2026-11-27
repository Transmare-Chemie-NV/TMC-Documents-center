import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb, type Db } from "@/lib/db";
import { auditLog, documentRemarks, documents } from "@/lib/db/schema";
import { newUploadKey } from "@/lib/files";

type Role = "admin" | "approver" | "user";
let currentUser: { email: string; name: string; role: Role } | null = null;
let db: Db;

vi.mock("@/lib/auth", () => ({
  apiUser: async (requiredRole?: Role) => {
    if (!currentUser) return null;
    if (requiredRole === "admin" && currentUser.role !== "admin") return null;
    return currentUser;
  },
}));
vi.mock("@/lib/db", async (orig) => {
  const actual = await orig<typeof import("@/lib/db")>();
  return { ...actual, getDb: async () => db };
});

import { GET } from "./route";

beforeEach(async () => {
  currentUser = null;
  db = await createPgliteDb();
  const [doc] = await db
    .insert(documents)
    .values({
      name: "TMC_COA_840.S0850_Propyl_Paraben_B1",
      type: "COA",
      entity: "TMC",
      productName: "Propyl Paraben",
      batch: "B1",
      fileNr: "840.S0850",
      supplierName: "Acutaas Chemicals",
      status: "To check",
      createdBy: "stijn@transmare.com",
      docxKey: newUploadKey("docx"),
    })
    .returning();
  await db.insert(documentRemarks).values([
    {
      documentId: doc.id,
      actor: "stijn@transmare.com",
      remark: " =HYPERLINK(\"https://evil.example\")\n;=cmd|'/C calc'!A0",
      trainingFlag: true,
      category: "missing_rows",
    },
    {
      documentId: doc.id,
      actor: "sigi@transmare.com",
      remark: "Looks clean",
      trainingFlag: false,
      category: "good_example",
    },
  ]);
});

describe("GET /api/feedback/csv (SEC-01, SEC-04)", () => {
  it("returns 403 for unauthenticated, user, and approver on all scopes", async () => {
    for (const user of [
      null,
      { email: "stijn@transmare.com", name: "Stijn", role: "user" as const },
      { email: "kars@transmare.com", name: "Kars", role: "approver" as const },
    ]) {
      currentUser = user;
      for (const qs of ["?days=30", "?days=30&scope=remarks", "?days=30&scope=remarks&trainingOnly=1"]) {
        const res = await GET(new Request(`https://doccenter.example/api/feedback/csv${qs}`));
        expect(res.status).toBe(403);
      }
    }
  });

  it("exports training remarks CSV for admin with hardened headers, clamped days, and neutralized formulas", async () => {
    currentUser = { email: "willem@transmare.com", name: "Willem", role: "admin" };
    const res = await GET(new Request("https://doccenter.example/api/feedback/csv?days=9999&scope=remarks&trainingOnly=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="tmc-training-remarks-366d.csv"');
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8").decode(bytes);
    const lines = text.split("\r\n");
    // Header + 1 training-flagged row only (multiline remark flattened onto single row and prefixed with ')
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"\' =HYPERLINK(""https://evil.example"") ;=cmd|\'/C calc\'!A0"');
    expect(lines[1]).not.toContain("Looks clean");

    const audit = await db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("feedback.exported");
    expect(audit[0].details).toEqual({ days: 366, scope: "remarks", trainingOnly: true, rows: 1 });
  });
});
