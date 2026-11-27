"use client";

// Internal remarks & engine/AI training flags (Phase 4c).
// Updates local state directly without triggering router.refresh() so adding a remark on the
// Check screen never disturbs unsaved text in DocEditor.
import { useState } from "react";
import { saveDocumentRemark, type RemarkItem } from "@/app/documents/[id]/actions";
import { REMARK_CATEGORIES, REMARK_CATEGORY_LABELS, type RemarkCategory } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";

const input =
  "block w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:border-tmc focus:outline-none focus:ring-1 focus:ring-tmc";

export function RemarksPanel({
  documentId,
  initial,
  compact = false,
}: {
  documentId: string;
  initial: RemarkItem[];
  compact?: boolean;
}) {
  const [items, setItems] = useState<RemarkItem[]>(initial);
  const [remark, setRemark] = useState("");
  const [category, setCategory] = useState<RemarkCategory>("missing_rows");
  const [trainingFlag, setTrainingFlag] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const flaggedCount = items.filter((i) => i.trainingFlag).length;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = remark.trim();
    if (trimmed.length < 3) {
      setStatus({ ok: false, text: "Write at least 3 characters." });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const res = await saveDocumentRemark(documentId, {
        remark: trimmed,
        trainingFlag,
        category,
      });
      if (!res.ok) {
        setStatus({ ok: false, text: res.error });
        return;
      }
      setItems((prev) => [res.item, ...prev]);
      setRemark("");
      setTrainingFlag(false);
      setStatus({
        ok: true,
        text: res.item.trainingFlag ? "Remark saved and flagged for engine / AI training." : "Internal remark saved.",
      });
    } catch {
      setStatus({ ok: false, text: "Could not save remark. Try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-gray-900">
            Internal remarks &amp; training flags
            {items.length > 0 && <span className="ml-2 text-xs font-normal text-gray-500">({items.length})</span>}
          </h2>
          <p className="text-xs text-gray-500">
            Internal only (never printed on TMC outputs). Flag problem documents so they appear in Settings &gt; Feedback for engine and AI training.
          </p>
        </div>
        {flaggedCount > 0 && (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-900 ring-1 ring-inset ring-amber-300">
            Flagged for training ({flaggedCount})
          </span>
        )}
      </div>

      <form onSubmit={onSubmit} className={`mt-3 grid gap-3 ${compact ? "lg:grid-cols-[1fr_14rem_auto]" : "sm:grid-cols-[1fr_14rem]"}`}>
        <div className={compact ? "" : "sm:col-span-2"}>
          <label className="sr-only" htmlFor={`remark-text-${documentId}`}>
            Internal remark
          </label>
          <textarea
            id={`remark-text-${documentId}`}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            rows={compact ? 2 : 2}
            maxLength={1000}
            placeholder="Note what worked or went wrong (e.g. 'Row 6 sub-impurities split well' or 'Missed batch prefix on scan')…"
            className={input}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="block text-xs font-medium text-gray-600">
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as RemarkCategory)}
              className={`mt-1 ${input}`}
            >
              {REMARK_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {REMARK_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label
            className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 transition-colors ${
              trainingFlag ? "bg-amber-50 text-amber-950 ring-amber-300" : "bg-gray-50 text-gray-700 ring-gray-200 hover:bg-gray-100"
            }`}
          >
            <input
              type="checkbox"
              checked={trainingFlag}
              onChange={(e) => setTrainingFlag(e.target.checked)}
              className="accent-tmc"
            />
            Flag for engine / AI training
          </label>
        </div>
        <div className={`flex items-end ${compact ? "" : "sm:col-span-2 sm:justify-end"}`}>
          <button
            type="submit"
            disabled={saving || remark.trim().length < 3}
            className="rounded-md bg-tmc px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-tmc-dark disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save remark"}
          </button>
        </div>
      </form>

      {status && (
        <p
          role="status"
          className={`mt-2.5 rounded-md px-3 py-1.5 text-xs font-medium ring-1 ${
            status.ok ? "bg-emerald-50 text-emerald-900 ring-emerald-200" : "bg-red-50 text-red-900 ring-red-200"
          }`}
        >
          {status.text}
        </p>
      )}

      {items.length > 0 && (
        <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
          {items.map((item) => (
            <li key={item.id} className="py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                <span className="font-medium text-gray-700">{item.actor}</span>
                <span>·</span>
                <span>{formatDateTime(item.createdAt)}</span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 font-medium text-gray-700">
                  {REMARK_CATEGORY_LABELS[item.category] ?? item.category}
                </span>
                {item.trainingFlag && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-900">
                    Training flag
                  </span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-gray-800">{item.remark}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
