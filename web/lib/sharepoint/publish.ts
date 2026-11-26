// Publishes Final TMC documents (PDF + Word) to SharePoint order folders (or General/).
// Hard rules enforced here:
//   - Rule 2 & 3: ONLY Final documents with a version >= 1 are ever published; drafts, rejected,
//     superseded and supplier originals are NEVER published outside _app-storage/.
//   - Rule 4: versioned filenames (<name>_v1.pdf, <name>_v1.docx, _v2...) + conflictBehavior=fail,
//     so an existing file in SharePoint is never overwritten.
//   - Rule 5: base stem comes strictly from doc.name (BRIEF 7.5), checked with plainName().
// Concurrency (SEC-04): atomic DB lease (`sharepoint_publishing_at`, 5-min stale timeout),
// immediate PDF path persistence with COALESCE, non-destructive error recording.
import "server-only";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { logAudit, type Actor } from "../audit";
import type { Db } from "../db";
import { documents, type Document } from "../db/schema";
import { detectType, maxFileBytes } from "../files";
import { plainName } from "../naming";
import type { Storage } from "../storage";
import { SharePointConflictError, SharePointError, type SharePointClient } from "./client";
import {
  isInsideInternalStorage,
  isWithinFolder,
  safeFolderName,
  sanitizeRelativePath,
  type SharePointConfig,
} from "./config";
import { readStreamSafe } from "./guard";

const PDF_TYPE = "application/pdf";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PUBLISH_LEASE_MINUTES = 5;

export type PublishResult =
  | {
      ok: true;
      alreadyPublished?: boolean;
      folderPath: string;
      pdfPath: string;
      docxPath: string | null;
      webUrl: string | null;
    }
  | { ok: false; error: string };

/** Versioned SharePoint filename: <BRIEF 7.5 stem>_v<version>.<ext>. */
export function versionedFilename(stem: string, version: number, ext: ".pdf" | ".docx"): string {
  if (!plainName(stem)) throw new Error("invalid document name for SharePoint publishing");
  if (!Number.isInteger(version) || version < 1) throw new Error("invalid document version");
  return `${stem}_v${version}${ext}`;
}

function appendOutputSubfolder(base: string, outputSubfolder: string): string {
  if (!outputSubfolder) return base;
  const last = base.split("/").filter(Boolean).pop()?.toLowerCase();
  if (last === outputSubfolder.toLowerCase()) return base;
  return `${base}/${outputSubfolder}`;
}

/**
 * Resolves the target SharePoint folder for a Final document (SEC-05):
 *   1. No dossier/fileNr -> SHAREPOINT_GENERAL_FOLDER (default "General")
 *   2. Originating SharePoint folder path remembered on the document ONLY when it stays inside
 *      ordersRoot, stays outside _app-storage and General, still matches fileNr, AND already
 *      exists as a trusted folder in SharePoint (never creates arbitrary client-supplied trees).
 *   3. Exact folder-name match inside SHAREPOINT_ORDERS_ROOT (search)
 *   4. Otherwise <ordersRoot>/<fileNr> (created automatically by uploadFile)
 * Optional SHAREPOINT_OUTPUT_SUBFOLDER is appended for order folders (not General).
 */
export async function resolvePublishFolder(
  client: SharePointClient,
  cfg: SharePointConfig,
  doc: Pick<Document, "fileNr" | "sharepointFolderPath">,
): Promise<string> {
  const fileNr = doc.fileNr?.trim();
  if (!fileNr) return cfg.generalFolder;

  // 1. Reuse the originating order folder only when verified to already exist and remain safe.
  if (doc.sharepointFolderPath) {
    try {
      const remembered = sanitizeRelativePath(doc.sharepointFolderPath, { allowEmpty: true });
      const lastSeg = remembered.split("/").filter(Boolean).pop() ?? "";
      if (
        remembered &&
        !isInsideInternalStorage(remembered, undefined, cfg.storageFolder) &&
        !isWithinFolder(remembered, cfg.generalFolder) &&
        isWithinFolder(remembered, cfg.ordersRoot) &&
        lastSeg.toLowerCase().includes(fileNr.toLowerCase())
      ) {
        const existing = await client.getItemByPath(remembered);
        if (
          existing &&
          existing.isFolder &&
          existing.hasTrustedParent &&
          !isInsideInternalStorage(existing.parentPath, existing.name, cfg.storageFolder)
        ) {
          return appendOutputSubfolder(remembered, cfg.outputSubfolder);
        }
      }
    } catch {
      // fall through to search / deterministic folder
    }
  }

  // 2. Look for an existing folder with exact dossier name inside ordersRoot.
  try {
    const found = await client.searchItems(fileNr, { rootPath: cfg.ordersRoot || undefined, limit: 25 });
    const exact = found.filter(
      (it) =>
        it.isFolder &&
        it.hasTrustedParent &&
        it.name.toLowerCase() === fileNr.toLowerCase() &&
        !isInsideInternalStorage(it.parentPath, it.name, cfg.storageFolder) &&
        !isWithinFolder([it.parentPath, it.name].filter(Boolean).join("/"), cfg.generalFolder) &&
        isWithinFolder([it.parentPath, it.name].filter(Boolean).join("/"), cfg.ordersRoot),
    );
    if (exact.length === 1) {
      const matched = [exact[0].parentPath, exact[0].name].filter(Boolean).join("/");
      return appendOutputSubfolder(matched, cfg.outputSubfolder);
    }
  } catch {
    // search hiccup: fall back to deterministic path below
  }

  // 3. Deterministic path under ordersRoot.
  const base = [cfg.ordersRoot, safeFolderName(fileNr)].filter(Boolean).join("/");
  return appendOutputSubfolder(base, cfg.outputSubfolder);
}

async function readStoredBytes(storage: Storage, key: string, kind: "pdf" | "docx"): Promise<Uint8Array> {
  const file = await storage.get(key);
  if (!file) throw new SharePointError(`stored ${kind} file not found`);
  const read = await readStreamSafe(file.stream, {
    maxBytes: maxFileBytes(kind),
    validateHead: (head) => detectType(kind, head),
  });
  if (!read.ok) throw new SharePointError(`stored ${kind} file could not be verified`);
  return read.bytes;
}

/** Allowlisted user-facing error messages: never stores or returns raw DB/internal errors (SEC-06). */
function safePublishError(err: unknown): string {
  if (err instanceof SharePointConflictError) {
    return "A file with this exact version name already exists in SharePoint (not overwritten).";
  }
  if (err instanceof SharePointError) {
    return err.status
      ? `SharePoint returned HTTP ${err.status}. Try again later.`
      : "Could not publish to SharePoint right now. Try again later.";
  }
  return "SharePoint publish failed. Try again or contact the administrator.";
}

/**
 * Publishes one Final document's PDF (and Word file when present) to SharePoint.
 * Uses an atomic DB lease (SEC-04) so concurrent worker/user publishes cannot race into 409 deadlocks.
 */
export async function publishFinalToSharePoint(
  db: Db,
  storage: Storage,
  client: SharePointClient,
  cfg: SharePointConfig,
  documentId: string,
  actor: Pick<Actor, "email">,
): Promise<PublishResult> {
  // Atomically claim the publish lease only when Final, not yet published, and no fresh lease active.
  const [claimed] = await db
    .update(documents)
    .set({ sharepointPublishingAt: new Date() })
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.status, "Final"),
        isNull(documents.sharepointPublishedAt),
        or(
          isNull(documents.sharepointPublishingAt),
          lt(documents.sharepointPublishingAt, sql`now() - make_interval(mins => ${PUBLISH_LEASE_MINUTES})`),
        ),
      ),
    )
    .returning();

  if (!claimed) {
    const [existing] = await db.select().from(documents).where(eq(documents.id, documentId));
    if (!existing) return { ok: false, error: "document not found" };
    if (existing.status !== "Final" || !existing.version || existing.version < 1 || !existing.pdfKey) {
      return { ok: false, error: "only Final documents can be published to SharePoint" };
    }
    if (existing.sharepointPublishedAt && existing.sharepointPdfPath && (!existing.docxKey || existing.sharepointDocxPath)) {
      return {
        ok: true,
        alreadyPublished: true,
        folderPath: existing.sharepointFolderPath ?? "",
        pdfPath: existing.sharepointPdfPath,
        docxPath: existing.sharepointDocxPath,
        webUrl: existing.sharepointWebUrl,
      };
    }
    return { ok: false, error: "SharePoint publish is already in progress. Refresh in a moment." };
  }

  const doc = claimed;
  if (!doc.version || doc.version < 1 || !doc.pdfKey) {
    await db
      .update(documents)
      .set({ sharepointPublishingAt: null })
      .where(and(eq(documents.id, doc.id), isNull(documents.sharepointPublishedAt)));
    return { ok: false, error: "only Final documents can be published to SharePoint" };
  }

  let pdfPath = doc.sharepointPdfPath;
  let docxPath = doc.sharepointDocxPath;
  let webUrl = doc.sharepointWebUrl;
  let folderPath = "";

  try {
    folderPath = await resolvePublishFolder(client, cfg, doc);
    if (isInsideInternalStorage(folderPath, undefined, cfg.storageFolder)) {
      throw new SharePointError("refused to publish into internal app storage folder");
    }

    if (!pdfPath) {
      const pdfBytes = await readStoredBytes(storage, doc.pdfKey, "pdf");
      const targetPdf = `${folderPath}/${versionedFilename(doc.name, doc.version, ".pdf")}`;
      const uploadedPdf = await client.uploadFile(targetPdf, pdfBytes, PDF_TYPE);
      pdfPath = targetPdf;
      webUrl = uploadedPdf.webUrl ?? webUrl;
      // Persist PDF path immediately so a crash or DOCX error never loses track of the uploaded PDF.
      await db
        .update(documents)
        .set({
          sharepointFolderPath: folderPath,
          sharepointPdfPath: sql`coalesce(${documents.sharepointPdfPath}, ${pdfPath})`,
          sharepointWebUrl: sql`coalesce(${documents.sharepointWebUrl}, ${webUrl})`,
        })
        .where(and(eq(documents.id, doc.id), isNull(documents.sharepointPublishedAt)));
    }

    if (doc.docxKey && !docxPath) {
      const docxBytes = await readStoredBytes(storage, doc.docxKey, "docx");
      const targetDocx = `${folderPath}/${versionedFilename(doc.name, doc.version, ".docx")}`;
      await client.uploadFile(targetDocx, docxBytes, DOCX_TYPE);
      docxPath = targetDocx;
    }

    const now = new Date();
    await db
      .update(documents)
      .set({
        sharepointFolderPath: folderPath,
        sharepointPdfPath: pdfPath,
        sharepointDocxPath: docxPath,
        sharepointWebUrl: webUrl,
        sharepointPublishedAt: now,
        sharepointPublishingAt: null,
        sharepointError: null,
      })
      .where(eq(documents.id, doc.id));

    await logAudit(db, actor, "sharepoint.published", doc.id, {
      folderPath,
      pdfPath,
      docxPath,
      version: doc.version,
    });

    return { ok: true, folderPath, pdfPath, docxPath, webUrl };
  } catch (err) {
    const message = safePublishError(err);
    // Non-destructive update: never clobber an already-published row or null out previously saved paths (SEC-04).
    await db
      .update(documents)
      .set({
        sharepointFolderPath: sql`coalesce(${documents.sharepointFolderPath}, ${folderPath || null})`,
        sharepointPdfPath: sql`coalesce(${documents.sharepointPdfPath}, ${pdfPath})`,
        sharepointDocxPath: sql`coalesce(${documents.sharepointDocxPath}, ${docxPath})`,
        sharepointWebUrl: sql`coalesce(${documents.sharepointWebUrl}, ${webUrl})`,
        sharepointPublishingAt: null,
        sharepointError: message,
      })
      .where(and(eq(documents.id, doc.id), isNull(documents.sharepointPublishedAt)));
    await logAudit(db, actor, "sharepoint.publish_failed", doc.id, {
      error: err instanceof Error ? err.name : "error",
      ...(err instanceof SharePointError && err.status ? { status: err.status } : {}),
      version: doc.version,
    });
    return { ok: false, error: message };
  }
}
