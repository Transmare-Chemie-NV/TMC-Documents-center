// SharePoint (Microsoft Graph) configuration and path validation.
// One config switches between the test SharePoint library (TMCDOCUMENTCENTER) and the live DMS
// in January without code changes. Fails closed if partially configured.
import "server-only";

export class SharePointConfigError extends Error {}

export type SharePointConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  siteId: string | null;
  driveId: string | null;
  /** Optional pinned tenant SharePoint host extracted from SHAREPOINT_SITE_ID (e.g. transmare.sharepoint.com). */
  tenantHost: string | null;
  /** Internal folder inside the library for uploads, drafts, previews, views and supplier originals. */
  storageFolder: string;
  /** Folder where copied/live order folders live (empty = library root). */
  ordersRoot: string;
  /** Optional subfolder inside each order folder where Final TMC files are published (empty = order folder itself). */
  outputSubfolder: string;
  /** Folder where Final documents without a dossier/order number (e.g. general MSDS/TDS) are published. */
  generalFolder: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onmicrosoft\.com$/i;
// Graph site ids look like "transmare.sharepoint.com,<guid>,<guid>" or a host+path id.
const SITE_ID_RE = /^[A-Za-z0-9.,_-]{5,200}$/;
// Graph drive ids look like "b!..." (base64url + !).
export const DRIVE_ID_RE = /^[A-Za-z0-9!_-]{10,200}$/;
// Graph driveItem ids (alphanumeric + ! . _ -). Never slashes, never "..".
const ITEM_ID_RE = /^[A-Za-z0-9!._-]{1,200}$/;
// DNS label (no leading/trailing hyphen, no empty label).
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
// Config folder paths: strict set (no URL-sensitive chars).
const BAD_CONFIG_CHARS = /[<>:"/\\|?*#%&{}\u0000-\u001f\u007f\p{Cf}]/u;
// SharePoint Online item/filename forbidden characters (allows % and & needed by BRIEF 7.5 TDS names).
const BAD_SP_ITEM_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f\p{Cf}]/u;
// SharePoint / Windows reserved names that SharePoint Online refuses (SEC-11).
const RESERVED_SP_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|desktop\.ini|\.lock|forms)$/i;

export type Env = Record<string, string | undefined>;

function isReservedSharePointSegment(seg: string): boolean {
  const lower = seg.toLowerCase();
  const base = lower.split(".")[0] ?? lower;
  return RESERVED_SP_NAME.test(lower) || RESERVED_SP_NAME.test(base) || lower.includes("_vti_");
}

/** Validates a relative folder path inside a SharePoint library (no traversal, no control chars). */
export function sanitizeRelativePath(raw: string | undefined, opts: { allowEmpty?: boolean; label?: string } = {}): string {
  const label = opts.label ?? "SharePoint folder path";
  const trimmed = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    if (opts.allowEmpty) return "";
    throw new SharePointConfigError(`${label} cannot be empty`);
  }
  const parts = trimmed.split("/");
  if (parts.length > 8) throw new SharePointConfigError(`${label} is nested too deeply`);
  for (const seg of parts) {
    if (!seg || seg === "." || seg === "..") throw new SharePointConfigError(`${label} contains an invalid path segment`);
    if (seg.length > 120) throw new SharePointConfigError(`${label} segment is too long`);
    if (seg.startsWith(" ") || seg.endsWith(" ") || seg.endsWith(".")) {
      throw new SharePointConfigError(`${label} segment cannot start/end with space or end with a dot`);
    }
    if (BAD_CONFIG_CHARS.test(seg) || isReservedSharePointSegment(seg)) {
      throw new SharePointConfigError(`${label} contains disallowed characters or reserved name`);
    }
  }
  return parts.join("/");
}

/** Validates a single SharePoint filename or folder name segment (for uploads/folders). */
export function validatePathSegment(seg: string, label = "name"): string {
  const s = seg.trim();
  if (!s || s === "." || s === ".." || s.length > 200) throw new SharePointConfigError(`invalid ${label}`);
  if (s.endsWith(".") || BAD_SP_ITEM_CHARS.test(s) || isReservedSharePointSegment(s)) {
    throw new SharePointConfigError(`invalid ${label}`);
  }
  return s;
}

/** Converts a dossier/file nr into a safe single SharePoint folder segment. */
export function safeFolderName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[<>:"/\\|?*#%&{}\u0000-\u001f\u007f\p{Cf}]+/gu, "_")
    .replace(/\.+$/g, "")
    .trim()
    .slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === ".." || isReservedSharePointSegment(cleaned)) {
    throw new SharePointConfigError("invalid folder name");
  }
  return cleaned;
}

/** Validates a Microsoft Graph driveItem id before placing it in a Graph URL. */
export function validateItemId(id: unknown): string {
  if (typeof id !== "string" || !ITEM_ID_RE.test(id) || id === "." || id === ".." || id.includes("..")) {
    throw new SharePointConfigError("invalid SharePoint item id");
  }
  return id;
}

function validSubdomainOf(host: string, suffix: string): boolean {
  if (!host.endsWith(`.${suffix}`)) return false;
  const prefix = host.slice(0, -(suffix.length + 1));
  if (!prefix) return false;
  const labels = prefix.split(".");
  return labels.length >= 1 && labels.every((l) => DNS_LABEL_RE.test(l));
}

/**
 * SSRF guard for Microsoft Graph upload session URLs and download redirects (SEC-11):
 *   - plain https only, no credentials, no custom port
 *   - strict DNS subdomain check (rejects leading-dot ".sharepoint.com")
 *   - when `allowedTenantHost` is provided (from SHAREPOINT_SITE_ID), pins *.sharepoint.com to that exact tenant host.
 */
export function isSafeSharePointHost(rawUrl: string, allowedTenantHost?: string | null): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (host === "graph.microsoft.com") return true;
  if (validSubdomainOf(host, "sharepoint.com")) {
    if (allowedTenantHost) return host === allowedTenantHost.toLowerCase();
    return true;
  }
  return validSubdomainOf(host, "sharepointonline.com") || validSubdomainOf(host, "1drv.com");
}

/**
 * Decodes a raw Graph `parentReference.path` EXACTLY ONCE (SEC-03).
 * Requires the Graph `root:` marker (e.g. "/drives/b!abc/root:/Orders/840.S0850" -> { ok: true, path: "Orders/840.S0850" }).
 * Fails closed (`ok: false`) if missing or lacking `root:`.
 */
export function parseGraphParentPath(rawParentRefPath: unknown): { ok: boolean; path: string } {
  if (typeof rawParentRefPath !== "string" || !rawParentRefPath) return { ok: false, path: "" };
  const idx = rawParentRefPath.indexOf("root:");
  if (idx === -1) return { ok: false, path: "" };
  const after = rawParentRefPath.slice(idx + 5);
  try {
    return { ok: true, path: decodeURIComponent(after).replace(/^\/+|\/+$/g, "") };
  } catch {
    return { ok: false, path: "" };
  }
}

/** Case-insensitive containment check: true when `path` equals `root` or is inside `root/`. */
export function isWithinFolder(path: string, root: string): boolean {
  const r = root.toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!r) return true;
  const p = path.toLowerCase().replace(/^\/+|\/+$/g, "");
  return p === r || p.startsWith(`${r}/`);
}

/**
 * True when an already-normalized relative path + item name IS `storageFolder` or lives inside it
 * (case-insensitive, matching SharePoint; zero double URL-decoding, SEC-03).
 */
export function isInsideInternalStorage(
  normalizedParentPath: string | null | undefined,
  itemName: string | undefined,
  storageFolder: string,
): boolean {
  const root = storageFolder.toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!root) return true; // fail closed
  const parent = (normalizedParentPath ?? "").replace(/^\/+|\/+$/g, "");
  const name = (itemName ?? "").replace(/^\/+|\/+$/g, "");
  const full = [parent, name].filter(Boolean).join("/").toLowerCase();
  return full === root || full.startsWith(`${root}/`);
}

function pathsOverlap(a: string, b: string): boolean {
  return isWithinFolder(a, b) || isWithinFolder(b, a);
}

function extractTenantHost(siteId: string | null): string | null {
  if (!siteId) return null;
  const candidate = siteId.split(",")[0]?.trim().toLowerCase() ?? "";
  return validSubdomainOf(candidate, "sharepoint.com") ? candidate : null;
}

/**
 * Reads SharePoint config from environment variables.
 * Returns null when SharePoint is not configured at all; throws SharePointConfigError when
 * partially or invalidly configured (never leaks secret values).
 */
export function readSharePointConfig(env: Env = process.env): SharePointConfig | null {
  const tenantId = (env.SHAREPOINT_TENANT_ID ?? "").trim();
  const clientId = (env.SHAREPOINT_CLIENT_ID ?? "").trim();
  const clientSecret = (env.SHAREPOINT_CLIENT_SECRET ?? "").trim();
  const siteId = (env.SHAREPOINT_SITE_ID ?? "").trim() || null;
  const driveId = (env.SHAREPOINT_DRIVE_ID ?? "").trim() || null;

  if (!tenantId && !clientId && !clientSecret && !siteId && !driveId) return null;

  if (!UUID_RE.test(tenantId) && !TENANT_DOMAIN_RE.test(tenantId)) {
    throw new SharePointConfigError("SHAREPOINT_TENANT_ID must be a tenant UUID or <tenant>.onmicrosoft.com");
  }
  if (!UUID_RE.test(clientId)) throw new SharePointConfigError("SHAREPOINT_CLIENT_ID must be a UUID");
  if (clientSecret.length < 8) throw new SharePointConfigError("SHAREPOINT_CLIENT_SECRET is missing or too short");
  if (!driveId && !siteId) throw new SharePointConfigError("set SHAREPOINT_DRIVE_ID or SHAREPOINT_SITE_ID");
  if (siteId && (!SITE_ID_RE.test(siteId) || siteId.includes(".."))) {
    throw new SharePointConfigError("SHAREPOINT_SITE_ID is invalid");
  }
  if (driveId && (!DRIVE_ID_RE.test(driveId) || driveId.includes(".."))) {
    throw new SharePointConfigError("SHAREPOINT_DRIVE_ID is invalid");
  }

  const storageFolder = sanitizeRelativePath(env.SHAREPOINT_STORAGE_FOLDER || "_app-storage", {
    allowEmpty: false,
    label: "SHAREPOINT_STORAGE_FOLDER",
  });
  const ordersRoot = sanitizeRelativePath(env.SHAREPOINT_ORDERS_ROOT ?? "", {
    allowEmpty: true,
    label: "SHAREPOINT_ORDERS_ROOT",
  });
  const outputSubfolder = sanitizeRelativePath(env.SHAREPOINT_OUTPUT_SUBFOLDER ?? "", {
    allowEmpty: true,
    label: "SHAREPOINT_OUTPUT_SUBFOLDER",
  });
  const generalFolder = sanitizeRelativePath(env.SHAREPOINT_GENERAL_FOLDER || "General", {
    allowEmpty: false,
    label: "SHAREPOINT_GENERAL_FOLDER",
  });

  if (pathsOverlap(storageFolder, generalFolder)) {
    throw new SharePointConfigError("SHAREPOINT_STORAGE_FOLDER and SHAREPOINT_GENERAL_FOLDER cannot overlap");
  }
  if (ordersRoot && pathsOverlap(storageFolder, ordersRoot)) {
    throw new SharePointConfigError("SHAREPOINT_STORAGE_FOLDER and SHAREPOINT_ORDERS_ROOT cannot overlap");
  }

  return {
    tenantId,
    clientId,
    clientSecret,
    siteId,
    driveId,
    tenantHost: extractTenantHost(siteId),
    storageFolder,
    ordersRoot,
    outputSubfolder,
    generalFolder,
  };
}

export function isSharePointConfigured(env: Env = process.env): boolean {
  return readSharePointConfig(env) !== null;
}
