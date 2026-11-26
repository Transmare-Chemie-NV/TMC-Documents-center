// Server-side upload route for Azure (Azure Blob Storage or SharePoint mode, up to 100 MB).
// Browser never receives an Azure/Graph token; this route enforces login (401 before mode),
// CSRF same-origin check, per-user rate limit, concurrency cap, early magic-byte check on the
// first 8 bytes, wall-clock timeout, zero-copy buffer, and audit logging.
import { logAudit } from "@/lib/audit";
import { apiUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { detectType, MAX_FILE_MB, maxFileBytes, newUploadKey, USER_UPLOAD_KINDS, type FileKind } from "@/lib/files";
import { acquireTransferSlot, checkSameOrigin, readStreamSafe, takeUserRate } from "@/lib/sharepoint";
import { getStorage } from "@/lib/storage";

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const MAX_UPLOADS_PER_MINUTE = 20;

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

export async function POST(request: Request) {
  // Check authentication BEFORE storage mode so unauthenticated callers cannot probe config.
  const user = await apiUser();
  if (!user) return new Response("Not logged in", { status: 401, headers: NO_STORE });
  if (!checkSameOrigin(request)) return json({ error: "forbidden origin" }, 403);

  const storage = getStorage();
  if (storage.mode === "local") {
    return new Response("Not found", { status: 404, headers: NO_STORE });
  }

  const wait = takeUserRate("upload-file", user.email, MAX_UPLOADS_PER_MINUTE);
  if (wait !== null) return json({ error: "too many uploads; try again shortly" }, 429, { "retry-after": String(wait) });

  const kind = USER_UPLOAD_KINDS.find((k) => k === request.headers.get("x-upload-kind")) as FileKind | undefined;
  if (!kind) return json({ error: "unknown file slot" }, 400);

  const max = maxFileBytes(kind);
  const clHeader = request.headers.get("content-length");
  if (clHeader !== null) {
    if (!/^\d{1,12}$/.test(clHeader) || Number(clHeader) < 1) return json({ error: "file is empty" }, 400);
    if (Number(clHeader) > max) return json({ error: `file is larger than ${MAX_FILE_MB[kind]} MB` }, 413);
  }
  if (!request.body) return json({ error: "file is empty" }, 400);

  const release = acquireTransferSlot();
  if (!release) return json({ error: "server is busy handling uploads; try again shortly" }, 503, { "retry-after": "5" });

  try {
    const read = await readStreamSafe(request.body, {
      maxBytes: max,
      validateHead: (head) => detectType(kind, head),
    });
    if (!read.ok) {
      if (read.reason === "too_large") return json({ error: `file is larger than ${MAX_FILE_MB[kind]} MB` }, 413);
      if (read.reason === "invalid_type") return json({ error: "file type not allowed" }, 415);
      if (read.reason === "timeout") return json({ error: "upload timed out" }, 408);
      return json({ error: "file is empty" }, 400);
    }

    const key = newUploadKey(kind);
    await storage.put(key, read.bytes, read.detectedType!);
    await logAudit(await getDb(), user, "upload.created", null, {
      kind,
      size: read.bytes.byteLength,
      key,
      backend: storage.mode,
    });
    return json({ key }, 200);
  } catch (err) {
    console.error("upload-file failed:", err instanceof Error ? err.name : typeof err);
    return json({ error: "file upload failed" }, 502);
  } finally {
    release();
  }
}
