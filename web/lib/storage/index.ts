// File storage behind one small interface (Azure + laptop local dev).
//   - "azure-blob": Azure Blob Storage via passwordless Entra Managed Identity (AZURE_CLIENT_ID)
//   - "sharepoint": SharePoint document library via Microsoft Graph (Sites.Selected)
//   - "local": local folder .data/files (laptop and unit tests only)
// Controlled explicitly by STORAGE_BACKEND ("azure-blob" | "sharepoint" | "local"), or auto-selected
// from configured env vars (SharePoint -> Azure Blob -> local dev). Fails closed in production.
import "server-only";
import { createReadStream } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { parseUploadKey } from "../files";
import {
  createGraphClient,
  createSharePointStorage,
  getSharePoint,
  readSharePointConfig,
  resetSharePointCache,
} from "../sharepoint";
import { createAzureBlobStorage, readAzureBlobConfig } from "./azure-blob";

export type StorageMode = "azure-blob" | "sharepoint" | "local";
export type StoredFile = { stream: ReadableStream<Uint8Array>; size: number | null; contentType: string | null };

export interface Storage {
  /** "azure-blob" / "sharepoint": browser posts to /api/upload-file. "local": /api/upload-local. */
  readonly mode: StorageMode;
  get(key: string): Promise<StoredFile | null>;
  /** First `n` bytes and the size, to check the file signature after upload. */
  head(key: string, n: number): Promise<{ bytes: Uint8Array; size: number } | null>;
  /** Stores a new file (the worker's results or server uploads). Refuses to overwrite. */
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
}

let storage: Storage | undefined;

function resolveSharePointForEnv(env: Record<string, string | undefined>) {
  if (env === process.env) return getSharePoint();
  const cfg = readSharePointConfig(env);
  return cfg ? { cfg, client: createGraphClient(cfg) } : null;
}

export function resolveStorage(env: Record<string, string | undefined> = process.env): Storage {
  const explicit = (env.STORAGE_BACKEND ?? "").trim().toLowerCase();

  if (explicit === "sharepoint") {
    const sp = resolveSharePointForEnv(env);
    if (!sp) throw new Error("STORAGE_BACKEND=sharepoint but SharePoint env vars are not configured");
    return createSharePointStorage(sp.client, sp.cfg);
  }
  if (explicit === "azure-blob" || explicit === "azure" || explicit === "blob") {
    const cfg = readAzureBlobConfig(env);
    if (!cfg) throw new Error("STORAGE_BACKEND=azure-blob but AZURE_STORAGE_ACCOUNT is not configured");
    return createAzureBlobStorage(cfg, { env });
  }
  if (explicit === "local") {
    if (env.NODE_ENV === "production" && env.ALLOW_LOCAL_STORAGE !== "1") {
      throw new Error("STORAGE_BACKEND=local is not allowed in production");
    }
    return localStorage(LOCAL_ROOT);
  }
  if (explicit) {
    throw new Error(`Unknown STORAGE_BACKEND "${explicit}": use azure-blob, sharepoint, or local`);
  }

  // Auto-select when STORAGE_BACKEND is unset: SharePoint -> Azure Blob -> local (non-prod only).
  const sp = resolveSharePointForEnv(env);
  if (sp) return createSharePointStorage(sp.client, sp.cfg);
  const azureCfg = readAzureBlobConfig(env);
  if (azureCfg) return createAzureBlobStorage(azureCfg, { env });

  if (env.NODE_ENV === "production" && env.ALLOW_LOCAL_STORAGE !== "1") {
    throw new Error("No file storage configured: set AZURE_STORAGE_ACCOUNT or SharePoint env vars");
  }
  return localStorage(LOCAL_ROOT);
}

export function getStorage(): Storage {
  storage ??= resolveStorage();
  return storage;
}

/** Resets cached storage instance (used in tests when env vars change). */
export function resetStorageCache() {
  storage = undefined;
  resetSharePointCache();
}

// ---------------------------------------------------------------- local folder
export const LOCAL_ROOT = path.join(process.cwd(), ".data", "files");

function localPath(root: string, key: string) {
  if (!parseUploadKey(key)) throw new Error("invalid storage key");
  return path.join(root, ...key.split("/"));
}

/** Laptop and tests: files in a folder (default .data/files). */
export function localStorage(root: string): Storage {
  return {
    mode: "local",
    async get(key) {
      const p = localPath(root, key);
      const s = await stat(p).catch(() => null);
      if (!s) return null;
      const stream = Readable.toWeb(createReadStream(p)) as ReadableStream<Uint8Array>;
      return { stream, size: s.size, contentType: null };
    },
    async head(key, n) {
      const p = localPath(root, key);
      const fh = await open(p, "r").catch(() => null);
      if (!fh) return null;
      try {
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, 0);
        return { bytes: new Uint8Array(buf.subarray(0, bytesRead)), size: (await fh.stat()).size };
      } finally {
        await fh.close();
      }
    },
    async put(key, data) {
      const p = localPath(root, key);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, data, { flag: "wx" });
    },
  };
}

/** Local mode only (dev upload route). Refuses to overwrite. */
export async function putLocal(key: string, data: Uint8Array) {
  await localStorage(LOCAL_ROOT).put(key, data, "application/octet-stream");
}
