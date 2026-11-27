"use client";

// Edit the draft as a document (Willem 19/10, option A; own editor 20/10). Screen by screen:
// supplier original left, the TMC document being edited right. Saving sends only the changed
// pieces of text; the worker writes them into the draft and runs every check of a Final.
// Changes not found in the original come back as warnings.
import { useRef, useState } from "react";
import { DocEditor, type DocEditorHandle, type DocEditorState } from "@/components/doc-editor";
import type { Change } from "@/lib/documents/changes";
import type { Edits } from "@/lib/documents/edits";
import type { DocMetadata } from "@/lib/db/schema";
import { finaliseDraft, type CheckResult } from "./actions";

export type EditProps = {
  documentId: string;
  sourceUrl: string | null;
  /** the editor view of the draft; null for a draft made before the own editor */
  viewUrl: string | null;
  /** the last edit that did not become Final, to go on from */
  pending: { edits: Edits; warnings: Change[] } | null;
};

type Props = EditProps & {
  metadata: Omit<DocMetadata, "fileNr" | "batch"> & { fileNr: string; batch: string };
  confirmReplace: boolean;
  disabled: boolean;
  act: (fn: () => Promise<CheckResult>) => Promise<void>;
};

export function EditSection(p: Props) {
  const [state, setState] = useState<DocEditorState>("loading");
  const [liveYellow, setLiveYellow] = useState<number | null>(null);
  const [accept, setAccept] = useState(false);
  const editor = useRef<DocEditorHandle>(null);
  const warnings = p.pending?.warnings ?? [];

  // A confirmation only ever covers the warnings shown, so only the changes they belong to;
  // a new edit is compared again and shows its own warnings.
  const finalise = (edits: Edits, acceptChanges: boolean) =>
    finaliseDraft(p.documentId, { mode: "edited", metadata: p.metadata, confirmReplace: p.confirmReplace, acceptChanges, edits });

  async function saveAndFinalise(): Promise<CheckResult> {
    if (!editor.current) return { ok: false, error: "The editor is still loading." };
    return finalise(editor.current.getEdits(), false);
  }

  if (!p.viewUrl) {
    return (
      <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
        <h2 className="font-semibold">Edit the document</h2>
        <p className="mt-1 text-sm text-gray-600">
          This draft was made before the on-screen editor. Run the supplier document again to edit it here, or use the
          yellow parts below or the Word file.
        </p>
      </section>
    );
  }

  const canSave = !p.disabled && state === "ready" && Boolean(p.metadata.productName.trim());

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
      {/* Top workstation bar: status + Save & finalise always visible without scrolling */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 pb-3">
        <div>
          <h2 className="font-semibold text-gray-900">
            Side-by-side check &amp; editor{p.pending ? " (your last edit)" : ""}
          </h2>
          <p className="text-xs text-gray-500">
            Click any text on the right to edit. Use <strong>Confirm &amp; next</strong> to review and clear each yellow item one by one.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {liveYellow !== null && liveYellow > 0 && (
            <span className="text-xs font-medium text-amber-800">
              {liveYellow} yellow part(s) still to clear
            </span>
          )}
          {!p.metadata.productName.trim() && (
            <span className="text-xs font-medium text-red-700">Enter Product name above first</span>
          )}
          <button
            type="button"
            disabled={!canSave}
            onClick={() => p.act(saveAndFinalise)}
            className="rounded-md bg-tmc px-4 py-2 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-tmc-dark disabled:opacity-50"
          >
            Save and finalise: make Word + PDF
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-300">
          <p className="font-medium">
            {warnings.length} change(s) bring in words or numbers that are not in the supplier original. Check them:
          </p>
          <ul className="mt-2 space-y-2">
            {warnings.map((w, i) => (
              <li key={i} className="rounded bg-white p-2 ring-1 ring-amber-200">
                <div className="text-xs text-gray-500 line-through">{w.before || "(new text)"}</div>
                <div>{w.after || "(removed)"}</div>
                <div className="mt-1 text-xs">
                  Not in the original: <span className="font-mono font-semibold">{w.unknown.join("  ")}</span>
                </div>
              </li>
            ))}
          </ul>
          <label className="mt-3 flex items-center gap-2">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="accent-tmc" />
            I checked these changes; they are correct
          </label>
          {p.pending && (
            <button
              type="button"
              disabled={p.disabled || !accept || !p.metadata.productName.trim()}
              onClick={() => p.act(() => finalise(p.pending!.edits, true))}
              className="mt-3 rounded-md bg-tmc px-4 py-2 font-medium text-white hover:bg-tmc-dark disabled:opacity-50"
            >
              Finalise my last edit
            </button>
          )}
        </div>
      )}

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Supplier original</h3>
            {p.sourceUrl && (
              <a href={p.sourceUrl} target="_blank" rel="noopener" className="text-xs text-tmc hover:underline">
                Open in new tab
              </a>
            )}
          </div>
          {p.sourceUrl ? (
            <iframe src={p.sourceUrl} title="Supplier original (editor)" className="h-[82vh] w-full rounded-lg border border-gray-200 bg-white" />
          ) : (
            <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">No original stored.</p>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              TMC document {state === "loading" ? "(loading…)" : state === "error" ? "(could not be opened)" : "(editable)"}
            </h3>
          </div>
          <DocEditor ref={editor} src={p.viewUrl} pending={p.pending?.edits ?? null} onState={setState} onYellowCount={setLiveYellow} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3">
        <p className="text-xs text-gray-500">
          When you save, the neutralizer re-checks the document and layout (nothing over the TMC letterhead, nothing cut off) before creating Word + PDF.
        </p>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => p.act(saveAndFinalise)}
          className="rounded-md bg-tmc px-4 py-2 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-tmc-dark disabled:opacity-50"
        >
          Save and finalise: make Word + PDF
        </button>
      </div>
    </section>
  );
}
