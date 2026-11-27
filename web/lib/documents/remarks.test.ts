import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb, type Db } from "../db";
import { auditLog, documents } from "../db/schema";
import { newUploadKey } from "../files";
import { addDocumentRemark, cleanRemarkText, listDocumentRemarks, listRemarksForFeedback, RemarkError } from "./remarks";
import { documentStatusCounts } from "./service";

let db: Db;
let docId: string;
const actor = { email: "stijn@transmare.com", name: "Stijn", role: "user" as const };

beforeEach(async () => {
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
      createdBy: actor.email,
      docxKey: newUploadKey("docx"),
    })
    .returning();
  docId = doc.id;
});

describe("document remarks & training flags", () => {
  it("stores a remark with training flag, strips invisible control/BiDi/Tag chars, and writes audit log", async () => {
    const saved = await addDocumentRemark(db, actor, {
      documentId: docId,
      remark: "  Row 6\u009B sub-impurities\u202E\u061C\u{E0001} missed on scan\x07  ",
      trainingFlag: true,
      category: "missing_rows",
    });
    expect(saved.remark).toBe("Row 6 sub-impurities missed on scan");
    expect(saved.trainingFlag).toBe(true);
    expect(saved.category).toBe("missing_rows");
    expect(saved.actor).toBe(actor.email);

    const list = await listDocumentRemarks(db, docId);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(saved.id);

    const audit = await db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("document.remark_added");
    expect(audit[0].documentId).toBe(docId);
    expect(audit[0].details).toEqual({ category: "missing_rows", trainingFlag: true });
  });

  it("rejects missing document, invalid uuid, short/long remark, astral code-point mismatch, oversized raw payload, and bad category (SEC-02, SEC-03)", async () => {
    await expect(
      addDocumentRemark(db, actor, { documentId: "not-a-uuid", remark: "Valid note", trainingFlag: false, category: "other" }),
    ).rejects.toThrow(RemarkError);

    await expect(
      addDocumentRemark(db, actor, {
        documentId: "00000000-0000-4000-8000-000000000000",
        remark: "Valid note",
        trainingFlag: false,
        category: "other",
      }),
    ).rejects.toThrow(/Document not found/);

    await expect(
      addDocumentRemark(db, actor, { documentId: docId, remark: "  ab ", trainingFlag: false, category: "other" }),
    ).rejects.toThrow(/at least 3/);

    // SEC-02: two astral emoji have JS UTF-16 length 4, but PostgreSQL char_length 2 -> must reject cleanly as RemarkError
    await expect(
      addDocumentRemark(db, actor, { documentId: docId, remark: "😀😀", trainingFlag: false, category: "other" }),
    ).rejects.toThrow(/at least 3/);

    await expect(
      addDocumentRemark(db, actor, { documentId: docId, remark: "x".repeat(1001), trainingFlag: false, category: "other" }),
    ).rejects.toThrow(/at most 1000/);

    // SEC-03: raw payload > 4000 chars rejected before regex passes even if mostly invisible chars
    await expect(
      addDocumentRemark(db, actor, { documentId: docId, remark: "\u200B".repeat(4001) + "valid", trainingFlag: false, category: "other" }),
    ).rejects.toThrow(/at most 1000/);

    await expect(
      addDocumentRemark(db, actor, {
        documentId: docId,
        remark: "Valid note",
        trainingFlag: false,
        category: "injected" as never,
      }),
    ).rejects.toThrow(/Invalid remark category/);
  });

  it("filters training-only remarks and joins internal supplier metadata for admin feedback queue", async () => {
    await addDocumentRemark(db, actor, {
      documentId: docId,
      remark: "Checked fine, no issues",
      trainingFlag: false,
      category: "good_example",
    });
    await addDocumentRemark(db, actor, {
      documentId: docId,
      remark: "Supplier letterhead leaked into row 3",
      trainingFlag: true,
      category: "supplier_leak",
    });

    const since = new Date(Date.now() - 3600_000);
    const all = await listRemarksForFeedback(db, since);
    expect(all).toHaveLength(2);
    expect(all[0].category).toBe("supplier_leak");
    expect(all[0].supplierName).toBe("Acutaas Chemicals");
    expect(all[0].fileNr).toBe("840.S0850");

    const flagged = await listRemarksForFeedback(db, since, { trainingOnly: true });
    expect(flagged).toHaveLength(1);
    expect(flagged[0].trainingFlag).toBe(true);
    expect(flagged[0].remark).toContain("letterhead");
  });

  it("enforces per-actor rolling cap (30/15m) and 100-remark per-document cap across actors (SEC-03)", async () => {
    for (let i = 0; i < 30; i++) {
      await addDocumentRemark(db, actor, {
        documentId: docId,
        remark: `Actor 1 remark ${i + 1}`,
        trainingFlag: false,
        category: "other",
      });
    }
    await expect(
      addDocumentRemark(db, actor, {
        documentId: docId,
        remark: "Actor 1 remark 31",
        trainingFlag: false,
        category: "other",
      }),
    ).rejects.toThrow(/Too many remarks added recently/);

    // Fill the remaining 70 remarks across 3 additional actors to verify the 100/doc hard cap
    for (let u = 2; u <= 4; u++) {
      const other = { email: `user${u}@transmare.com`, name: `User ${u}`, role: "user" as const };
      const count = u === 4 ? 10 : 30;
      for (let i = 0; i < count; i++) {
        await addDocumentRemark(db, other, {
          documentId: docId,
          remark: `Actor ${u} remark ${i + 1}`,
          trainingFlag: false,
          category: "other",
        });
      }
    }
    const fifth = { email: "user5@transmare.com", name: "User 5", role: "user" as const };
    await expect(
      addDocumentRemark(db, fifth, {
        documentId: docId,
        remark: "Remark number 101",
        trainingFlag: false,
        category: "other",
      }),
    ).rejects.toThrow(/Maximum of 100/);
  });

  it("cleanRemarkText normalises CRLF and strips C1, BiDi, line-separator, and Unicode Tag characters (SEC-02)", () => {
    expect(cleanRemarkText("line1\r\n\uFEFF\u009B\u2028\u061C\u{E0020}line2\u200B")).toBe("line1\nline2");
  });

  it("documentStatusCounts aggregates counts across statuses", async () => {
    await db.insert(documents).values({
      name: "TMC_COA_840.S0850_Final_B2",
      type: "COA",
      entity: "TMC",
      productName: "Final Prod",
      batch: "B2",
      status: "Final",
      version: 1,
      createdBy: actor.email,
      pdfKey: newUploadKey("pdf"),
    });
    const counts = await documentStatusCounts(db);
    expect(counts["To check"]).toBe(1);
    expect(counts.Final).toBe(1);
    expect(counts.Rejected).toBe(0);
  });
});
