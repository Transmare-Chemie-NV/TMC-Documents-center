// Internal document remarks & training flags (Phase 4c).
// Strictly internal metadata: never printed on TMC outputs, never sent to the Python engine,
// and never exposed on /api/v1/* endpoints (Hard Rule 3).
import "server-only";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { logAudit, type Actor } from "../audit";
import { REMARK_CATEGORIES, type RemarkCategory } from "../constants";
import type { Db } from "../db";
import { documentRemarks, documents, type DocumentRemark } from "../db/schema";
import { cleanDocText } from "./edits";

export class RemarkError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REMARKS_PER_DOC = 100;
const MAX_REMARKS_PER_ACTOR_15M = 30;
const ACTOR_WINDOW_MS = 15 * 60 * 1000;
const MIN_REMARK_LEN = 3;
const MAX_REMARK_LEN = 1000;
const MAX_RAW_REMARK_LEN = 4000;

/** Normalise line endings and strip all C0/C1 control, BiDi, Tag, and invisible format characters (SEC-02). */
export function cleanRemarkText(raw: string): string {
  return cleanDocText(raw).trim();
}

function safeLimit(limit: unknown, fallback: number, max: number): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.round(limit) : fallback;
  return Math.min(max, Math.max(1, n));
}

export type AddRemarkInput = {
  documentId: string;
  remark: string;
  trainingFlag: boolean;
  category: RemarkCategory;
};

export async function addDocumentRemark(db: Db, actor: Actor, raw: AddRemarkInput): Promise<DocumentRemark> {
  if (typeof raw.documentId !== "string" || !UUID_RE.test(raw.documentId)) {
    throw new RemarkError("Document not found.");
  }
  if (typeof raw.remark !== "string") {
    throw new RemarkError("Please write a short remark.");
  }
  // Reject unbounded payloads before running Unicode regex passes (SEC-03).
  if (raw.remark.length > MAX_RAW_REMARK_LEN) {
    throw new RemarkError(`Remark must be at most ${MAX_REMARK_LEN} characters.`);
  }
  const text = cleanRemarkText(raw.remark);
  // Count Unicode code points to match PostgreSQL char_length(trim(remark)) (SEC-02).
  const codePoints = [...text].length;
  if (codePoints < MIN_REMARK_LEN) {
    throw new RemarkError(`Remark must be at least ${MIN_REMARK_LEN} characters.`);
  }
  if (codePoints > MAX_REMARK_LEN) {
    throw new RemarkError(`Remark must be at most ${MAX_REMARK_LEN} characters.`);
  }
  if (typeof raw.trainingFlag !== "boolean") {
    throw new RemarkError("Invalid training flag.");
  }
  if (typeof raw.category !== "string" || !(REMARK_CATEGORIES as readonly string[]).includes(raw.category)) {
    throw new RemarkError("Invalid remark category.");
  }

  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, raw.documentId))
      .for("update");
    if (!doc) throw new RemarkError("Document not found.");

    // Rolling per-actor cap prevents queue/audit flooding across documents (SEC-03).
    const windowStart = new Date(Date.now() - ACTOR_WINDOW_MS);
    const [{ recent }] = await tx
      .select({ recent: sql<number>`count(*)::int` })
      .from(documentRemarks)
      .where(and(eq(documentRemarks.actor, actor.email), gte(documentRemarks.createdAt, windowStart)));
    if (recent >= MAX_REMARKS_PER_ACTOR_15M) {
      throw new RemarkError("Too many remarks added recently. Please wait a few minutes.");
    }

    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(documentRemarks)
      .where(eq(documentRemarks.documentId, raw.documentId));
    if (n >= MAX_REMARKS_PER_DOC) {
      throw new RemarkError(`Maximum of ${MAX_REMARKS_PER_DOC} remarks per document reached.`);
    }

    const [created] = await tx
      .insert(documentRemarks)
      .values({
        documentId: raw.documentId,
        actor: actor.email,
        remark: text,
        trainingFlag: raw.trainingFlag,
        category: raw.category,
      })
      .returning();

    await logAudit(tx, actor, "document.remark_added", raw.documentId, {
      category: raw.category,
      trainingFlag: raw.trainingFlag,
    });
    return created;
  });
}

export async function listDocumentRemarks(db: Db, documentId: string, limit = 50): Promise<DocumentRemark[]> {
  if (!UUID_RE.test(documentId)) return [];
  const cap = safeLimit(limit, 50, 100);
  return db
    .select()
    .from(documentRemarks)
    .where(eq(documentRemarks.documentId, documentId))
    .orderBy(desc(documentRemarks.createdAt), desc(documentRemarks.id))
    .limit(cap);
}

export async function listRemarksForFeedback(
  db: Db,
  from: Date,
  options: { trainingOnly?: boolean; limit?: number } = {},
) {
  const cap = safeLimit(options.limit, 200, 5000);
  const where = options.trainingOnly
    ? and(eq(documentRemarks.trainingFlag, true), gte(documentRemarks.createdAt, from))
    : gte(documentRemarks.createdAt, from);
  return db
    .select({
      id: documentRemarks.id,
      at: documentRemarks.createdAt,
      actor: documentRemarks.actor,
      remark: documentRemarks.remark,
      trainingFlag: documentRemarks.trainingFlag,
      category: documentRemarks.category,
      documentId: documentRemarks.documentId,
      name: documents.name,
      type: documents.type,
      status: documents.status,
      productName: documents.productName,
      supplierName: documents.supplierName,
      fileNr: documents.fileNr,
      batch: documents.batch,
      entity: documents.entity,
    })
    .from(documentRemarks)
    .innerJoin(documents, eq(documentRemarks.documentId, documents.id))
    .where(where)
    .orderBy(desc(documentRemarks.createdAt), desc(documentRemarks.id))
    .limit(cap);
}
