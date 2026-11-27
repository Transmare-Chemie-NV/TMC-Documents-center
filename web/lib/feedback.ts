// Feedback overview (admin only): what people corrected or rejected at the check, so Willem
// can see where the engine's reading rules need work. Read-only: it never changes documents.
import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./db";
import { documentRemarks, documents, feedback, jobs } from "./db/schema";
import { listRemarksForFeedback } from "./documents/remarks";

export { listRemarksForFeedback };

export type Period = { from: Date };

export function periodFromDays(days: number): Period {
  const d = Math.min(366, Math.max(1, Math.round(days) || 30));
  return { from: new Date(Date.now() - d * 24 * 3600 * 1000) };
}

/** Numbers for the period. "Made via the engine" = KPI K8 (Final documents from the neutralizer). */
export async function feedbackSummary(db: Db, p: Period) {
  const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const n = sql<number>`count(*)::int`;
  const [drafts, finalViaEngine, rejected, failedJobs, corrected, confirmed, remarks, trainingFlagged] = await Promise.all([
    count(db.select({ n }).from(documents).where(and(isNotNull(documents.jobId), gte(documents.createdAt, p.from)))),
    count(
      db
        .select({ n })
        .from(documents)
        .where(and(isNotNull(documents.jobId), inArray(documents.status, ["Final", "Superseded"]), gte(documents.approvedAt, p.from))),
    ),
    count(db.select({ n }).from(feedback).where(and(eq(feedback.kind, "rejected"), gte(feedback.at, p.from)))),
    count(db.select({ n }).from(jobs).where(and(eq(jobs.state, "failed"), gte(jobs.createdAt, p.from)))),
    count(db.select({ n }).from(feedback).where(and(eq(feedback.kind, "corrected"), gte(feedback.at, p.from)))),
    count(db.select({ n }).from(feedback).where(and(eq(feedback.kind, "confirmed"), gte(feedback.at, p.from)))),
    count(db.select({ n }).from(documentRemarks).where(gte(documentRemarks.createdAt, p.from))),
    count(
      db
        .select({ n })
        .from(documentRemarks)
        .where(and(eq(documentRemarks.trainingFlag, true), gte(documentRemarks.createdAt, p.from))),
    ),
  ]);
  const checkedParts = corrected + confirmed;
  return {
    drafts,
    finalViaEngine,
    rejected,
    failedJobs,
    corrected,
    confirmed,
    correctedShare: checkedParts ? Math.round((corrected / checkedParts) * 100) : null,
    remarks,
    trainingFlagged,
  };
}

/** Feedback lines with the document they belong to, newest first. */
export async function feedbackLines(db: Db, p: Period, kinds: ("corrected" | "rejected" | "word_upload" | "edited")[], limit = 200) {
  return db
    .select({
      id: feedback.id,
      at: feedback.at,
      actor: feedback.actor,
      kind: feedback.kind,
      before: feedback.before,
      after: feedback.after,
      context: feedback.context,
      reason: feedback.reason,
      documentId: feedback.documentId,
      name: documents.name,
      type: documents.type,
    })
    .from(feedback)
    .leftJoin(documents, eq(feedback.documentId, documents.id))
    .where(and(inArray(feedback.kind, kinds), gte(feedback.at, p.from)))
    .orderBy(desc(feedback.at))
    .limit(limit);
}

/** What the engine read most often wrong: the same "before" text corrected again and again. */
export async function topCorrections(db: Db, p: Period, limit = 10) {
  const before = sql<string>`lower(trim(${feedback.before}))`;
  return db
    .select({
      before: sql<string>`min(${feedback.before})`,
      times: sql<number>`count(*)::int`,
      lastAfter: sql<string>`(array_agg(${feedback.after} order by ${feedback.at} desc))[1]`,
      types: sql<string>`string_agg(distinct ${documents.type}::text, ', ')`,
    })
    .from(feedback)
    .leftJoin(documents, eq(feedback.documentId, documents.id))
    .where(and(eq(feedback.kind, "corrected"), gte(feedback.at, p.from)))
    .groupBy(before)
    .orderBy(desc(sql`count(*)`), before)
    .limit(limit);
}

export async function failedJobs(db: Db, p: Period, limit = 50) {
  return db
    .select({ id: jobs.id, at: jobs.createdAt, kind: jobs.kind, route: jobs.route, file: jobs.supplierFile, log: jobs.log, createdBy: jobs.createdBy })
    .from(jobs)
    .where(and(eq(jobs.state, "failed"), gte(jobs.createdAt, p.from)))
    .orderBy(desc(jobs.createdAt))
    .limit(limit);
}

const FORMULA_TRIGGER = /^[\s\u00A0]*[=+\-@|]/;

const csvCell = (v: unknown) => {
  let s = v instanceof Date ? v.toISOString() : String(v ?? "");
  // Flatten CR/LF/TAB to spaces so multiline remarks cannot break out into new rows or trigger
  // line-2 formulas in CSV importers, and neutralise any cell whose first non-space character is
  // a spreadsheet formula trigger (= + - @ |) (SEC-01).
  s = s.replace(/\r\n?|\n/g, " ").replace(/\t/g, " ");
  if (FORMULA_TRIGGER.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function toCsv(rows: Record<string, unknown>[], columns: string[]) {
  return [columns.join(";"), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(";"))].join("\r\n");
}
