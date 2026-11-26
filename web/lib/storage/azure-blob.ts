// Azure Blob Storage backend using passwordless Entra Managed Identity (AZURE_CLIENT_ID).
// Zero shared access keys, zero SAS tokens, zero external SDKs: talks directly to
// https://<account>.blob.core.windows.net/<container>/<key> over HTTPS with x-ms-version
// 2023-11-03 and enforces If-None-Match: * so existing blobs are never overwritten (Hard Rule 4).
import "server-only";
import { MAX_FILE_MB, maxFileBytes, parseUploadKey } from "../files";
import type { Storage, StoredFile } from "./index";

const AZURE_BLOB_VERSION = "2023-11-03";
const STORAGE_RESOURCE = "https://storage.azure.com/";
const TOKEN_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 120_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const ACCOUNT_RE = /^[a-z0-9]{3,24}$/;
const CONTAINER_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CTRL_RE = /[\r\n\u0000-\u001f\u007f]/;

export class AzureBlobConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AzureBlobError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AzureBlobConflictError extends AzureBlobError {
  constructor(message = "file already exists in Azure Blob Storage") {
    super(message, 409);
  }
}

export type AzureBlobConfig = {
  account: string;
  container: string;
  /** Optional User-Assigned Managed Identity client ID (e.g. tmc-doccenter-id). */
  clientId: string | null;
};

export type Env = Record<string, string | undefined>;
export type FetchLike = typeof fetch;

function extractAccountFromUrl(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    (u.pathname && u.pathname !== "/")
  ) {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const suffix = ".blob.core.windows.net";
  if (!host.endsWith(suffix)) return null;
  const account = host.slice(0, -suffix.length);
  return ACCOUNT_RE.test(account) ? account : null;
}

/**
 * Reads Azure Blob Storage config from environment variables.
 * Returns null when not configured at all; throws AzureBlobConfigError on invalid values.
 */
export function readAzureBlobConfig(env: Env = process.env): AzureBlobConfig | null {
  const rawAccount = (env.AZURE_STORAGE_ACCOUNT ?? env.AZURE_STORAGE_ACCOUNT_NAME ?? "").trim().toLowerCase();
  const rawUrl = (env.AZURE_STORAGE_BLOB_URL ?? env.AZURE_STORAGE_URL ?? "").trim();
  const rawContainer = (env.AZURE_STORAGE_CONTAINER ?? env.AZURE_STORAGE_CONTAINER_NAME ?? "").trim().toLowerCase();
  const rawClientId = (env.AZURE_CLIENT_ID ?? "").trim();

  if (!rawAccount && !rawUrl && !rawContainer) return null;

  let urlAccount = "";
  if (rawUrl) {
    const extracted = extractAccountFromUrl(rawUrl);
    if (!extracted) {
      throw new AzureBlobConfigError(
        "AZURE_STORAGE_BLOB_URL must be an https://<account>.blob.core.windows.net origin without path, query, or SAS token",
      );
    }
    urlAccount = extracted;
  }

  if (rawAccount && urlAccount && rawAccount !== urlAccount) {
    throw new AzureBlobConfigError("AZURE_STORAGE_ACCOUNT does not match AZURE_STORAGE_BLOB_URL");
  }

  const account = rawAccount || urlAccount;
  if (!ACCOUNT_RE.test(account)) {
    throw new AzureBlobConfigError("AZURE_STORAGE_ACCOUNT must be a valid Azure storage account name (3-24 lowercase letters/digits)");
  }
  const container = rawContainer || "documents";
  if (!CONTAINER_RE.test(container) || container.includes("--")) {
    throw new AzureBlobConfigError("AZURE_STORAGE_CONTAINER is invalid");
  }
  if (rawClientId && !UUID_RE.test(rawClientId)) {
    throw new AzureBlobConfigError("AZURE_CLIENT_ID must be a UUID");
  }

  return { account, container, clientId: rawClientId || null };
}

export function isAzureBlobConfigured(env: Env = process.env): boolean {
  return readAzureBlobConfig(env) !== null;
}

/** SSRF guard: ACA / App Service IDENTITY_ENDPOINT must be loopback only (no external hosts, query, or hash). */
export function validateIdentityEndpoint(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AzureBlobError("IDENTITY_ENDPOINT is invalid");
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash) {
    throw new AzureBlobError("IDENTITY_ENDPOINT is invalid");
  }
  const host = u.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
    throw new AzureBlobError("IDENTITY_ENDPOINT must point to a local Managed Identity loopback endpoint");
  }
  return u;
}

function capStream(stream: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new AzureBlobError("file exceeds maximum allowed size", 413));
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

function parseTokenExpiryMs(json: { expires_on?: unknown; expires_in?: unknown }, nowMs: number): number {
  const hasExpOn = json.expires_on !== undefined && json.expires_on !== null && String(json.expires_on).trim() !== "";
  if (hasExpOn) {
    const expOn = Number(json.expires_on);
    if (Number.isFinite(expOn)) {
      const expMs = expOn * 1000;
      if (expMs <= nowMs + 60_000) return nowMs; // short-lived token: do not cache for 1 hour (L1)
      return Math.min(nowMs + 86_400 * 1000, expMs);
    }
  }
  const hasExpIn = json.expires_in !== undefined && json.expires_in !== null && String(json.expires_in).trim() !== "";
  if (hasExpIn) {
    const expIn = Number(json.expires_in);
    if (Number.isFinite(expIn)) {
      if (expIn < 60) return nowMs; // short-lived token: do not cache for 1 hour (L1)
      return nowMs + Math.min(86_400, expIn) * 1000;
    }
  }
  return nowMs + 3600 * 1000;
}

export function createAzureBlobStorage(
  cfg: AzureBlobConfig,
  opts: { fetchImpl?: FetchLike; env?: Env } = {},
): Storage {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  let cachedToken: { value: string; expiresAt: number } | null = null;
  let tokenInFlight: Promise<string> | null = null;

  async function getToken(): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return cachedToken.value;
    }
    if (!tokenInFlight) {
      tokenInFlight = (async () => {
        const identityEndpoint = (env.IDENTITY_ENDPOINT ?? "").trim();
        const identityHeader = (env.IDENTITY_HEADER ?? "").trim();

        let tokenUrl: URL;
        const headers: Record<string, string> = {};
        if (identityEndpoint) {
          if (!identityHeader) {
            throw new AzureBlobError("IDENTITY_ENDPOINT is set without IDENTITY_HEADER");
          }
          if (CTRL_RE.test(identityHeader)) {
            throw new AzureBlobError("IDENTITY_HEADER contains invalid characters");
          }
          // Azure Container Apps / App Service Managed Identity sidecar
          tokenUrl = validateIdentityEndpoint(identityEndpoint);
          tokenUrl.searchParams.set("api-version", "2019-08-01");
          tokenUrl.searchParams.set("resource", STORAGE_RESOURCE);
          if (cfg.clientId) tokenUrl.searchParams.set("client_id", cfg.clientId);
          headers["x-identity-header"] = identityHeader;
        } else {
          // Azure IMDS fallback (VM / AKS)
          tokenUrl = new URL("http://169.254.169.254/metadata/identity/oauth2/token");
          tokenUrl.searchParams.set("api-version", "2018-02-01");
          tokenUrl.searchParams.set("resource", STORAGE_RESOURCE);
          if (cfg.clientId) tokenUrl.searchParams.set("client_id", cfg.clientId);
          headers.metadata = "true";
        }

        const res = await fetchImpl(tokenUrl.toString(), {
          method: "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        });
        if (!res.ok) {
          await drainCancel(res);
          throw new AzureBlobError(`Azure Managed Identity token request failed (HTTP ${res.status})`, res.status);
        }
        let json: { access_token?: unknown; expires_on?: unknown; expires_in?: unknown };
        try {
          json = (await res.json()) as { access_token?: unknown; expires_on?: unknown; expires_in?: unknown };
        } catch {
          throw new AzureBlobError("Azure Managed Identity returned invalid JSON");
        }
        if (typeof json.access_token !== "string" || !json.access_token || CTRL_RE.test(json.access_token)) {
          throw new AzureBlobError("Azure Managed Identity returned an invalid access token");
        }
        const nowMs = Date.now();
        const expiresAt = parseTokenExpiryMs(json, nowMs);
        cachedToken = expiresAt > nowMs ? { value: json.access_token, expiresAt } : null;
        return json.access_token;
      })().finally(() => {
        tokenInFlight = null;
      });
    }
    return tokenInFlight;
  }

  function blobUrl(key: string) {
    const parsed = parseUploadKey(key);
    if (!parsed) throw new Error("invalid storage key");
    return {
      url: `https://${cfg.account}.blob.core.windows.net/${cfg.container}/${parsed.key}`,
      kind: parsed.kind,
    };
  }

  async function blobFetch(url: string, init: RequestInit): Promise<Response> {
    const token = await getToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("x-ms-version", AZURE_BLOB_VERSION);
    headers.set("x-ms-date", new Date().toUTCString());
    const res = await fetchImpl(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (res.status === 401) {
      await drainCancel(res);
      // Compare-and-clear cache safely while allowing all concurrent 401s to coalesce onto one refresh (M1).
      if (cachedToken?.value === token) cachedToken = null;
      const fresh = await getToken();
      if (fresh !== token) {
        headers.set("authorization", `Bearer ${fresh}`);
        headers.set("x-ms-date", new Date().toUTCString());
        return fetchImpl(url, {
          ...init,
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        });
      }
      return new Response(null, { status: 401 });
    }
    return res;
  }

  return {
    mode: "azure-blob",

    async get(key): Promise<StoredFile | null> {
      const { url, kind } = blobUrl(key);
      const maxBytes = maxFileBytes(kind);
      const res = await blobFetch(url, { method: "GET" });
      if (res.status === 404) {
        await drainCancel(res);
        return null;
      }
      if (!res.ok || !res.body) {
        await drainCancel(res);
        throw new AzureBlobError(`Azure Blob download failed (HTTP ${res.status})`, res.status);
      }
      const cl = res.headers.get("content-length");
      const size = cl && /^\d+$/.test(cl) ? Number(cl) : null;
      if (size !== null && size > maxBytes) {
        await drainCancel(res);
        throw new AzureBlobError(`file exceeds ${MAX_FILE_MB[kind]} MB limit`, 413);
      }
      return {
        stream: capStream(res.body, maxBytes),
        size,
        contentType: res.headers.get("content-type"),
      };
    },

    async head(key, n) {
      const { url } = blobUrl(key);
      const meta = await blobFetch(url, { method: "HEAD" });
      await drainCancel(meta);
      if (meta.status === 404) return null;
      if (!meta.ok) throw new AzureBlobError(`Azure Blob lookup failed (HTTP ${meta.status})`, meta.status);
      const cl = meta.headers.get("content-length");
      const size = cl && /^\d+$/.test(cl) ? Number(cl) : 0;
      if (size === 0 || n <= 0) return { bytes: new Uint8Array(0), size };

      const want = Math.min(n, size);
      const res = await blobFetch(url, { method: "GET", headers: { "x-ms-range": `bytes=0-${want - 1}` } });
      if (res.status === 404) {
        await drainCancel(res);
        return null;
      }
      if (!res.ok || !res.body) {
        await drainCancel(res);
        throw new AzureBlobError(`Azure Blob read failed (HTTP ${res.status})`, res.status);
      }
      const bytes = await readFirstBytes(res.body, want);
      return { bytes, size };
    },

    async put(key, data, contentType) {
      const { url, kind } = blobUrl(key);
      if (data.byteLength === 0) throw new AzureBlobError("cannot upload an empty file");
      if (data.byteLength > maxFileBytes(kind)) {
        throw new AzureBlobError(`file exceeds ${MAX_FILE_MB[kind]} MB limit for ${kind}`);
      }
      const safeType = (contentType || "application/octet-stream").trim();
      if (!safeType || CTRL_RE.test(safeType)) {
        throw new AzureBlobError("invalid content-type");
      }
      // Zero-copy Buffer view avoids duplicating up to 100 MB in memory (H1) and remains reusable on 401 retry.
      const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const res = await blobFetch(url, {
        method: "PUT",
        headers: {
          "x-ms-blob-type": "BlockBlob",
          "content-type": safeType,
          "content-length": String(data.byteLength),
          // Hard Rule 4: atomically refuse to overwrite an existing blob.
          "if-none-match": "*",
        },
        body: body as unknown as BodyInit,
      });
      await drainCancel(res);
      if (res.status === 409 || res.status === 412) throw new AzureBlobConflictError();
      if (!res.ok) throw new AzureBlobError(`Azure Blob upload failed (HTTP ${res.status})`, res.status);
    },
  };
}
