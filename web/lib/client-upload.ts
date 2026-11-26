// Browser side of an upload:
//   - "azure-blob" / "sharepoint": POST to /api/upload-file (server checks login, CSRF, rate limit,
//     size, and magic bytes, then stores in Azure Blob Storage or SharePoint _app-storage/)
//   - "local": POST to /api/upload-local (laptop dev only)
// Returns the storage key; the server checks the file again before using it.
import type { FileKind } from "./files";

export type UploadMode = "azure-blob" | "sharepoint" | "local";

export async function sendFile(mode: UploadMode, kind: FileKind, file: File): Promise<string> {
  const url = mode === "local" ? "/api/upload-local" : "/api/upload-file";
  const res = await fetch(url, { method: "POST", body: file, headers: { "x-upload-kind": kind } });
  const json = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
  if (!res.ok || !json.key) throw new Error(json.error ?? "upload failed");
  return json.key;
}
