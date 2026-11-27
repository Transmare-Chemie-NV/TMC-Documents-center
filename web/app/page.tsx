import Link from "next/link";
import { PageShell } from "@/components/app-header";
import { Notice } from "@/components/notice";
import { DocStatusBadge } from "@/components/status-badge";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { DOC_TYPES, ENTITIES, STATUSES, type DocStatus, type DocType, type Entity } from "@/lib/db/schema";
import { dossierHref } from "@/lib/documents/dossier";
import { documentStatusCounts, listDocuments, PAGE_SIZE, type DocumentFilters } from "@/lib/documents/service";
import { formatDateTime, formatDay } from "@/lib/format";

export const metadata = { title: "Library · TMC Document Center" };

type SP = Record<string, string | string[] | undefined>;

function one(sp: SP, key: string, max = 100) {
  const v = sp[key];
  const s = (Array.isArray(v) ? v[0] : v)?.trim().slice(0, max);
  return s || undefined;
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === value);
}

const cell = "px-3 py-2.5";
const filterInput = "mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs font-normal text-gray-900";

export default async function LibraryPage({ searchParams }: PageProps<"/">) {
  const user = await requireUser();
  const sp = (await searchParams) as SP;

  const filters: DocumentFilters = {
    q: one(sp, "q", 200),
    type: pick<DocType>(one(sp, "type"), DOC_TYPES),
    entity: pick<Entity>(one(sp, "entity"), ENTITIES),
    status: pick<DocStatus | "all">(one(sp, "status"), [...STATUSES, "all"]),
    product: one(sp, "product"),
    batch: one(sp, "batch"),
    fileNr: one(sp, "fileNr"),
  };
  const page = Math.max(0, Math.min(1000, Math.trunc(Number(one(sp, "page"))) || 0));
  const db = await getDb();
  const [rows, counts] = await Promise.all([listDocuments(db, filters, page), documentStatusCounts(db)]);
  const hasMore = rows.length > PAGE_SIZE;
  const shown = rows.slice(0, PAGE_SIZE);
  const currentTotal = counts.Final + counts["To check"] + counts.Draft;
  const allTotal = currentTotal + counts.Superseded + counts.Rejected;

  const buildUrl = (patch: Partial<DocumentFilters>, nextPage = 0) => {
    const merged: DocumentFilters = { ...filters, ...patch };
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) {
      if (v) params.set(k, v);
    }
    if (nextPage) params.set("page", String(nextPage));
    const q = params.toString();
    return q ? `/?${q}` : "/";
  };

  const quickTabs: { label: string; status: DocStatus | "all" | undefined; count: number; accent?: boolean }[] = [
    { label: "Current", status: undefined, count: currentTotal },
    { label: "To check", status: "To check", count: counts["To check"], accent: counts["To check"] > 0 },
    { label: "Final", status: "Final", count: counts.Final },
    { label: "Rejected", status: "Rejected", count: counts.Rejected },
    { label: "All versions", status: "all", count: allTotal },
  ];

  const hasActiveFilters = Boolean(filters.q || filters.type || filters.entity || filters.status || filters.product || filters.batch || filters.fileNr);

  return (
    <PageShell user={user}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-tmc">
            {filters.status === "To check" ? "Drafts to check" : "Document library"}
          </h1>
          <p className="text-sm text-gray-600">
            Search all TMC documents by product, batch, dossier, INCI, CAS or internal supplier name.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/neutralise"
            className="rounded-md bg-tmc px-4 py-2 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-tmc-dark"
          >
            Neutralise supplier PDF
          </Link>
          <Link
            href="/upload"
            className="rounded-md border border-tmc bg-white px-3.5 py-2 text-sm font-medium text-tmc transition-colors hover:bg-tmc-light"
          >
            Add existing TMC doc
          </Link>
        </div>
      </div>
      <Notice ok={sp.ok} error={sp.error} />

      {/* Quick one-click status tabs */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5 border-b border-gray-200 pb-3">
        {quickTabs.map((t) => {
          const active = filters.status === t.status;
          return (
            <Link
              key={t.label}
              href={buildUrl({ status: t.status })}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                active
                  ? "bg-tmc text-white shadow-xs"
                  : t.accent
                    ? "bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300 hover:bg-amber-100"
                    : "bg-white text-gray-700 ring-1 ring-inset ring-gray-200 hover:bg-tmc-light hover:text-tmc"
              }`}
            >
              <span>{t.label}</span>
              <span
                className={`rounded-full px-1.5 py-0.25 text-xs ${
                  active ? "bg-white/20 text-white" : t.accent ? "bg-amber-200/80 text-amber-950" : "bg-gray-100 text-gray-600"
                }`}
              >
                {t.count}
              </span>
            </Link>
          );
        })}
      </div>

      <form method="get" action="/" className="mt-4">
        <div className="flex flex-wrap gap-2">
          <input
            name="q"
            type="search"
            defaultValue={filters.q}
            placeholder="Search product, batch, dossier, INCI, CAS, supplier…"
            maxLength={200}
            className="min-w-[16rem] flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-2xs focus:border-tmc focus:outline-none focus:ring-1 focus:ring-tmc"
          />
          <button type="submit" className="rounded-md bg-tmc px-4 py-2 text-sm font-medium text-white hover:bg-tmc-dark">
            Search
          </button>
          {hasActiveFilters && (
            <Link href="/" className="self-center px-2 text-sm font-medium text-tmc hover:underline">
              Clear
            </Link>
          )}
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-black/5">
          <table className="w-full min-w-[940px] text-left text-sm">
            <thead className="bg-tmc-light align-top text-tmc">
              <tr>
                <th className={cell}>
                  Type
                  <select name="type" defaultValue={filters.type ?? ""} className={filterInput} aria-label="Filter on type">
                    <option value="">All</option>
                    {DOC_TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </th>
                <th className={cell}>
                  Product / file name
                  <input name="product" defaultValue={filters.product} className={filterInput} aria-label="Filter on product" />
                </th>
                <th className={cell}>
                  Batch
                  <input name="batch" defaultValue={filters.batch} className={filterInput} aria-label="Filter on batch" />
                </th>
                <th className={cell}>
                  Dossier
                  <input name="fileNr" defaultValue={filters.fileNr} className={filterInput} aria-label="Filter on dossier" />
                </th>
                <th className={cell}>
                  Entity
                  <select name="entity" defaultValue={filters.entity ?? ""} className={filterInput} aria-label="Filter on entity">
                    <option value="">All</option>
                    {ENTITIES.map((e) => (
                      <option key={e}>{e}</option>
                    ))}
                  </select>
                </th>
                <th className={cell}>
                  Status
                  <select name="status" defaultValue={filters.status ?? ""} className={filterInput} aria-label="Filter on status">
                    <option value="">Current</option>
                    {STATUSES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                    <option value="all">All versions</option>
                  </select>
                </th>
                <th className={cell}>
                  Added / action
                  <button type="submit" className="mt-1 block rounded bg-tmc px-2.5 py-1 text-xs font-medium text-white hover:bg-tmc-dark">
                    Apply filters
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    No documents found.
                  </td>
                </tr>
              )}
              {shown.map((d) => {
                const yellowCount = d.yellowParts?.length ?? 0;
                return (
                  <tr key={d.id} className="relative border-t border-gray-100 transition-colors hover:bg-tmc-light/40">
                    <td className={cell}>
                      <span className="rounded bg-tmc-light px-1.5 py-0.5 text-xs font-semibold text-tmc">{d.type}</span>
                    </td>
                    <td className={cell}>
                      <Link href={`/documents/${d.id}`} className="font-medium text-gray-900 after:absolute after:inset-0">
                        {d.productName ?? <span className="italic text-gray-500">Product to confirm</span>}
                      </Link>
                      <div className="mt-0.5 text-xs text-gray-500">
                        {d.name}
                        {(d.version ?? 0) > 1 && ` · v${d.version}`}
                      </div>
                    </td>
                    <td className={cell}>{d.batch || <span className="text-gray-400">-</span>}</td>
                    <td className={cell}>
                      {d.fileNr ? (
                        <Link href={dossierHref(d.fileNr)} className="relative z-10 font-medium text-tmc hover:underline" title="Dossier overview">
                          {d.fileNr}
                        </Link>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className={cell}>{d.entity}</td>
                    <td className={cell}>
                      <div className="flex flex-col items-start gap-1">
                        <DocStatusBadge status={d.status} />
                        {d.status === "To check" && yellowCount > 0 && (
                          <span className="text-[11px] font-medium text-amber-800">{yellowCount} yellow part(s)</span>
                        )}
                      </div>
                    </td>
                    <td className={cell} title={formatDateTime(d.createdAt)}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="whitespace-nowrap text-xs text-gray-600">{formatDay(d.createdAt)}</span>
                        {d.status === "To check" && (
                          <Link
                            href={`/documents/${d.id}/check`}
                            className="relative z-10 rounded-md bg-tmc px-2.5 py-1 text-xs font-semibold text-white shadow-2xs transition-colors hover:bg-tmc-dark"
                          >
                            Check
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </form>

      <div className="mt-3 flex justify-between text-sm">
        {page > 0 ? (
          <Link href={buildUrl({}, page - 1)} className="font-medium text-tmc hover:underline">
            ← Newer
          </Link>
        ) : (
          <span />
        )}
        {hasMore && (
          <Link href={buildUrl({}, page + 1)} className="font-medium text-tmc hover:underline">
            Older →
          </Link>
        )}
      </div>
    </PageShell>
  );
}
