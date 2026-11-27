import type { DocStatus, JobState } from "@/lib/constants";

const DOC_BADGE: Record<DocStatus, string> = {
  Final: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  "To check": "bg-amber-50 text-amber-900 ring-amber-300",
  Draft: "bg-blue-50 text-blue-800 ring-blue-200",
  Superseded: "bg-slate-100 text-slate-600 ring-slate-200",
  Rejected: "bg-red-50 text-red-800 ring-red-200",
};

export function DocStatusBadge({ status }: { status: DocStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${DOC_BADGE[status]}`}>
      {status}
    </span>
  );
}

const JOB_BADGE: Record<JobState, { label: string; style: string; dot?: string }> = {
  queued: { label: "Waiting", style: "bg-slate-100 text-slate-700 ring-slate-200", dot: "bg-slate-400" },
  running: { label: "Running", style: "bg-blue-50 text-blue-800 ring-blue-200", dot: "bg-blue-500 animate-pulse" },
  to_check: { label: "Ready to check", style: "bg-amber-50 text-amber-900 ring-amber-300", dot: "bg-amber-500" },
  done: { label: "Done", style: "bg-emerald-50 text-emerald-800 ring-emerald-200", dot: "bg-emerald-500" },
  failed: { label: "Failed", style: "bg-red-50 text-red-800 ring-red-200", dot: "bg-red-500" },
  cancelled: { label: "Cancelled", style: "bg-slate-100 text-slate-500 ring-slate-200" },
};

export function JobStateBadge({ state }: { state: JobState }) {
  const info = JOB_BADGE[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${info.style}`}>
      {info.dot && <span className={`h-1.5 w-1.5 rounded-full ${info.dot}`} aria-hidden />}
      {info.label}
    </span>
  );
}
