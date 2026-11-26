// SharePoint Storage backend (implements lib/storage Storage interface).
// Stores internal app files (uploads/<uuid>/<kind>) strictly inside SHAREPOINT_STORAGE_FOLDER
// (default "_app-storage") so supplier originals and working drafts never mix with published Finals.
import "server-only";
import { MAX_FILE_MB, maxFileBytes, parseUploadKey } from "../files";
import type { Storage } from "../storage";
import type { SharePointClient } from "./client";
import type { SharePointConfig } from "./config";

function storagePath(cfg: SharePointConfig, key: string) {
  const parsed = parseUploadKey(key);
  if (!parsed) throw new Error("invalid storage key");
  return { relPath: `${cfg.storageFolder}/${parsed.key}`, kind: parsed.kind };
}

export function createSharePointStorage(client: SharePointClient, cfg: SharePointConfig): Storage {
  return {
    mode: "sharepoint",
    async get(key) {
      const { relPath, kind } = storagePath(cfg, key);
      return client.downloadByPath(relPath, maxFileBytes(kind));
    },
    async head(key, n) {
      const { relPath } = storagePath(cfg, key);
      return client.headByPath(relPath, n);
    },
    async put(key, data, contentType) {
      const { relPath, kind } = storagePath(cfg, key);
      if (data.byteLength > maxFileBytes(kind)) {
        throw new Error(`file exceeds ${MAX_FILE_MB[kind]} MB limit for ${kind}`);
      }
      await client.uploadFile(relPath, data, contentType);
    },
  };
}
