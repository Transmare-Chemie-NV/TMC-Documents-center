"use server";

import { requireUser } from "@/lib/auth";
import type { RemarkCategory } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { addDocumentRemark, RemarkError } from "@/lib/documents/remarks";
import { JobError, rerunJob } from "@/lib/jobs";
import { getSharePoint, publishFinalToSharePoint } from "@/lib/sharepoint";
import { getStorage } from "@/lib/storage";

export type RerunResult = { ok: true } | { ok: false; error: string };
export type PublishActionResult = { ok: true } | { ok: false; error: string };
export type RemarkItem = {
  id: number;
  actor: string;
  remark: string;
  trainingFlag: boolean;
  category: RemarkCategory;
  createdAt: string;
};
export type SaveRemarkResult = { ok: true; item: RemarkItem } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Anyone logged in may run a draft again, as anyone may check one (Willem 02/11).
export async function rerunDraft(documentId: string): Promise<RerunResult> {
  const user = await requireUser();
  if (typeof documentId !== "string" || !UUID_RE.test(documentId)) return { ok: false, error: "Document not found." };
  try {
    await rerunJob(await getDb(), getStorage(), user, documentId);
    return { ok: true };
  } catch (err) {
    if (err instanceof JobError) return { ok: false, error: err.message };
    console.error("rerunDraft failed:", err instanceof Error ? err.name : typeof err);
    return { ok: false, error: "That did not work. Try again or tell the administrator." };
  }
}

export async function publishDocumentToSharePoint(documentId: string): Promise<PublishActionResult> {
  const user = await requireUser();
  if (typeof documentId !== "string" || !UUID_RE.test(documentId)) return { ok: false, error: "Document not found." };
  try {
    const sp = getSharePoint();
    if (!sp) return { ok: false, error: "SharePoint is not configured." };
    const result = await publishFinalToSharePoint(await getDb(), getStorage(), sp.client, sp.cfg, documentId, user);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (err) {
    console.error("publishDocumentToSharePoint failed:", err instanceof Error ? err.name : typeof err);
    return { ok: false, error: "Publishing to SharePoint failed. Try again or tell the administrator." };
  }
}

// Anyone logged in may add an internal remark or flag a document for engine/AI training (Willem 27/11).
export async function saveDocumentRemark(
  documentId: string,
  raw: { remark: string; trainingFlag: boolean; category: RemarkCategory },
): Promise<SaveRemarkResult> {
  const user = await requireUser();
  if (typeof documentId !== "string" || !UUID_RE.test(documentId)) return { ok: false, error: "Document not found." };
  if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid remark input." };
  try {
    const created = await addDocumentRemark(await getDb(), user, {
      documentId,
      remark: raw.remark,
      trainingFlag: raw.trainingFlag,
      category: raw.category,
    });
    return {
      ok: true,
      item: {
        id: created.id,
        actor: created.actor,
        remark: created.remark,
        trainingFlag: created.trainingFlag,
        category: created.category,
        createdAt: created.createdAt.toISOString(),
      },
    };
  } catch (err) {
    if (err instanceof RemarkError) return { ok: false, error: err.message };
    console.error("saveDocumentRemark failed:", err instanceof Error ? err.name : typeof err);
    return { ok: false, error: "Could not save remark. Try again or tell the administrator." };
  }
}
