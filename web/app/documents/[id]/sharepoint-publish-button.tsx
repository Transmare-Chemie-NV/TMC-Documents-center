"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { publishDocumentToSharePoint } from "./actions";

export function SharePointPublishButton({ documentId, label }: { documentId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    const res = await publishDocumentToSharePoint(documentId);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.refresh();
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        className="rounded-md border border-tmc px-3 py-1.5 text-sm font-medium text-tmc hover:bg-tmc-light disabled:opacity-60"
      >
        {busy ? "Publishing to SharePoint…" : label}
      </button>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
