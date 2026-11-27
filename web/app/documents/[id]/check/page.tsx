import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AutoRefresh } from "@/app/jobs/auto-refresh";
import { PageShell } from "@/components/app-header";
import { DocStatusBadge } from "@/components/status-badge";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { pendingEdit } from "@/lib/documents/changes-pending";
import { listDocumentRemarks } from "@/lib/documents/remarks";
import { getDocument } from "@/lib/documents/service";
import { canRerun } from "@/lib/jobs";
import { getStorage } from "@/lib/storage";
import { RerunButton } from "../rerun-button";
import { CheckForm } from "./check-form";

export const metadata = { title: "Check · TMC Document Center" };

export default async function CheckPage({ params }: PageProps<"/documents/[id]/check">) {
  const user = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const doc = await getDocument(db, id);
  if (!doc) notFound();
  if (doc.status !== "To check") redirect(`/documents/${doc.id}`);

  const [[lastFinalise], pending, rawRemarks, allowRerun] = await Promise.all([
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.documentId, doc.id), eq(jobs.kind, "finalise")))
      .orderBy(desc(jobs.createdAt))
      .limit(1),
    pendingEdit(db, doc),
    listDocumentRemarks(db, doc.id),
    canRerun(db, doc),
  ]);

  const busy = lastFinalise && (lastFinalise.state === "queued" || lastFinalise.state === "running");
  const file = (kind: string) => `/api/files/${doc.id}/${kind}?inline=1`;
  const parts = doc.yellowParts ?? [];
  const remarks = rawRemarks.map((r) => ({
    id: r.id,
    actor: r.actor,
    remark: r.remark,
    trainingFlag: r.trainingFlag,
    category: r.category,
    createdAt: r.createdAt.toISOString(),
  }));

  return (
    <PageShell user={user} wide>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <Link href="/?status=To%20check" className="text-tmc hover:underline">
              ← To check
            </Link>
            <span>·</span>
            <Link href={`/documents/${doc.id}`} className="text-tmc hover:underline">
              Document details
            </Link>
            {doc.supplierName && (
              <>
                <span>·</span>
                <span>
                  Supplier (internal): <strong className="font-medium text-gray-700">{doc.supplierName}</strong>
                </span>
              </>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-tmc">{doc.name}</h1>
            <DocStatusBadge status={doc.status} />
          </div>
          <p className="mt-0.5 text-sm text-gray-600">
            {parts.length
              ? `${parts.length} yellow part(s) detected. Confirm or fix each one before finalising.`
              : doc.type === "LABEL"
                ? "Check the label and approve, or reject. A label made with the SAMPLE template can never become Final."
                : "Nothing marked yellow. Compare side by side with the original and approve, or reject."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {doc.previewKey && (
            <a
              href={file("preview")}
              target="_blank"
              rel="noopener"
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Draft PDF look
            </a>
          )}
          {doc.docxKey && (
            <a
              href={`/api/files/${doc.id}/docx`}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Download Word
            </a>
          )}
          {!busy && allowRerun && <RerunButton documentId={doc.id} />}
        </div>
      </div>

      {busy && (
        <div className="mt-3">
          <p className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900 ring-1 ring-blue-200">
            Being finalised by the neutralizer… This page updates itself.
          </p>
          <AutoRefresh seconds={5} />
        </div>
      )}
      {lastFinalise?.state === "failed" && (
        <details className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-200">
          <summary className="cursor-pointer font-medium">The last finalise attempt did not work. Show why</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{lastFinalise.log?.slice(-4000)}</pre>
        </details>
      )}

      {/* Legacy drafts without an editor view keep the side-by-side PDF comparison */}
      {!doc.viewKey && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <section>
            <h2 className="mb-1 text-sm font-semibold text-gray-700">Supplier original</h2>
            {doc.sourceKey ? (
              <iframe src={file("source")} title="Supplier original" className="h-[75vh] w-full rounded-lg border border-gray-200 bg-white" />
            ) : (
              <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
                {doc.type === "LABEL" ? "No original: a label is made from the values typed in the form." : "No original stored."}
              </p>
            )}
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-gray-700">TMC draft</h2>
            {doc.previewKey || doc.pdfKey ? (
              <iframe
                src={file(doc.previewKey ? "preview" : "pdf")}
                title="TMC draft"
                className="h-[75vh] w-full rounded-lg border border-gray-200 bg-white"
              />
            ) : (
              <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
                No preview available. Download the Word file to see the draft.
              </p>
            )}
          </section>
        </div>
      )}

      <CheckForm
        documentId={doc.id}
        parts={parts}
        hasPdf={!!doc.pdfKey && parts.length === 0}
        busy={!!busy}
        uploadMode={getStorage().mode}
        initial={{ productName: doc.productName ?? "", fileNr: doc.fileNr ?? "", batch: doc.batch ?? "" }}
        naming={{ type: doc.type, entity: doc.entity, batchLocked: !!doc.batch, language: doc.language, currentName: doc.name }}
        edit={{
          documentId: doc.id,
          sourceUrl: doc.sourceKey ? file("source") : null,
          viewUrl: doc.viewKey ? `/api/files/${doc.id}/view` : null,
          pending,
        }}
        remarks={remarks}
      />
    </PageShell>
  );
}
