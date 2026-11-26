// SharePoint order folder browser & safe PDF importer for Neutralise.
// Security boundaries:
//   - fails closed if Graph omits parentReference.path or returns a cross-drive item (SEC-03)
//   - never lists, browses or imports anything inside SHAREPOINT_STORAGE_FOLDER ("_app-storage")
//   - when SHAREPOINT_ORDERS_ROOT is set, never escapes outside it
//   - checks size (<= 100 MB) and PDF magic bytes on the first 8 bytes (SEC-02) before storing
import "server-only";
import { logAudit, type Actor } from "../audit";
import type { Db } from "../db";
import { cleanFilename, detectType, MAX_FILE_MB, maxFileBytes, newUploadKey } from "../files";
import type { Storage } from "../storage";
import type { DriveItem, SharePointClient } from "./client";
import {
  isInsideInternalStorage,
  isWithinFolder,
  sanitizeRelativePath,
  validateItemId,
  type SharePointConfig,
} from "./config";
import { readStreamSafe } from "./guard";

export class SharePointOrderError extends Error {}

export type OrderEntry = {
  id: string;
  name: string;
  isFolder: boolean;
  isPdf: boolean;
  size: number;
  modifiedAt: string | null;
  folderPath: string;
  webUrl: string | null;
};

export type BrowseResult = {
  currentFolderId: string | null;
  currentPath: string;
  parentId: string | null;
  suggestedFileNr: string | null;
  items: OrderEntry[];
};

const DOSSIER_RE = /\b(\d{3}\.S\d{4,6})\b/i;
const PO_RE = /\b(PO\d{4,10})\b/i;

/** Proposes a TMC dossier (840.S0850) or PO number (PO019423) from a SharePoint folder path. */
export function extractFileNrFromPath(folderPath: string | null | undefined): string | null {
  if (!folderPath) return null;
  const segments = folderPath.split("/").filter(Boolean).reverse();
  for (const seg of segments) {
    const m = DOSSIER_RE.exec(seg);
    if (m) return m[1].toUpperCase();
  }
  for (const seg of segments) {
    const m = PO_RE.exec(seg);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function fullPathOf(item: DriveItem): string {
  return [item.parentPath, item.name].filter(Boolean).join("/");
}

function toEntry(item: DriveItem): OrderEntry {
  const isPdf = !item.isFolder && (item.mimeType === "application/pdf" || /\.pdf$/i.test(item.name));
  return {
    id: item.id,
    name: item.name,
    isFolder: item.isFolder,
    isPdf,
    size: item.size,
    modifiedAt: item.modifiedAt,
    folderPath: item.isFolder ? fullPathOf(item) : item.parentPath,
    webUrl: item.webUrl,
  };
}

/** Strict fail-closed visibility boundary for order browsing and importing (SEC-03). */
function visibleInOrders(item: DriveItem, cfg: SharePointConfig): boolean {
  if (!item.hasTrustedParent) return false;
  if (isInsideInternalStorage(item.parentPath, item.name, cfg.storageFolder)) return false;
  if (cfg.ordersRoot && !isWithinFolder(fullPathOf(item), cfg.ordersRoot)) return false;
  return true;
}

function sortEntries(entries: OrderEntry[]): OrderEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    if (a.isPdf !== b.isPdf) return a.isPdf ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

/** Lists one SharePoint order folder (or searches within SHAREPOINT_ORDERS_ROOT). */
export async function browseSharePointOrders(
  client: SharePointClient,
  cfg: SharePointConfig,
  opts: { folderId?: string; query?: string } = {},
): Promise<BrowseResult> {
  const query = (opts.query ?? "").trim();
  if (query) {
    if (query.length > 80) throw new SharePointOrderError("search query is too long");
    const found = await client.searchItems(query, { rootPath: cfg.ordersRoot || undefined, limit: 50 });
    const items = sortEntries(found.filter((it) => visibleInOrders(it, cfg)).map(toEntry));
    return {
      currentFolderId: null,
      currentPath: cfg.ordersRoot,
      parentId: null,
      suggestedFileNr: null,
      items,
    };
  }

  let currentFolder: DriveItem | null = null;
  if (opts.folderId) {
    let id: string;
    try {
      id = validateItemId(opts.folderId);
    } catch {
      throw new SharePointOrderError("invalid folder reference");
    }
    const folder = await client.getItemById(id);
    if (!folder || !folder.isFolder || !visibleInOrders(folder, cfg)) {
      throw new SharePointOrderError("folder not found");
    }
    currentFolder = folder;
  }

  const raw = currentFolder
    ? await client.listChildren({ folderId: currentFolder.id, limit: 200 })
    : await client.listChildren({ folderPath: cfg.ordersRoot || undefined, limit: 200 });

  const currentPath = currentFolder ? fullPathOf(currentFolder) : cfg.ordersRoot;
  // Only expose parentId when moving up stays strictly within SHAREPOINT_ORDERS_ROOT.
  const parentId =
    currentFolder &&
    currentPath.toLowerCase() !== cfg.ordersRoot.toLowerCase() &&
    isWithinFolder(currentFolder.parentPath, cfg.ordersRoot) &&
    currentFolder.parentPath.toLowerCase() !== cfg.ordersRoot.toLowerCase()
      ? currentFolder.parentId
      : null;

  return {
    currentFolderId: currentFolder?.id ?? null,
    currentPath,
    parentId,
    suggestedFileNr: extractFileNrFromPath(currentPath),
    items: sortEntries(raw.filter((it) => visibleInOrders(it, cfg)).map(toEntry)),
  };
}

export type ImportedPdf = {
  key: string;
  filename: string;
  folderPath: string | null;
  suggestedFileNr: string | null;
};

/**
 * Downloads a PDF from a SharePoint order folder, validates size + early PDF magic bytes, and
 * saves an immutable input snapshot in app storage so the neutralise pipeline runs unchanged.
 */
export async function importSharePointPdf(
  db: Db,
  storage: Storage,
  client: SharePointClient,
  cfg: SharePointConfig,
  actor: Actor,
  rawItemId: unknown,
): Promise<ImportedPdf> {
  let itemId: string;
  try {
    itemId = validateItemId(rawItemId);
  } catch {
    throw new SharePointOrderError("invalid SharePoint file reference");
  }
  const item = await client.getItemById(itemId);
  if (!item || item.isFolder || !visibleInOrders(item, cfg)) {
    throw new SharePointOrderError("file not found in SharePoint");
  }
  const limit = maxFileBytes("input");
  if (item.size <= 0) throw new SharePointOrderError("file is empty");
  if (item.size > limit) throw new SharePointOrderError(`file is larger than ${MAX_FILE_MB.input} MB`);

  const file = await client.downloadById(item.id, limit);
  if (!file) throw new SharePointOrderError("file not found in SharePoint");
  const read = await readStreamSafe(file.stream, {
    maxBytes: limit,
    validateHead: (head) => detectType("input", head),
  });
  if (!read.ok) {
    if (read.reason === "too_large") throw new SharePointOrderError(`file is larger than ${MAX_FILE_MB.input} MB`);
    if (read.reason === "invalid_type") throw new SharePointOrderError("only PDF files can be sent to the neutralizer");
    if (read.reason === "timeout") throw new SharePointOrderError("downloading the file from SharePoint timed out");
    throw new SharePointOrderError("file is empty");
  }

  const key = newUploadKey("input");
  await storage.put(key, read.bytes, "application/pdf");
  const filename = cleanFilename(item.name);
  let folderPath: string | null = null;
  if (item.parentPath) {
    try {
      const clean = sanitizeRelativePath(item.parentPath, { allowEmpty: true });
      if (clean && !isInsideInternalStorage(clean, undefined, cfg.storageFolder) && !isWithinFolder(clean, cfg.generalFolder)) {
        folderPath = clean;
      }
    } catch {
      folderPath = null;
    }
  }
  await logAudit(db, actor, "sharepoint.imported", null, {
    itemId: item.id,
    filename,
    size: read.bytes.byteLength,
    folderPath,
  });
  return {
    key,
    filename,
    folderPath,
    suggestedFileNr: extractFileNrFromPath(folderPath),
  };
}
