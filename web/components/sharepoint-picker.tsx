"use client";

import { useCallback, useState } from "react";
import { formatBytes } from "@/lib/format";

type Entry = {
  id: string;
  name: string;
  isFolder: boolean;
  isPdf: boolean;
  size: number;
  modifiedAt: string | null;
  folderPath: string;
};

type BrowseData = {
  currentFolderId: string | null;
  currentPath: string;
  parentId: string | null;
  suggestedFileNr: string | null;
  items: Entry[];
};

export type PickedSharePointFile = {
  key: string;
  filename: string;
  folderPath: string | null;
  suggestedFileNr: string | null;
};

export function SharePointPicker({
  allowCommercial,
  onAddSupplier,
  onAddCommercial,
}: {
  allowCommercial: boolean;
  onAddSupplier: (file: PickedSharePointFile) => void;
  onAddCommercial: (file: PickedSharePointFile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<BrowseData | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const load = useCallback(async (opts: { folderId?: string | null; q?: string } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (opts.q?.trim()) params.set("q", opts.q.trim());
      else if (opts.folderId) params.set("folderId", opts.folderId);
      const res = await fetch(`/api/sharepoint/orders${params.size ? `?${params}` : ""}`);
      const json = (await res.json().catch(() => ({}))) as BrowseData & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not open SharePoint.");
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open SharePoint.");
    } finally {
      setLoading(false);
    }
  }, []);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && !data) void load();
  }

  async function importFile(entry: Entry, role: "supplier" | "commercial") {
    setImportingId(entry.id);
    setError(null);
    setAdded(null);
    try {
      const res = await fetch("/api/sharepoint/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: entry.id }),
      });
      const json = (await res.json().catch(() => ({}))) as PickedSharePointFile & { error?: string };
      if (!res.ok || !json.key) throw new Error(json.error ?? "Import failed.");
      if (role === "supplier") onAddSupplier(json);
      else onAddCommercial(json);
      setAdded(`Added "${json.filename}" as ${role === "supplier" ? "supplier document" : "commercial document"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImportingId(null);
    }
  }

  return (
    <div className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-tmc">Pick files from SharePoint orders</h2>
          <p className="text-xs text-gray-500">
            Browse or search an order folder in SharePoint and add its PDFs directly, without downloading them first.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleOpen}
          className="rounded-md border border-tmc px-3 py-1.5 text-sm font-medium text-tmc hover:bg-tmc-light"
        >
          {open ? "Hide SharePoint browser" : "Browse SharePoint"}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
          <div className="flex flex-wrap gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void load({ q: query });
                }
              }}
              maxLength={80}
              placeholder="Search order / dossier nr (e.g. 840.S0850) or file name"
              className="min-w-[16rem] flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-tmc focus:outline-none focus:ring-1 focus:ring-tmc"
            />
            <button
              type="button"
              onClick={() => void load({ q: query })}
              disabled={loading}
              className="rounded-md bg-tmc px-3 py-1.5 text-sm font-medium text-white hover:bg-tmc/90 disabled:opacity-60"
            >
              Search
            </button>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                void load();
              }}
              disabled={loading}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Root folder
            </button>
          </div>

          {data && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
              <div className="break-all">
                Folder: <span className="font-medium text-gray-900">{data.currentPath || "/"}</span>
                {data.suggestedFileNr && (
                  <span className="ml-2 rounded bg-tmc-light px-1.5 py-0.5 text-tmc">Dossier: {data.suggestedFileNr}</span>
                )}
              </div>
              {data.currentFolderId && (
                <button
                  type="button"
                  onClick={() => void load({ folderId: data.parentId })}
                  disabled={loading}
                  className="text-tmc underline"
                >
                  Up one folder
                </button>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
              {error}
            </p>
          )}
          {added && (
            <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 ring-1 ring-green-200">{added}</p>
          )}

          {loading ? (
            <p className="py-4 text-sm text-gray-500">Loading SharePoint folder…</p>
          ) : data && data.items.length === 0 ? (
            <p className="py-4 text-sm text-gray-500">No folders or files found here.</p>
          ) : data ? (
            <div className="max-h-72 overflow-y-auto rounded border border-gray-200">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-tmc-light text-xs text-tmc">
                  <tr>
                    <th className="px-3 py-1.5">Name</th>
                    <th className="px-3 py-1.5">Size</th>
                    <th className="px-3 py-1.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((entry) => (
                    <tr key={entry.id} className="border-t border-gray-100">
                      <td className="px-3 py-1.5">
                        {entry.isFolder ? (
                          <button
                            type="button"
                            onClick={() => {
                              setQuery("");
                              void load({ folderId: entry.id });
                            }}
                            className="font-medium text-tmc underline"
                          >
                            [Folder] {entry.name}
                          </button>
                        ) : (
                          <span className={entry.isPdf ? "text-gray-900" : "text-gray-400"}>
                            {entry.name}
                            {entry.folderPath && entry.folderPath !== data.currentPath && (
                              <span className="ml-1 text-xs text-gray-400">({entry.folderPath})</span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-gray-500">
                        {entry.isFolder ? "—" : formatBytes(entry.size)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right">
                        {entry.isFolder ? (
                          <button
                            type="button"
                            onClick={() => {
                              setQuery("");
                              void load({ folderId: entry.id });
                            }}
                            className="text-xs text-tmc underline"
                          >
                            Open
                          </button>
                        ) : entry.isPdf ? (
                          <div className="inline-flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              disabled={importingId !== null}
                              onClick={() => void importFile(entry, "supplier")}
                              className="rounded border border-tmc px-2 py-0.5 text-xs font-medium text-tmc hover:bg-tmc-light disabled:opacity-50"
                            >
                              {importingId === entry.id ? "Importing…" : "+ Supplier doc"}
                            </button>
                            {allowCommercial && (
                              <button
                                type="button"
                                disabled={importingId !== null}
                                onClick={() => void importFile(entry, "commercial")}
                                className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                              >
                                + PFI / OC
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">PDF only</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
