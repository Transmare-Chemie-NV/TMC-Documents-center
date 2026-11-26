// Authenticated SharePoint PDF import for the Neutralise screen.
// Enforces auth, CSRF same-origin + JSON Content-Type (SEC-08), per-user rate limit & concurrency
// semaphore (SEC-02), and sanitized configuration error responses (SEC-06).
import { apiUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  acquireTransferSlot,
  checkSameOrigin,
  getSharePoint,
  importSharePointPdf,
  SharePointConfigError,
  SharePointError,
  SharePointOrderError,
  takeUserRate,
} from "@/lib/sharepoint";
import { getStorage } from "@/lib/storage";

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const MAX_JSON_BYTES = 4096;
const MAX_IMPORTS_PER_MINUTE = 15;

async function readSmallJson(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_JSON_BYTES) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return Response.json({ error: "not logged in" }, { status: 401, headers: NO_STORE });
  if (!checkSameOrigin(request)) return Response.json({ error: "forbidden origin" }, { status: 403, headers: NO_STORE });

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return Response.json({ error: "content-type must be application/json" }, { status: 415, headers: NO_STORE });
  }

  const wait = takeUserRate("sp-import", user.email, MAX_IMPORTS_PER_MINUTE);
  if (wait !== null) {
    return Response.json({ error: "too many SharePoint imports; try again shortly" }, {
      status: 429,
      headers: { ...NO_STORE, "retry-after": String(wait) },
    });
  }

  let sp: ReturnType<typeof getSharePoint>;
  try {
    sp = getSharePoint();
  } catch (err) {
    console.error("sharepoint config error:", err instanceof Error ? err.name : typeof err);
    return Response.json({ error: "SharePoint configuration error. Contact the administrator." }, { status: 503, headers: NO_STORE });
  }
  if (!sp) return Response.json({ error: "SharePoint is not configured" }, { status: 404, headers: NO_STORE });

  const body = await readSmallJson(request);
  if (!body || typeof body.itemId !== "string") {
    return Response.json({ error: "missing itemId" }, { status: 400, headers: NO_STORE });
  }

  const release = acquireTransferSlot();
  if (!release) {
    return Response.json({ error: "server is busy handling transfers; try again shortly" }, {
      status: 503,
      headers: { ...NO_STORE, "retry-after": "5" },
    });
  }

  try {
    const imported = await importSharePointPdf(await getDb(), getStorage(), sp.client, sp.cfg, user, body.itemId);
    return Response.json(imported, { status: 200, headers: NO_STORE });
  } catch (err) {
    if (err instanceof SharePointOrderError) {
      return Response.json({ error: err.message }, { status: 400, headers: NO_STORE });
    }
    if (err instanceof SharePointConfigError) {
      console.error("sharepoint config error:", err.name);
      return Response.json({ error: "SharePoint configuration error. Contact the administrator." }, { status: 503, headers: NO_STORE });
    }
    if (err instanceof SharePointError) {
      return Response.json({ error: "Could not import file from SharePoint right now." }, { status: 502, headers: NO_STORE });
    }
    console.error("sharepoint import route failed:", err instanceof Error ? err.name : typeof err);
    return Response.json({ error: "Could not import file from SharePoint right now." }, { status: 502, headers: NO_STORE });
  } finally {
    release();
  }
}
