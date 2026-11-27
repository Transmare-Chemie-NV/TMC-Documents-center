import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app-header";
import { Notice } from "@/components/notice";
import { RemarksPanel } from "@/components/remarks-panel";
import { DocStatusBadge } from "@/components/status-badge";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dossierHref } from "@/lib/documents/dossier";
import { listDocumentRemarks } from "@/lib/documents/remarks";
import { getAuditTrail, getDocument, getVersions } from "@/lib/documents/service";
import { formatDate, formatDateTime } from "@/lib/format";
import { canRerun } from "@/lib/jobs";
import { getSharePoint, isSafeSharePointHost } from "@/lib/sharepoint";
import { RerunButton } from "./rerun-button";
import { SharePointPublishButton } from "./sharepoint-publish-button";

export const metadata = { title: "Document · TMC Document Center" };

const ACTIONS: Record<string, string> = {
  "document.created": "Added",
  "document.superseded": "Replaced by a newer version",
  "document.downloaded": "Downloaded",
  "document.viewed": "Viewed",
  "document.drafted": "Draft made by the neutralizer",
  "document.finalise_requested": "Sent for finalising",
  "document.finalised": "Finalised",
  "document.rejected": "Rejected",
  "document.rerun": "Run again with the latest neutralizer",
  "document.remark_added": "Added internal remark",
  "sharepoint.published": "Published to SharePoint",
  "sharepoint.publish_failed": "SharePoint publish failed",
  "sharepoint.imported": "Imported from SharePoint",
};

function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-1 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="break-words text-gray-900">{value}</dd>
    </div>
  );
}

function Download({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="rounded-md border border-tmc bg-white px-3 py-1.5 text-sm font-medium text-tmc transition-colors hover:bg-tmc-light">
      {label}
    </a>
  );
}

export default async function DocumentPage({ params, searchParams }: PageProps<"/documents/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const doc = await getDocument(db, id);
  if (!doc) notFound();

  const [versions, rawRemarks, rerun] = await Promise.all([
    getVersions(db, doc.name),
    listDocumentRemarks(db, doc.id),
    canRerun(db, doc),
  ]);
  const trail = await getAuditTrail(
    db,
    versions.map((v) => v.id),
  );
  const remarks = rawRemarks.map((r) => ({
    id: r.id,
    actor: r.actor,
    remark: r.remark,
    trainingFlag: r.trainingFlag,
    category: r.category,
    createdAt: r.createdAt.toISOString(),
  }));

  const file = (kind: string, inline = false) => `/api/files/${doc.id}/${kind}${inline ? "?inline=1" : ""}`;
  const sourceIsPdf = doc.sourceFilename?.toLowerCase().endsWith(".pdf");
  const spClient = (() => {
    try {
      return getSharePoint();
    } catch {
      return null;
    }
  })();
  const spConfigured = !!spClient;
  const safeSpUrl =
    doc.sharepointWebUrl && isSafeSharePointHost(doc.sharepointWebUrl, spClient?.cfg.tenantHost) ? doc.sharepointWebUrl : null;
  const showSharePoint = doc.status === "Final" && (spConfigured || !!doc.sharepointPublishedAt || !!doc.sharepointError);

  return (
    <PageShell user={user} wide={!!doc.sourceKey}>
      <Link href="/" className="text-xs font-medium text-tmc hover:underline">
        ← Back to Library
      </Link>
      <div className="mt-1.5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-tmc">{doc.productName ?? "Product to confirm"}</h1>
            <DocStatusBadge status={doc.status} />
          </div>
          <p className="mt-0.5 break-all text-sm text-gray-600">
            {doc.name} · {doc.version ? `version ${doc.version}` : "draft"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {doc.status === "To check" && (
            <Link href={`/documents/${doc.id}/check`} className="rounded-md bg-tmc px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-tmc-dark">
              Check this draft
            </Link>
          )}
          {rerun && <RerunButton documentId={doc.id} />}
          {doc.pdfKey && <Download href={file("pdf")} label="Download PDF" />}
          {doc.docxKey && <Download href={file("docx")} label="Download Word" />}
          {doc.sourceKey && <Download href={file("source")} label="Supplier original" />}
        </div>
      </div>
      <Notice ok={sp.ok} error={sp.error} />
      {doc.status === "Rejected" && doc.rejectedReason && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-200">Rejected: {doc.rejectedReason}</p>
      )}
      {doc.status === "Superseded" && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          {doc.version
            ? "This is an old version. The current version is in the list below."
            : "This draft was replaced by a newer run of the neutralizer."}
        </p>
      )}
      {showSharePoint && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white px-4 py-3 text-sm shadow-sm ring-1 ring-black/5">
          {doc.sharepointPublishedAt && !doc.sharepointError ? (
            <div>
              <span className="font-medium text-emerald-700">In SharePoint</span> · {formatDateTime(doc.sharepointPublishedAt)}
              {doc.sharepointFolderPath && <span className="text-gray-600"> · folder {doc.sharepointFolderPath}</span>}
              {doc.sharepointPdfPath && (
                <div className="mt-0.5 break-all text-xs text-gray-500">
                  {doc.sharepointPdfPath}
                  {doc.sharepointDocxPath ? ` · ${doc.sharepointDocxPath}` : ""}
                </div>
              )}
            </div>
          ) : (
            <div>
              <span className="font-medium text-amber-800">Not published to SharePoint yet</span>
              {doc.sharepointError && <div className="mt-0.5 text-xs text-red-700">{doc.sharepointError}</div>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {safeSpUrl && (
              <a
                href={safeSpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-tmc px-3 py-1.5 text-sm font-medium text-tmc hover:bg-tmc-light"
              >
                Open in SharePoint
              </a>
            )}
            {spConfigured && (!doc.sharepointPublishedAt || !!doc.sharepointError) && (
              <SharePointPublishButton documentId={doc.id} label={doc.sharepointError ? "Retry SharePoint publish" : "Publish to SharePoint"} />
            )}
          </div>
        </div>
      )}

      {/* Screen-by-screen: supplier original left, TMC document right (Willem 16/10). */}
      <div className={`mt-4 grid gap-4 ${doc.sourceKey ? "lg:grid-cols-2" : ""}`}>
        {doc.sourceKey && (
          <section>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Supplier original</h2>
            {sourceIsPdf ? (
              <iframe src={file("source", true)} title="Supplier original" className="h-[76vh] w-full rounded-lg border border-gray-200 bg-white" />
            ) : (
              <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">No preview for this file type. Use the download button.</p>
            )}
          </section>
        )}
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">TMC document</h2>
            {doc.pdfKey && (
              <a href={file("pdf", true)} target="_blank" rel="noopener" className="text-xs text-tmc hover:underline">
                Open PDF in new tab
              </a>
            )}
          </div>
          {doc.pdfKey ? (
            <iframe src={file("pdf", true)} title="TMC document" className="h-[76vh] w-full rounded-lg border border-gray-200 bg-white" />
          ) : doc.previewKey && doc.status === "To check" ? (
            // the DRAFT preview, as on the check screen: the real PDF is made at Final (Willem 26/10)
            <>
              <iframe src={file("preview", true)} title="TMC draft (preview)" className="h-[76vh] w-full rounded-lg border border-gray-200 bg-white" />
              <p className="mt-1.5 text-sm text-gray-600">
                Draft preview. The real PDF is made when the draft is checked and finalised.{" "}
                <Link href={`/documents/${doc.id}/check`} className="font-medium text-tmc underline">
                  Check this draft
                </Link>
              </p>
            </>
          ) : (
            <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
              Draft: Word only. The PDF is made when the yellow parts are checked and the document is finalised.
            </p>
          )}
        </section>
      </div>

      <div className="mt-5">
        <RemarksPanel documentId={doc.id} initial={remarks} compact />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 className="mb-2 font-semibold text-gray-900">Details</h2>
          <dl>
            <Field label="Type" value={doc.type} />
            <Field label="Entity" value={doc.entity} />
            <Field label="Product" value={doc.productName} />
            <Field label="INCI name" value={doc.inciName} />
            <Field label="CAS number" value={doc.casNumber} />
            <Field label="Batch" value={doc.batch} />
            {doc.fileNr && (
              <div className="grid grid-cols-[9rem_1fr] gap-2 py-1 text-sm">
                <dt className="text-gray-500">Dossier</dt>
                <dd className="break-words">
                  <Link href={dossierHref(doc.fileNr)} className="text-tmc underline" title="Dossier overview">
                    {doc.fileNr}
                  </Link>
                </dd>
              </div>
            )}
            <Field label="PO number" value={doc.poNumber} />
            <Field label="Language" value={doc.language} />
            <Field label="Manufactured" value={formatDate(doc.manufacturingDate)} />
            <Field label="Expiry / retest" value={formatDate(doc.expiryOrRetestDate)} />
            <Field label="Supplier (internal)" value={doc.supplierName} />
            <Field label="Tags" value={doc.tags.join(", ")} />
            <Field label="Added by" value={`${doc.createdBy}, ${formatDateTime(doc.createdAt)}`} />
            <Field label="Approved by" value={doc.approvedBy ? `${doc.approvedBy}, ${formatDateTime(doc.approvedAt)}` : null} />
          </dl>
        </section>

        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 className="mb-2 font-semibold text-gray-900">Versions</h2>
          <ul className="space-y-1.5 text-sm">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-1.5">
                <Link href={`/documents/${v.id}`} className={v.id === doc.id ? "font-semibold text-gray-900" : "text-tmc underline"}>
                  {v.version ? `Version ${v.version}` : "Draft"}
                </Link>
                <DocStatusBadge status={v.status} />
                <span className="text-xs text-gray-500">{formatDateTime(v.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 className="mb-2 font-semibold text-gray-900">History</h2>
          <ul className="space-y-1.5 text-sm">
            {trail.map((a) => (
              <li key={a.id}>
                <span className="text-xs text-gray-500">{formatDateTime(a.at)}</span> · {ACTIONS[a.action] ?? a.action}
                {typeof a.details?.file === "string" && ` (${a.details.file})`}
                {typeof a.details?.version === "number" && ` v${a.details.version}`} · <span className="text-gray-600">{a.actor}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageShell>
  );
}
