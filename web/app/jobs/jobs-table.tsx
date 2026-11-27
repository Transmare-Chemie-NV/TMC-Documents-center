// The list of neutralise jobs: under the Neutralise form (Willem 22/10: Jobs folded into
// Neutralise) and on the full Jobs page.
import Link from "next/link";
import { JobStateBadge } from "@/components/status-badge";
import { dossierHref } from "@/lib/documents/dossier";
import { formatDateTime } from "@/lib/format";
import type { listJobs } from "@/lib/jobs";

export function JobsTable({ rows }: { rows: Awaited<ReturnType<typeof listJobs>> }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-black/5">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="bg-tmc-light text-tmc">
          <tr>
            <th className="px-3 py-2.5">Sent</th>
            <th className="px-3 py-2.5">Supplier document</th>
            <th className="px-3 py-2.5">Type / entity</th>
            <th className="px-3 py-2.5">Typed values</th>
            <th className="px-3 py-2.5">State</th>
            <th className="px-3 py-2.5">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                No jobs yet.
              </td>
            </tr>
          )}
          {rows.map(({ job, documents }) => (
            <tr key={job.id} className="border-t border-gray-100 align-top">
              <td className="whitespace-nowrap px-3 py-2.5">
                {formatDateTime(job.createdAt)}
                <div className="text-xs text-gray-500">{job.createdBy}</div>
              </td>
              <td className="break-all px-3 py-2.5 font-medium text-gray-900">
                {job.supplierFile?.filename ?? "Finalise"}
                {job.commercialFiles.length > 0 && (
                  <div className="text-xs font-normal text-gray-500">+ {job.commercialFiles.map((f) => f.filename).join(", ")}</div>
                )}
              </td>
              <td className="px-3 py-2.5">
                <span className="rounded bg-tmc-light px-1.5 py-0.5 text-xs font-semibold text-tmc">{job.route.toUpperCase()}</span>
                <span className="ml-1.5 text-xs text-gray-700">{job.entity}</span>
                {job.apiJobId && (
                  <Link href={`/api-jobs/${job.apiJobId}`} className="mt-1 block text-xs text-tmc underline">
                    Request from TMC Logistics
                  </Link>
                )}
              </td>
              <td className="px-3 py-2.5 text-xs">
                {[job.productName, job.batch].filter(Boolean).join(" · ")}
                {job.fileNr && (
                  <Link href={dossierHref(job.fileNr)} className="block font-medium text-tmc underline" title="Dossier overview">
                    {job.fileNr}
                  </Link>
                )}
                {!job.productName && !job.batch && !job.fileNr && <span className="text-gray-400">-</span>}
                {job.rerunOf && <span className="mt-1 block text-gray-500">Run again</span>}
              </td>
              <td className="px-3 py-2.5">
                <JobStateBadge state={job.state} />
                {job.state === "to_check" && job.log?.includes("HELD BACK") && (
                  <span className="mt-1 block text-xs font-normal text-amber-800">Some batches got no document: see the log</span>
                )}
                {(job.state === "failed" || job.state === "to_check") && job.log && (
                  <details className="mt-1.5 text-xs font-normal text-gray-700">
                    <summary className="cursor-pointer text-tmc hover:underline">Show log</summary>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2">{job.log.slice(-4000)}</pre>
                  </details>
                )}
              </td>
              <td className="px-3 py-2.5">
                <div className="space-y-1.5">
                  {documents.map((d) => (
                    <div key={d.id} className="flex flex-wrap items-center gap-2">
                      {d.status === "To check" ? (
                        <>
                          <Link
                            href={`/documents/${d.id}/check`}
                            className="inline-flex items-center rounded-md bg-tmc px-2.5 py-1 text-xs font-semibold text-white shadow-2xs transition-colors hover:bg-tmc-dark"
                          >
                            Check now
                          </Link>
                          <Link href={`/documents/${d.id}/check`} className="break-all text-xs text-tmc hover:underline">
                            {d.name}
                          </Link>
                        </>
                      ) : (
                        <Link href={`/documents/${d.id}`} className="break-all text-sm text-tmc hover:underline">
                          {d.name}
                          <span className="ml-1 text-xs text-gray-500">({d.status})</span>
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
