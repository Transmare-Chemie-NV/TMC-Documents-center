"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import type { RemarkItem } from "@/app/documents/[id]/actions";
import { RemarksPanel } from "@/components/remarks-panel";
import { sendFile, type UploadMode } from "@/lib/client-upload";
import type { DocType, Entity } from "@/lib/constants";
import type { YellowPart } from "@/lib/db/schema";
import { MAX_FILE_MB, maxFileBytes } from "@/lib/files";
import { fileStem } from "@/lib/naming";
import { approve, finaliseDraft, reject, type CheckResult } from "./actions";
import { EditSection, type EditProps } from "./edit-section";

const input =
  "block w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm focus:border-tmc focus:outline-none focus:ring-1 focus:ring-tmc";
const noSubscribe = () => () => {};

type Props = {
  documentId: string;
  parts: YellowPart[];
  hasPdf: boolean;
  busy: boolean;
  uploadMode: UploadMode;
  initial: { productName: string; fileNr: string; batch: string };
  naming: { type: DocType; entity: Entity; batchLocked: boolean; language: string; currentName: string };
  edit: EditProps;
  remarks: RemarkItem[];
};

export function CheckForm({ documentId, parts, hasPdf, busy, uploadMode, initial, naming, edit, remarks }: Props) {
  const router = useRouter();
  const ready = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [meta, setMetaState] = useState(initial);
  // The new name lands on another document's Final: shown once the server says so (review M1).
  const [askReplace, setAskReplace] = useState(false);
  const [replace, setReplace] = useState(false);
  const setMeta = (m: typeof initial) => {
    setMetaState(m);
    setAskReplace(false);
    setReplace(false);
  };
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(parts.map((p) => [p.id, p.text])));
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState("");
  const [word, setWord] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const left = parts.filter((p) => !confirmed[p.id]).length;
  const tooLong = parts.some((p) => p.truncated);
  const disabled = !ready || working || busy;

  async function act(fn: () => Promise<CheckResult>) {
    setWorking(true);
    setMessage(null);
    try {
      const r = await fn();
      setMessage(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error });
      if (!r.ok && r.confirmReplace) setAskReplace(true);
      if (r.ok) router.refresh();
    } catch {
      setMessage({ ok: false, text: "That did not work. Try again." });
    } finally {
      setWorking(false);
    }
  }

  const metadata = { productName: meta.productName, fileNr: meta.fileNr, batch: meta.batch };
  // The file name follows the details (Willem 19/10); shown so nobody is surprised.
  // a label is approved as the worker made it: no Word round trip, details and name fixed (security M1/L2)
  const isLabel = naming.type === "LABEL";
  const name = isLabel
    ? naming.currentName
    : fileStem({ type: naming.type, entity: naming.entity, productName: meta.productName.trim(), fileNr: meta.fileNr.trim(), batch: meta.batch.trim() });
  const hasEditor = !!edit.viewUrl;

  return (
    <div className="mt-4 space-y-4">
      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={`rounded-md px-3.5 py-2.5 text-sm font-medium ring-1 ${
            message.ok ? "bg-emerald-50 text-emerald-900 ring-emerald-200" : "bg-red-50 text-red-900 ring-red-200"
          }`}
        >
          {message.text}
        </p>
      )}

      {/* Compact single-row metadata strip */}
      <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
        <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr]">
          <label className="block text-xs font-medium text-gray-600">
            Product name (TMC) *
            <input
              value={meta.productName}
              onChange={(e) => setMeta({ ...meta, productName: e.target.value })}
              readOnly={isLabel}
              maxLength={200}
              className={`mt-1 ${input} ${isLabel ? "bg-gray-100 text-gray-600" : ""}`}
            />
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Dossier
            <input
              value={meta.fileNr}
              onChange={(e) => setMeta({ ...meta, fileNr: e.target.value })}
              readOnly={isLabel}
              maxLength={50}
              className={`mt-1 ${input} ${isLabel ? "bg-gray-100 text-gray-600" : ""}`}
            />
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Batch
            <input
              value={meta.batch}
              onChange={(e) => setMeta({ ...meta, batch: e.target.value })}
              readOnly={naming.batchLocked}
              title={naming.batchLocked ? "This document was made for this batch; it cannot be changed" : undefined}
              maxLength={100}
              className={`mt-1 ${input} ${naming.batchLocked ? "bg-gray-100 text-gray-600" : ""}`}
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Output file name: <span className="break-all font-mono text-gray-800">{name}</span> · each value in the file name must appear on the document.
        </p>
        {askReplace && (
          <label className="mt-2.5 flex items-center gap-2 rounded-md bg-amber-50 p-2.5 text-sm text-amber-900 ring-1 ring-amber-300">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="accent-tmc" />
            Replace it: this document becomes the new Final under {name}
          </label>
        )}
      </section>

      {parts.length === 0 && hasPdf && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-emerald-50/70 p-4 shadow-sm ring-1 ring-emerald-200">
          <div>
            <h2 className="font-semibold text-emerald-950">Ready to approve</h2>
            <p className="text-sm text-emerald-900/80">Compare the TMC draft with the original. Approving makes it Final.</p>
          </div>
          <button
            type="button"
            disabled={disabled || !meta.productName.trim()}
            onClick={() => act(() => approve(documentId, metadata, replace))}
            className="rounded-md bg-tmc px-4 py-2 text-sm font-semibold text-white hover:bg-tmc-dark disabled:opacity-50"
          >
            Approve as Final
          </button>
        </section>
      )}

      {!isLabel && (
        <EditSection
          {...edit}
          metadata={metadata}
          confirmReplace={replace}
          disabled={disabled}
          act={act}
        />
      )}

      {/* Internal remarks & training flags right inside the workflow (does not disturb unsaved edits) */}
      <RemarksPanel documentId={documentId} initial={remarks} compact />

      {/* Secondary options tucked neatly into collapsible panels so the main workstation stays clean */}
      <div className="space-y-3">
        {parts.length > 0 && (
          <details open={!hasEditor} className="rounded-lg bg-white shadow-sm ring-1 ring-black/5">
            <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50">
              <span>Alternative: quick list check of the yellow parts ({parts.length})</span>
              <span className={`text-xs font-medium ${left ? "text-amber-700" : "text-emerald-700"}`}>
                {left ? `${left} of ${parts.length} still to confirm` : "All confirmed"}
              </span>
            </summary>
            <div className="border-t border-gray-100 p-4">
              <ol className="space-y-3">
                {parts.map((p, i) => (
                  <li key={p.id} className={`rounded-md p-3 ring-1 ${confirmed[p.id] ? "bg-emerald-50 ring-emerald-200" : "bg-yellow-50 ring-yellow-300"}`}>
                    <div className="text-xs text-gray-600">
                      {i + 1}. In: <span className="italic">&ldquo;{p.context || p.text}&rdquo;</span>
                    </div>
                    {p.truncated && (
                      <p className="mt-1 text-xs font-medium text-amber-800">
                        Too long for the quick list: edit on screen above or use &ldquo;Check in Word yourself&rdquo; below.
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <input
                        value={values[p.id] ?? ""}
                        onChange={(e) => {
                          setValues({ ...values, [p.id]: e.target.value });
                          setConfirmed({ ...confirmed, [p.id]: false });
                        }}
                        maxLength={500}
                        className={`${input} flex-1 sm:min-w-[20rem]`}
                        aria-label={`Value for yellow part ${i + 1}`}
                      />
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={!!confirmed[p.id]}
                          onChange={(e) => setConfirmed({ ...confirmed, [p.id]: e.target.checked })}
                          className="accent-tmc"
                        />
                        {values[p.id] === p.text ? "OK as is" : "Use my correction"}
                      </label>
                    </div>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                disabled={disabled || left > 0 || tooLong || !meta.productName.trim()}
                onClick={() =>
                  act(() =>
                    finaliseDraft(documentId, {
                      mode: "editor",
                      metadata,
                      confirmReplace: replace,
                      fixes: Object.fromEntries(
                        parts.filter((p) => confirmed[p.id]).map((p) => [p.id, { value: values[p.id] ?? "", confirmed: true as const }]),
                      ),
                    }),
                  )
                }
                className="mt-4 rounded-md bg-tmc px-4 py-2 text-sm font-medium text-white hover:bg-tmc-dark disabled:opacity-50"
              >
                {busy ? "Being finalised…" : "Finalise from quick list: make Word + PDF"}
              </button>
            </div>
          </details>
        )}

        {!isLabel && (
          <details className="rounded-lg bg-white shadow-sm ring-1 ring-black/5">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50">
              Alternative: check in Microsoft Word and upload .docx
            </summary>
            <div className="border-t border-gray-100 p-4">
              <p className="text-sm text-gray-600">
                Download the Word draft, correct it, remove every yellow highlight, then upload it here. The neutralizer refuses to finalise while anything is still yellow.
              </p>
              <input
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => setWord(e.target.files?.[0] ?? null)}
                className="mt-3 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-tmc-light file:px-3 file:py-2 file:font-medium file:text-tmc"
                aria-label="Checked Word file"
              />
              <button
                type="button"
                disabled={disabled || !word || !meta.productName.trim()}
                onClick={() =>
                  act(async () => {
                    if (!word) return { ok: false, error: "Choose the checked Word file." };
                    if (word.size > maxFileBytes("docx")) return { ok: false, error: `The file is larger than ${MAX_FILE_MB.docx} MB.` };
                    const key = await sendFile(uploadMode, "docx", word);
                    return finaliseDraft(documentId, { mode: "upload", metadata, confirmReplace: replace, docx: { key, filename: word.name } });
                  })
                }
                className="mt-3 rounded-md border border-tmc px-4 py-2 text-sm font-medium text-tmc hover:bg-tmc-light disabled:opacity-50"
              >
                Upload checked Word and finalise
              </button>
            </div>
          </details>
        )}

        <details className="rounded-lg bg-white shadow-sm ring-1 ring-black/5">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-red-800 hover:bg-red-50/40">
            Reject this draft
          </summary>
          <div className="border-t border-gray-100 p-4">
            <p className="text-sm text-gray-600">The reason goes to the feedback overview to improve the neutralizer.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                placeholder="What is wrong?"
                className={`${input} flex-1`}
                aria-label="Reason for rejecting"
              />
              <button
                type="button"
                disabled={disabled || reason.trim().length < 3}
                onClick={() => act(() => reject(documentId, reason))}
                className="rounded-md border border-red-700 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Reject draft
              </button>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
