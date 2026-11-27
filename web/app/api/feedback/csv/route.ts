// Feedback and training-remarks export for Excel (admin only). Semicolons, UTF-8 with BOM so Excel shows accented characters.
import { logAudit } from "@/lib/audit";
import { apiUser } from "@/lib/auth";
import { REMARK_CATEGORY_LABELS } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { feedbackLines, listRemarksForFeedback, periodFromDays, toCsv } from "@/lib/feedback";

export async function GET(req: Request) {
  const admin = await apiUser("admin");
  if (!admin) return new Response("Not allowed", { status: 403 });
  const sp = new URL(req.url).searchParams;
  const rawDays = Number(sp.get("days"));
  const days = Number.isFinite(rawDays) ? Math.min(366, Math.max(1, Math.round(rawDays) || 30)) : 30;
  const scope = sp.get("scope") === "remarks" ? "remarks" : "feedback";
  const trainingOnly = sp.get("trainingOnly") === "1";
  const db = await getDb();
  const period = periodFromDays(days);

  let csv: string;
  let filename: string;
  let rowCount: number;

  if (scope === "remarks") {
    const rawRows = await listRemarksForFeedback(db, period.from, { trainingOnly, limit: 5000 });
    rowCount = rawRows.length;
    const rows = rawRows.map((r) => ({
      at: r.at,
      actor: r.actor,
      trainingFlag: r.trainingFlag ? "yes" : "no",
      category: REMARK_CATEGORY_LABELS[r.category] ?? r.category,
      type: r.type,
      status: r.status,
      entity: r.entity,
      name: r.name,
      productName: r.productName ?? "",
      fileNr: r.fileNr ?? "",
      batch: r.batch ?? "",
      supplierName: r.supplierName ?? "",
      remark: r.remark,
    }));
    csv = toCsv(rows, [
      "at",
      "actor",
      "trainingFlag",
      "category",
      "type",
      "status",
      "entity",
      "name",
      "productName",
      "fileNr",
      "batch",
      "supplierName",
      "remark",
    ]);
    filename = trainingOnly ? `tmc-training-remarks-${days}d.csv` : `tmc-remarks-${days}d.csv`;
  } else {
    const rows = await feedbackLines(db, period, ["corrected", "edited", "rejected", "word_upload"], 5000);
    rowCount = rows.length;
    csv = toCsv(rows, ["at", "actor", "kind", "name", "type", "context", "before", "after", "reason"]);
    filename = `tmc-feedback-${days}d.csv`;
  }

  await logAudit(db, admin, "feedback.exported", null, { days, scope, trainingOnly, rows: rowCount });
  return new Response(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
