// Browser side of an upload:
//   - "blob": straight to private Vercel Blob
//   - "sharepoint": POST to /api/upload-file (server checks login, size, magic bytes and stores in SharePoint _app-storage/)
//   - "local": POST to /api/upload-local (laptop dev only)
// Returns the storage key; the server checks the file again before using it.
import { upload } from "@vercel/blob/client";
import { newUploadKey, type FileKind } from "./files";

export type UploadMode = "blob" | "local" | "sharepoint";

export async function sendFile(mode: UploadMode, kind: FileKind, file: File): Promise<string> {
  if (mode === "blob") {
    const key = newUploadKey(kind);
    await upload(key, file, {
      access: "private",
      handleUploadUrl: "/api/upload",
      contentType: file.type || undefined,
      multipart: file.size > 5 * 1024 * 1024,
    });
    return key;
  }
  const url = mode === "sharepoint" ? "/api/upload-file" : "/api/upload-local";
  const res = await fetch(url, { method: "POST", body: file, headers: { "x-upload-kind": kind } });
  const json = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
  if (!res.ok || !json.key) throw new Error(json.error ?? "upload failed");
  return json.key;
}
