// Public entry point for the SharePoint integration (Graph client + storage + orders + publish).
import "server-only";
import type { Actor } from "../audit";
import type { Db } from "../db";
import type { Storage } from "../storage";
import { createGraphClient, type SharePointClient } from "./client";
import { isSharePointConfigured, readSharePointConfig, type SharePointConfig } from "./config";
import { publishFinalToSharePoint, type PublishResult } from "./publish";

export { SharePointConflictError, SharePointError, createGraphClient, type DriveItem, type SharePointClient } from "./client";
export {
  DRIVE_ID_RE,
  SharePointConfigError,
  isInsideInternalStorage,
  isSafeSharePointHost,
  isSharePointConfigured,
  isWithinFolder,
  parseGraphParentPath,
  readSharePointConfig,
  safeFolderName,
  sanitizeRelativePath,
  validateItemId,
  type SharePointConfig,
} from "./config";
export {
  DEFAULT_TRANSFER_TIMEOUT_MS,
  MAX_CONCURRENT_TRANSFERS,
  acquireTransferSlot,
  checkSameOrigin,
  readStreamSafe,
  resetTransferGuards,
  takeUserRate,
  type SafeReadResult,
} from "./guard";
export {
  SharePointOrderError,
  browseSharePointOrders,
  extractFileNrFromPath,
  importSharePointPdf,
  type BrowseResult,
  type ImportedPdf,
  type OrderEntry,
} from "./orders";
export { publishFinalToSharePoint, resolvePublishFolder, versionedFilename, type PublishResult } from "./publish";
export { createSharePointStorage } from "./storage";

let cached: { cfg: SharePointConfig; client: SharePointClient } | null = null;

/** Returns the configured SharePoint client and config, or null when SharePoint is not enabled. */
export function getSharePoint(): { cfg: SharePointConfig; client: SharePointClient } | null {
  if (cached) return cached;
  const cfg = readSharePointConfig();
  if (!cfg) return null;
  cached = { cfg, client: createGraphClient(cfg) };
  return cached;
}

/** Resets cached client (used in tests when env vars change). */
export function resetSharePointCache() {
  cached = null;
}

/**
 * Best-effort auto-publish called right after a document becomes Final (never breaks the Final save).
 * No-op when SharePoint is not configured.
 */
export async function tryPublishFinal(
  db: Db,
  storage: Storage,
  documentId: string,
  actor: Pick<Actor, "email">,
): Promise<PublishResult | null> {
  if (!isSharePointConfigured()) return null;
  const sp = getSharePoint();
  if (!sp) return null;
  try {
    return await publishFinalToSharePoint(db, storage, sp.client, sp.cfg, documentId, actor);
  } catch (err) {
    console.error("sharepoint publish unexpected error:", err instanceof Error ? err.name : typeof err);
    return { ok: false, error: "SharePoint publish failed" };
  }
}
