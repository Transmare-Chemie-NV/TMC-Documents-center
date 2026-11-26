// Microsoft Graph client for a single SharePoint document library (Sites.Selected).
// Uses Node's built-in fetch (no extra SDK dependency), hardcodes official Microsoft hosts,
// validates all redirect/upload URLs against SSRF, enforces hasTrustedParent/driveId checks,
// and never overwrites existing files.
import "server-only";
import type { StoredFile } from "../storage";
import {
  DRIVE_ID_RE,
  isSafeSharePointHost,
  parseGraphParentPath,
  validateItemId,
  validatePathSegment,
  type SharePointConfig,
} from "./config";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SELECT_FIELDS = "id,name,size,file,folder,webUrl,parentReference,lastModifiedDateTime";
const META_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 120_000;
// Microsoft Graph resumable upload chunk size: must be a multiple of 320 KiB. 16 * 320 KiB = 5 MiB.
const UPLOAD_CHUNK_BYTES = 16 * 320 * 1024;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class SharePointError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class SharePointConflictError extends SharePointError {
  constructor(message = "file already exists in SharePoint") {
    super(message, 409);
  }
}

export type DriveItem = {
  id: string;
  name: string;
  size: number;
  isFolder: boolean;
  mimeType: string | null;
  webUrl: string | null;
  parentId: string | null;
  parentPath: string;
  /** True only when Graph returned a verified drive-root parentReference matching the configured drive (SEC-03). */
  hasTrustedParent: boolean;
  modifiedAt: string | null;
};

export interface SharePointClient {
  getItemById(itemId: string): Promise<DriveItem | null>;
  getItemByPath(relPath: string): Promise<DriveItem | null>;
  listChildren(opts?: { folderId?: string; folderPath?: string; limit?: number }): Promise<DriveItem[]>;
  searchItems(query: string, opts?: { rootPath?: string; limit?: number }): Promise<DriveItem[]>;
  downloadById(itemId: string, maxBytes: number): Promise<StoredFile | null>;
  downloadByPath(relPath: string, maxBytes: number): Promise<StoredFile | null>;
  headByPath(relPath: string, n: number): Promise<{ bytes: Uint8Array; size: number } | null>;
  /** Uploads a new file using conflictBehavior=fail (never overwrites). Throws SharePointConflictError on 409. */
  uploadFile(relPath: string, data: Uint8Array, contentType: string): Promise<DriveItem>;
  /** Ensures every folder segment in relPath exists (never overwrites a file). */
  ensureFolder(relPath: string): Promise<DriveItem>;
}

type RawDriveItem = {
  id?: unknown;
  name?: unknown;
  size?: unknown;
  file?: { mimeType?: unknown } | null;
  folder?: Record<string, unknown> | null;
  webUrl?: unknown;
  parentReference?: { id?: unknown; path?: unknown; driveId?: unknown } | null;
  lastModifiedDateTime?: unknown;
};

function parseItem(raw: RawDriveItem, expectedDriveId: string, allowedTenantHost: string | null): DriveItem | null {
  if (typeof raw?.id !== "string" || typeof raw?.name !== "string") return null;
  const parent = parseGraphParentPath(raw.parentReference?.path);
  const rawDriveId = typeof raw.parentReference?.driveId === "string" ? raw.parentReference.driveId : null;
  const driveMatches = rawDriveId === null || rawDriveId === expectedDriveId;
  return {
    id: raw.id,
    name: raw.name,
    size: typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size >= 0 ? raw.size : 0,
    isFolder: !!raw.folder && !raw.file,
    mimeType: typeof raw.file?.mimeType === "string" ? raw.file.mimeType : null,
    webUrl: typeof raw.webUrl === "string" && isSafeSharePointHost(raw.webUrl, allowedTenantHost) ? raw.webUrl : null,
    parentId: typeof raw.parentReference?.id === "string" ? raw.parentReference.id : null,
    parentPath: parent.path,
    hasTrustedParent: parent.ok && driveMatches,
    modifiedAt: typeof raw.lastModifiedDateTime === "string" ? raw.lastModifiedDateTime : null,
  };
}

function encodeDrivePath(relPath: string): string {
  const parts = relPath.split("/").filter(Boolean);
  if (!parts.length) throw new SharePointError("SharePoint path cannot be empty");
  return parts.map((p) => encodeURIComponent(validatePathSegment(p, "path segment"))).join("/");
}

/** RFC-3986 percent-encoding (also encodes ! ' ( ) *) for OData search(q='...') literals (SEC-11). */
function encodeODataLiteral(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Wraps a response body stream so reading can never exceed maxBytes (DoS / OOM protection). */
function capStream(stream: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new SharePointError("file exceeds maximum allowed size", 413));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

async function readFirstBytes(stream: ReadableStream<Uint8Array>, n: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const out = new Uint8Array(n);
  let got = 0;
  try {
    while (got < n) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const take = Math.min(n - got, value.length);
      out.set(value.subarray(0, take), got);
      got += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, got);
}

async function drainCancel(res: Response) {
  await res.body?.cancel().catch(() => {});
}

export type FetchLike = typeof fetch;

export function createGraphClient(cfg: SharePointConfig, fetchImpl: FetchLike = fetch): SharePointClient {
  let cachedToken: { value: string; expiresAt: number } | null = null;
  let tokenInFlight: Promise<string> | null = null;
  let resolvedDriveId: string | null = cfg.driveId;
  let driveInFlight: Promise<string> | null = null;

  async function getToken(): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return cachedToken.value;
    }
    if (!tokenInFlight) {
      tokenInFlight = (async () => {
        const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`;
        const body = new URLSearchParams({
          grant_type: "client_credentials",
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          scope: "https://graph.microsoft.com/.default",
        });
        const res = await fetchImpl(tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          redirect: "manual",
          signal: AbortSignal.timeout(META_TIMEOUT_MS),
        });
        if (!res.ok) {
          await drainCancel(res);
          throw new SharePointError(`SharePoint authentication failed (HTTP ${res.status})`, res.status);
        }
        const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
        if (typeof json.access_token !== "string" || !json.access_token) {
          throw new SharePointError("SharePoint authentication returned no access token");
        }
        const rawExp = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : 3600;
        const expiresIn = Math.min(86_400, Math.max(60, rawExp));
        cachedToken = { value: json.access_token, expiresAt: Date.now() + expiresIn * 1000 };
        return cachedToken.value;
      })().finally(() => {
        tokenInFlight = null;
      });
    }
    return tokenInFlight;
  }

  async function graphFetch(endpoint: string, init: RequestInit = {}, timeoutMs = META_TIMEOUT_MS): Promise<Response> {
    const token = await getToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const res = await fetchImpl(`${GRAPH_BASE}${endpoint}`, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // One clean retry if token was revoked/expired early; compare-and-clear avoids token storms (SEC-09).
    if (res.status === 401 && cachedToken?.value === token) {
      await drainCancel(res);
      cachedToken = null;
      const fresh = await getToken();
      headers.set("authorization", `Bearer ${fresh}`);
      return fetchImpl(`${GRAPH_BASE}${endpoint}`, {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    return res;
  }

  async function getDriveId(): Promise<string> {
    if (resolvedDriveId) return resolvedDriveId;
    if (!cfg.siteId) throw new SharePointError("SHAREPOINT_DRIVE_ID or SHAREPOINT_SITE_ID is required");
    if (!driveInFlight) {
      driveInFlight = (async () => {
        const res = await graphFetch(`/sites/${encodeURIComponent(cfg.siteId!)}/drive?$select=id`);
        if (!res.ok) {
          await drainCancel(res);
          throw new SharePointError(`could not open SharePoint library (HTTP ${res.status})`, res.status);
        }
        const json = (await res.json()) as { id?: unknown };
        if (typeof json.id !== "string" || !DRIVE_ID_RE.test(json.id)) {
          throw new SharePointError("SharePoint library returned an invalid drive id");
        }
        resolvedDriveId = json.id;
        return resolvedDriveId;
      })().finally(() => {
        driveInFlight = null;
      });
    }
    return driveInFlight;
  }

  async function downloadEndpoint(endpoint: string, maxBytes: number, rangeHeader?: string): Promise<StoredFile | null> {
    const headers: Record<string, string> = {};
    if (rangeHeader) headers.range = rangeHeader;
    const res = await graphFetch(endpoint, { method: "GET", headers }, TRANSFER_TIMEOUT_MS);
    if (res.status === 404) {
      await drainCancel(res);
      return null;
    }

    let finalRes = res;
    if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
      const location = res.headers.get("location") ?? "";
      await drainCancel(res);
      if (!isSafeSharePointHost(location, cfg.tenantHost)) {
        throw new SharePointError("SharePoint returned an unexpected download host");
      }
      // Do NOT forward the Bearer token to the pre-authenticated SharePoint redirect URL.
      finalRes = await fetchImpl(location, {
        method: "GET",
        headers: rangeHeader ? { range: rangeHeader } : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      });
    }
    if (finalRes.status === 404) {
      await drainCancel(finalRes);
      return null;
    }
    if (!finalRes.ok || !finalRes.body) {
      await drainCancel(finalRes);
      throw new SharePointError(`SharePoint download failed (HTTP ${finalRes.status})`, finalRes.status);
    }
    const cl = finalRes.headers.get("content-length");
    const size = cl && /^\d+$/.test(cl) ? Number(cl) : null;
    if (size !== null && size > maxBytes) {
      await drainCancel(finalRes);
      throw new SharePointError("file exceeds maximum allowed size", 413);
    }
    return {
      stream: capStream(finalRes.body, maxBytes),
      size,
      contentType: finalRes.headers.get("content-type"),
    };
  }

  return {
    async getItemById(itemId) {
      const id = validateItemId(itemId);
      const driveId = await getDriveId();
      const res = await graphFetch(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}?$select=${SELECT_FIELDS}`);
      if (res.status === 404) {
        await drainCancel(res);
        return null;
      }
      if (!res.ok) {
        await drainCancel(res);
        throw new SharePointError(`SharePoint lookup failed (HTTP ${res.status})`, res.status);
      }
      return parseItem((await res.json()) as RawDriveItem, driveId, cfg.tenantHost);
    },

    async getItemByPath(relPath) {
      const driveId = await getDriveId();
      const encoded = encodeDrivePath(relPath);
      const res = await graphFetch(`/drives/${encodeURIComponent(driveId)}/root:/${encoded}:?$select=${SELECT_FIELDS}`);
      if (res.status === 404) {
        await drainCancel(res);
        return null;
      }
      if (!res.ok) {
        await drainCancel(res);
        throw new SharePointError(`SharePoint lookup failed (HTTP ${res.status})`, res.status);
      }
      return parseItem((await res.json()) as RawDriveItem, driveId, cfg.tenantHost);
    },

    async listChildren(opts = {}) {
      const driveId = await getDriveId();
      const top = Math.min(200, Math.max(1, opts.limit ?? 200));
      let base: string;
      if (opts.folderId) {
        const id = validateItemId(opts.folderId);
        base = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}/children`;
      } else if (opts.folderPath) {
        base = `/drives/${encodeURIComponent(driveId)}/root:/${encodeDrivePath(opts.folderPath)}:/children`;
      } else {
        base = `/drives/${encodeURIComponent(driveId)}/root/children`;
      }
      const res = await graphFetch(`${base}?$select=${SELECT_FIELDS}&$top=${top}`);
      if (res.status === 404) {
        await drainCancel(res);
        return [];
      }
      if (!res.ok) {
        await drainCancel(res);
        throw new SharePointError(`SharePoint folder listing failed (HTTP ${res.status})`, res.status);
      }
      const json = (await res.json()) as { value?: RawDriveItem[] };
      return (json.value ?? []).map((r) => parseItem(r, driveId, cfg.tenantHost)).filter((x): x is DriveItem => x !== null);
    },

    async searchItems(query, opts = {}) {
      // Strip control/invisible chars and KQL/OData operator punctuation (SEC-11).
      const clean = query
        .trim()
        .replace(/[\u0000-\u001f\u007f\p{Cf}"':*()!\\]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      if (!clean) return [];
      const driveId = await getDriveId();
      const top = Math.min(100, Math.max(1, opts.limit ?? 50));
      const escaped = encodeODataLiteral(clean);
      const scope = opts.rootPath ? `/root:/${encodeDrivePath(opts.rootPath)}:` : "/root";
      const res = await graphFetch(
        `/drives/${encodeURIComponent(driveId)}${scope}/search(q='${escaped}')?$select=${SELECT_FIELDS}&$top=${top}`,
      );
      if (res.status === 404) {
        await drainCancel(res);
        return [];
      }
      if (!res.ok) {
        await drainCancel(res);
        throw new SharePointError(`SharePoint search failed (HTTP ${res.status})`, res.status);
      }
      const json = (await res.json()) as { value?: RawDriveItem[] };
      return (json.value ?? []).map((r) => parseItem(r, driveId, cfg.tenantHost)).filter((x): x is DriveItem => x !== null);
    },

    async downloadById(itemId, maxBytes) {
      const id = validateItemId(itemId);
      const driveId = await getDriveId();
      return downloadEndpoint(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}/content`, maxBytes);
    },

    async downloadByPath(relPath, maxBytes) {
      const driveId = await getDriveId();
      const encoded = encodeDrivePath(relPath);
      return downloadEndpoint(`/drives/${encodeURIComponent(driveId)}/root:/${encoded}:/content`, maxBytes);
    },

    async headByPath(relPath, n) {
      const item = await this.getItemByPath(relPath);
      if (!item || item.isFolder) return null;
      if (item.size === 0 || n <= 0) return { bytes: new Uint8Array(0), size: item.size };
      const want = Math.min(n, item.size);
      const driveId = await getDriveId();
      const encoded = encodeDrivePath(relPath);
      // Allow full item.size in Content-Length in case a CDN ignores Range; readFirstBytes cancels after `want` bytes.
      const file = await downloadEndpoint(
        `/drives/${encodeURIComponent(driveId)}/root:/${encoded}:/content`,
        Math.max(want, item.size),
        `bytes=0-${want - 1}`,
      );
      if (!file) return null;
      const bytes = await readFirstBytes(file.stream, want);
      return { bytes, size: item.size };
    },

    async ensureFolder(relPath) {
      const segments = relPath.split("/").filter(Boolean);
      if (!segments.length) throw new SharePointError("folder path cannot be empty");
      const driveId = await getDriveId();
      let currentPath = "";
      let currentItem: DriveItem | null = null;
      for (const rawSeg of segments) {
        const seg = validatePathSegment(rawSeg, "folder name");
        const nextPath = currentPath ? `${currentPath}/${seg}` : seg;
        const existing = await this.getItemByPath(nextPath);
        if (existing) {
          if (!existing.isFolder) throw new SharePointConflictError(`"${nextPath}" already exists as a file`);
          currentItem = existing;
          currentPath = nextPath;
          continue;
        }
        const parentEndpoint = currentItem
          ? `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(currentItem.id)}/children`
          : `/drives/${encodeURIComponent(driveId)}/root/children`;
        const res = await graphFetch(parentEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: seg, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
        });
        if (res.status === 409) {
          await drainCancel(res);
          const raced = await this.getItemByPath(nextPath);
          if (!raced || !raced.isFolder) throw new SharePointConflictError(`"${nextPath}" conflict`);
          currentItem = raced;
        } else if (!res.ok) {
          await drainCancel(res);
          throw new SharePointError(`could not create SharePoint folder (HTTP ${res.status})`, res.status);
        } else {
          currentItem = parseItem((await res.json()) as RawDriveItem, driveId, cfg.tenantHost);
        }
        currentPath = nextPath;
      }
      if (!currentItem) throw new SharePointError("could not resolve SharePoint folder");
      return currentItem;
    },

    async uploadFile(relPath, data, contentType) {
      if (data.byteLength === 0) throw new SharePointError("cannot upload an empty file");
      const segments = relPath.split("/").filter(Boolean);
      if (!segments.length) throw new SharePointError("file path cannot be empty");
      const parentSegments = segments.slice(0, -1);
      if (parentSegments.length) {
        await this.ensureFolder(parentSegments.join("/"));
      }
      const driveId = await getDriveId();
      const encoded = encodeDrivePath(relPath);

      // Always use createUploadSession with conflictBehavior=fail so SharePoint atomically refuses
      // overwrites for BOTH small and large files (up to 100 MB, hard rule 4).
      const sessionRes = await graphFetch(
        `/drives/${encodeURIComponent(driveId)}/root:/${encoded}:/createUploadSession`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "fail" } }),
        },
        META_TIMEOUT_MS,
      );
      if (sessionRes.status === 409) {
        await drainCancel(sessionRes);
        throw new SharePointConflictError();
      }
      if (!sessionRes.ok) {
        await drainCancel(sessionRes);
        throw new SharePointError(`could not start SharePoint upload (HTTP ${sessionRes.status})`, sessionRes.status);
      }
      const sessionJson = (await sessionRes.json()) as { uploadUrl?: unknown };
      if (typeof sessionJson.uploadUrl !== "string" || !isSafeSharePointHost(sessionJson.uploadUrl, cfg.tenantHost)) {
        throw new SharePointError("SharePoint returned an unexpected upload host");
      }
      const uploadUrl = sessionJson.uploadUrl;

      let lastRes: Response | null = null;
      const total = data.byteLength;
      try {
        for (let offset = 0; offset < total; offset += UPLOAD_CHUNK_BYTES) {
          const end = Math.min(total, offset + UPLOAD_CHUNK_BYTES);
          const chunk = data.subarray(offset, end);
          const res = await fetchImpl(uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": contentType || "application/octet-stream",
              "content-length": String(chunk.byteLength),
              "content-range": `bytes ${offset}-${end - 1}/${total}`,
            },
            // Zero-copy view of the chunk slice (never Buffer.from(chunk) which copies).
            body: new Blob([chunk as unknown as BlobPart]),
            redirect: "manual",
            signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
          });
          if (res.status === 409) {
            await drainCancel(res);
            throw new SharePointConflictError();
          }
          if (!res.ok) {
            await drainCancel(res);
            throw new SharePointError(`SharePoint upload failed (HTTP ${res.status})`, res.status);
          }
          // Non-final chunk responses (202) are drained cleanly before moving to the next chunk.
          if (end < total) await drainCancel(res);
          lastRes = res;
        }
      } catch (err) {
        // Best-effort cleanup of abandoned upload session (SEC-09).
        await fetchImpl(uploadUrl, { method: "DELETE", redirect: "manual", signal: AbortSignal.timeout(10_000) })
          .then(drainCancel)
          .catch(() => {});
        throw err;
      }

      if (!lastRes) throw new SharePointError("SharePoint upload produced no response");
      const item = parseItem((await lastRes.json()) as RawDriveItem, driveId, cfg.tenantHost);
      if (!item) throw new SharePointError("SharePoint upload returned no file metadata");
      return item;
    },
  };
}
