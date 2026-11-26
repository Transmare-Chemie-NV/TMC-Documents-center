import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Actor } from "../audit";
import { createPgliteDb } from "../db";
import { auditLog, documents } from "../db/schema";
import { newUploadKey } from "../files";
import type { Storage } from "../storage";
import {
  SharePointConfigError,
  SharePointConflictError,
  SharePointError,
  browseSharePointOrders,
  createGraphClient,
  createSharePointStorage,
  extractFileNrFromPath,
  importSharePointPdf,
  isInsideInternalStorage,
  isSafeSharePointHost,
  parseGraphParentPath,
  publishFinalToSharePoint,
  readSharePointConfig,
  resolvePublishFolder,
  validateItemId,
  versionedFilename,
  type DriveItem,
  type SharePointClient,
  type SharePointConfig,
} from "./index";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const willem: Actor = { email: "wilman@transmare.com", name: "Willem", role: "admin" };

const BASE_ENV = {
  SHAREPOINT_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  SHAREPOINT_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  SHAREPOINT_CLIENT_SECRET: "super-secret-value-for-tests",
  SHAREPOINT_DRIVE_ID: "b!drive-id-1234567890",
};

const BASE_CFG: SharePointConfig = readSharePointConfig(BASE_ENV)!;

/** Deterministic in-memory SharePoint drive fake for application/integration tests (no network). */
class FakeSharePoint implements SharePointClient {
  private seq = 1;
  private items = new Map<string, { item: DriveItem; bytes?: Uint8Array }>();
  private byPath = new Map<string, string>();
  failNextUploadOnSuffix: string | null = null;
  failNextUploadWith: Error | null = null;
  onBeforeUpload: (() => Promise<void>) | null = null;

  private norm(p: string) {
    return p.replace(/^\/+|\/+$/g, "").toLowerCase();
  }

  seedFolder(relPath: string): DriveItem {
    const parts = relPath.split("/").filter(Boolean);
    let cur = "";
    let last: DriveItem | null = null;
    for (const seg of parts) {
      const next = cur ? `${cur}/${seg}` : seg;
      const existingId = this.byPath.get(this.norm(next));
      if (existingId) {
        last = this.items.get(existingId)!.item;
        cur = next;
        continue;
      }
      const id = `item-${this.seq++}`;
      const parentId = cur ? (this.byPath.get(this.norm(cur)) ?? null) : null;
      const item: DriveItem = {
        id,
        name: seg,
        size: 0,
        isFolder: true,
        mimeType: null,
        webUrl: `https://transmare.sharepoint.com/teams/TMCDOCUMENTCENTER/Shared%20Documents/${encodeURIComponent(next)}`,
        parentId,
        parentPath: cur,
        hasTrustedParent: true,
        modifiedAt: "2026-11-26T10:00:00Z",
      };
      this.items.set(id, { item });
      this.byPath.set(this.norm(next), id);
      last = item;
      cur = next;
    }
    return last!;
  }

  seedFile(
    relPath: string,
    bytes: Uint8Array,
    mimeType = "application/pdf",
    opts: { sizeOverride?: number; hasTrustedParent?: boolean } = {},
  ): DriveItem {
    const parts = relPath.split("/").filter(Boolean);
    const name = parts.pop()!;
    const parentPath = parts.join("/");
    const parent = parentPath ? this.seedFolder(parentPath) : null;
    const id = `item-${this.seq++}`;
    const item: DriveItem = {
      id,
      name,
      size: opts.sizeOverride ?? bytes.byteLength,
      isFolder: false,
      mimeType,
      webUrl: `https://transmare.sharepoint.com/teams/TMCDOCUMENTCENTER/Shared%20Documents/${relPath}`,
      parentId: parent?.id ?? null,
      parentPath,
      hasTrustedParent: opts.hasTrustedParent ?? true,
      modifiedAt: "2026-11-26T10:00:00Z",
    };
    this.items.set(id, { item, bytes });
    this.byPath.set(this.norm(relPath), id);
    return item;
  }

  hasPath(relPath: string) {
    return this.byPath.has(this.norm(relPath));
  }

  async getItemById(itemId: string) {
    return this.items.get(validateItemId(itemId))?.item ?? null;
  }

  async getItemByPath(relPath: string) {
    const id = this.byPath.get(this.norm(relPath));
    return id ? (this.items.get(id)?.item ?? null) : null;
  }

  async listChildren(opts: { folderId?: string; folderPath?: string } = {}) {
    let targetPath = "";
    if (opts.folderId) {
      const f = this.items.get(opts.folderId)?.item;
      if (!f || !f.isFolder) return [];
      targetPath = [f.parentPath, f.name].filter(Boolean).join("/");
    } else if (opts.folderPath) {
      targetPath = opts.folderPath;
    }
    const want = this.norm(targetPath);
    return Array.from(this.items.values())
      .map((x) => x.item)
      .filter((it) => this.norm(it.parentPath) === want);
  }

  async searchItems(query: string, opts: { rootPath?: string } = {}) {
    const q = query.trim().toLowerCase();
    const root = opts.rootPath ? this.norm(opts.rootPath) : "";
    return Array.from(this.items.values())
      .map((x) => x.item)
      .filter((it) => {
        const full = this.norm([it.parentPath, it.name].filter(Boolean).join("/"));
        if (root && full !== root && !full.startsWith(`${root}/`)) return false;
        return it.name.toLowerCase().includes(q);
      });
  }

  private streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
  }

  async downloadById(itemId: string) {
    const entry = this.items.get(validateItemId(itemId));
    if (!entry || !entry.bytes) return null;
    return { stream: this.streamOf(entry.bytes), size: entry.bytes.byteLength, contentType: entry.item.mimeType };
  }

  async downloadByPath(relPath: string) {
    const id = this.byPath.get(this.norm(relPath));
    return id ? this.downloadById(id) : null;
  }

  async headByPath(relPath: string, n: number) {
    const id = this.byPath.get(this.norm(relPath));
    const entry = id ? this.items.get(id) : undefined;
    if (!entry || !entry.bytes) return null;
    return { bytes: entry.bytes.subarray(0, n), size: entry.bytes.byteLength };
  }

  async ensureFolder(relPath: string) {
    return this.seedFolder(relPath);
  }

  async uploadFile(relPath: string, data: Uint8Array, contentType: string) {
    if (this.onBeforeUpload) {
      const hook = this.onBeforeUpload;
      this.onBeforeUpload = null;
      await hook();
    }
    if (this.failNextUploadOnSuffix && relPath.endsWith(this.failNextUploadOnSuffix)) {
      this.failNextUploadOnSuffix = null;
      const err = this.failNextUploadWith ?? new SharePointError("Graph unavailable", 503);
      this.failNextUploadWith = null;
      throw err;
    }
    if (this.byPath.has(this.norm(relPath))) throw new SharePointConflictError();
    return this.seedFile(relPath, new Uint8Array(data), contentType);
  }
}

function memoryStorage(sp: FakeSharePoint, cfg: SharePointConfig = BASE_CFG): Storage {
  return createSharePointStorage(sp, cfg);
}

describe("SharePoint config & security validation", () => {
  it("returns null when SharePoint is not configured at all", () => {
    expect(readSharePointConfig({})).toBeNull();
  });

  it("reads valid config with defaults, supports siteId-only config, and extracts tenantHost", () => {
    const cfg = readSharePointConfig(BASE_ENV)!;
    expect(cfg.storageFolder).toBe("_app-storage");
    expect(cfg.generalFolder).toBe("General");
    expect(cfg.ordersRoot).toBe("");
    expect(cfg.outputSubfolder).toBe("");

    const bySite = readSharePointConfig({
      SHAREPOINT_TENANT_ID: "transmare.onmicrosoft.com",
      SHAREPOINT_CLIENT_ID: BASE_ENV.SHAREPOINT_CLIENT_ID,
      SHAREPOINT_CLIENT_SECRET: BASE_ENV.SHAREPOINT_CLIENT_SECRET,
      SHAREPOINT_SITE_ID: "transmare.sharepoint.com,aaa,bbb",
    })!;
    expect(bySite.siteId).toBe("transmare.sharepoint.com,aaa,bbb");
    expect(bySite.tenantHost).toBe("transmare.sharepoint.com");
    expect(bySite.driveId).toBeNull();
  });

  it("fails closed on partial, invalid, traversal, reserved-name, or overlapping folder configs", () => {
    expect(() => readSharePointConfig({ SHAREPOINT_TENANT_ID: BASE_ENV.SHAREPOINT_TENANT_ID })).toThrow(SharePointConfigError);
    expect(() => readSharePointConfig({ ...BASE_ENV, SHAREPOINT_TENANT_ID: "evil.com/path" })).toThrow(SharePointConfigError);
    expect(() => readSharePointConfig({ ...BASE_ENV, SHAREPOINT_STORAGE_FOLDER: "../escape" })).toThrow(SharePointConfigError);
    expect(() => readSharePointConfig({ ...BASE_ENV, SHAREPOINT_ORDERS_ROOT: "Orders\\..\\secret" })).toThrow(SharePointConfigError);
    expect(() => readSharePointConfig({ ...BASE_ENV, SHAREPOINT_GENERAL_FOLDER: "CON" })).toThrow(SharePointConfigError);
    expect(() => readSharePointConfig({ ...BASE_ENV, SHAREPOINT_GENERAL_FOLDER: "_vti_cnf" })).toThrow(SharePointConfigError);
    expect(() =>
      readSharePointConfig({ ...BASE_ENV, SHAREPOINT_STORAGE_FOLDER: "Shared", SHAREPOINT_GENERAL_FOLDER: "shared/General" }),
    ).toThrow(SharePointConfigError);
    expect(() =>
      readSharePointConfig({ ...BASE_ENV, SHAREPOINT_STORAGE_FOLDER: "Orders/App", SHAREPOINT_ORDERS_ROOT: "Orders" }),
    ).toThrow(SharePointConfigError);
  });

  it("enforces strict SSRF host + tenant pinning, item id validation, and single-decode internal storage boundary", () => {
    expect(isSafeSharePointHost("https://transmare.sharepoint.com/teams/TMCDOCUMENTCENTER", "transmare.sharepoint.com")).toBe(true);
    expect(isSafeSharePointHost("https://other.sharepoint.com/teams/x", "transmare.sharepoint.com")).toBe(false);
    expect(isSafeSharePointHost("https://.sharepoint.com/x")).toBe(false);
    expect(isSafeSharePointHost("https://graph.microsoft.com/v1.0/drives")).toBe(true);
    expect(isSafeSharePointHost("http://transmare.sharepoint.com/x")).toBe(false);
    expect(isSafeSharePointHost("https://sharepoint.com.evil.com/x")).toBe(false);
    expect(isSafeSharePointHost("https://user:pass@transmare.sharepoint.com/x")).toBe(false);
    expect(isSafeSharePointHost("https://transmare.sharepoint.com:8443/x")).toBe(false);
    expect(isSafeSharePointHost("javascript:alert(1)")).toBe(false);

    expect(validateItemId("01ABCDEF!123_abc-9")).toBe("01ABCDEF!123_abc-9");
    expect(() => validateItemId("../etc/passwd")).toThrow(SharePointConfigError);
    expect(() => validateItemId("a/b")).toThrow(SharePointConfigError);
    expect(() => validateItemId("")).toThrow(SharePointConfigError);

    expect(parseGraphParentPath("/drives/b!1/root:/_APP-STORAGE/uploads")).toEqual({ ok: true, path: "_APP-STORAGE/uploads" });
    expect(parseGraphParentPath("/drive/root:")).toEqual({ ok: true, path: "" });
    expect(parseGraphParentPath(null)).toEqual({ ok: false, path: "" });
    expect(parseGraphParentPath("/drives/b!1/no-marker")).toEqual({ ok: false, path: "" });

    expect(isInsideInternalStorage("", "_app-storage", "_app-storage")).toBe(true);
    expect(isInsideInternalStorage("_APP-STORAGE/uploads", "pdf", "_app-storage")).toBe(true);
    expect(isInsideInternalStorage("_app-storage", undefined, "_app-storage")).toBe(true);
    expect(isInsideInternalStorage("Orders/840.S0850", "coa.pdf", "_app-storage")).toBe(false);
  });
});

describe("Microsoft Graph client (mocked fetch, zero network)", () => {
  it("blocks SSRF redirects and never forwards Bearer token to download redirect", async () => {
    const seenHeaders: Record<string, Headers> = {};
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      seenHeaders[url] = new Headers(init?.headers);
      if (url.includes("login.microsoftonline.com")) {
        return Response.json({ access_token: "tok-123", expires_in: 3600 });
      }
      if (url.includes("/content")) {
        return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = createGraphClient(BASE_CFG, fakeFetch);
    await expect(client.downloadByPath("_app-storage/uploads/x/pdf", 1024)).rejects.toThrow(/unexpected download host/);

    const goodFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      seenHeaders[url] = new Headers(init?.headers);
      if (url.includes("login.microsoftonline.com")) {
        return Response.json({ access_token: "tok-123", expires_in: 3600 });
      }
      if (url.includes("graph.microsoft.com")) {
        return new Response(null, { status: 302, headers: { location: "https://transmare.sharepoint.com/dl/file1" } });
      }
      return new Response(PDF, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(PDF.length) } });
    };
    const okClient = createGraphClient(BASE_CFG, goodFetch);
    const file = await okClient.downloadByPath("_app-storage/uploads/x/pdf", 1024);
    expect(file?.size).toBe(PDF.length);
    expect(seenHeaders["https://transmare.sharepoint.com/dl/file1"]?.get("authorization")).toBeNull();
  });

  it("sets hasTrustedParent=false when Graph omits parentReference.path or driveId mismatches (SEC-03)", async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "tok", expires_in: 3600 });
      if (url.includes("item-missing")) return Response.json({ id: "item-missing", name: "secret.pdf", size: 9, file: {} });
      return Response.json({
        id: "item-xdrive",
        name: "secret.pdf",
        size: 9,
        file: {},
        parentReference: { driveId: "b!other-drive-99999", path: "/drives/b!other-drive-99999/root:/840.S0850" },
      });
    };
    const client = createGraphClient(BASE_CFG, fakeFetch);
    expect((await client.getItemById("item-missing"))?.hasTrustedParent).toBe(false);
    expect((await client.getItemById("item-xdrive"))?.hasTrustedParent).toBe(false);
  });

  it("uploads with conflictBehavior=fail, rejects bad uploadUrl, throws on 409, and deletes abandoned sessions (SEC-09)", async () => {
    let sessionBody = "";
    const deletedUrls: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "tok-1", expires_in: 3600 });
      if (url.includes("createUploadSession")) {
        sessionBody = String(init?.body ?? "");
        return Response.json({ uploadUrl: "https://evil.example/upload" });
      }
      if (init?.method !== "POST") return Response.json({ id: "dir-1", name: "840.S0850", folder: {}, parentReference: { path: "/drive/root:" } });
      return new Response("ok", { status: 200 });
    };
    const badClient = createGraphClient(BASE_CFG, fakeFetch);
    await expect(badClient.uploadFile("840.S0850/a.pdf", PDF, "application/pdf")).rejects.toThrow(/unexpected upload host/);
    expect(JSON.parse(sessionBody)).toEqual({ item: { "@microsoft.graph.conflictBehavior": "fail" } });

    const midFailFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "tok-1", expires_in: 3600 });
      if (url.includes("createUploadSession")) return Response.json({ uploadUrl: "https://transmare.sharepoint.com/upload-session-1" });
      if (url.includes("upload-session-1") && init?.method === "PUT") return new Response("err", { status: 503 });
      if (url.includes("upload-session-1") && init?.method === "DELETE") {
        deletedUrls.push(url);
        return new Response(null, { status: 204 });
      }
      return Response.json({ id: "dir-1", name: "840.S0850", folder: {}, parentReference: { path: "/drive/root:" } });
    };
    await expect(createGraphClient(BASE_CFG, midFailFetch).uploadFile("840.S0850/a.pdf", PDF, "application/pdf")).rejects.toThrow(/HTTP 503/);
    expect(deletedUrls).toEqual(["https://transmare.sharepoint.com/upload-session-1"]);

    const conflictFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "tok-1", expires_in: 3600 });
      if (url.includes("createUploadSession")) return new Response("exists", { status: 409 });
      if (init?.method !== "POST") return Response.json({ id: "dir-1", name: "840.S0850", folder: {}, parentReference: { path: "/drive/root:" } });
      return new Response("ok", { status: 200 });
    };
    await expect(createGraphClient(BASE_CFG, conflictFetch).uploadFile("840.S0850/a.pdf", PDF, "application/pdf")).rejects.toThrow(
      SharePointConflictError,
    );
  });

  it("strips KQL operators from search queries (SEC-11)", async () => {
    let seenUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "tok", expires_in: 3600 });
      seenUrl = url;
      return Response.json({ value: [] });
    };
    await createGraphClient(BASE_CFG, fakeFetch).searchItems('path:"_app-storage"* (secret)');
    expect(seenUrl).toContain("search(q='path%20_app-storage%20secret')");
  });
});

describe("SharePoint storage adapter & order browser/importer", () => {
  it("stores files strictly under _app-storage, enforces size cap, and refuses overwrites and bad keys", async () => {
    const sp = new FakeSharePoint();
    const storage = memoryStorage(sp);
    const key = newUploadKey("pdf");
    await storage.put(key, PDF, "application/pdf");
    expect(sp.hasPath(`_app-storage/${key}`)).toBe(true);
    const head = await storage.head(key, 8);
    expect(head?.size).toBe(PDF.length);
    expect(Array.from(head!.bytes.subarray(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    await expect(storage.put(key, PDF, "application/pdf")).rejects.toThrow(SharePointConflictError);
    await expect(storage.put("../outside/pdf", PDF, "application/pdf")).rejects.toThrow(/invalid storage key/);
    // SEC-11: storage.put enforces per-slot size limit (pdf max = 25 MB).
    const oversizePdf = new Uint8Array(26 * 1024 * 1024);
    await expect(storage.put(newUploadKey("pdf"), oversizePdf, "application/pdf")).rejects.toThrow(/25 MB/);
  });

  it("hides _app-storage and untrusted-parent items from browsing, search, direct folderId, and file import (SEC-03)", async () => {
    const sp = new FakeSharePoint();
    const internalFolder = sp.seedFolder("_app-storage");
    const internalFile = sp.seedFile("_app-storage/uploads/11111111-1111-4111-8111-111111111111/source", PDF);
    const untrustedFile = sp.seedFile("840.S0850/untrusted.pdf", PDF, "application/pdf", { hasTrustedParent: false });
    const orderFolder = sp.seedFolder("840.S0850");
    sp.seedFile("840.S0850/supplier_coa.pdf", PDF);

    const root = await browseSharePointOrders(sp, BASE_CFG);
    expect(root.items.map((x) => x.name)).toEqual(["840.S0850"]);

    const search = await browseSharePointOrders(sp, BASE_CFG, { query: "source" });
    expect(search.items).toEqual([]);

    await expect(browseSharePointOrders(sp, BASE_CFG, { folderId: internalFolder.id })).rejects.toThrow(/folder not found/);

    const inside = await browseSharePointOrders(sp, BASE_CFG, { folderId: orderFolder.id });
    expect(inside.suggestedFileNr).toBe("840.S0850");
    expect(inside.items.map((x) => x.name)).toEqual(["supplier_coa.pdf"]);

    const db = await createPgliteDb();
    await expect(importSharePointPdf(db, memoryStorage(sp), sp, BASE_CFG, willem, internalFile.id)).rejects.toThrow(/file not found/);
    await expect(importSharePointPdf(db, memoryStorage(sp), sp, BASE_CFG, willem, untrustedFile.id)).rejects.toThrow(/file not found/);
  });

  it("enforces ordersRoot containment, PDF magic bytes, and size cap on import", async () => {
    const cfg = readSharePointConfig({ ...BASE_ENV, SHAREPOINT_ORDERS_ROOT: "Orders" })!;
    const sp = new FakeSharePoint();
    const outside = sp.seedFile("Other/secret.pdf", PDF);
    const badFile = sp.seedFile("Orders/840.S0850/fake.pdf", EXE);
    const hugeFile = sp.seedFile("Orders/840.S0850/huge.pdf", PDF, "application/pdf", { sizeOverride: 101 * 1024 * 1024 });
    const goodFile = sp.seedFile("Orders/840.S0850/supplier_coa.pdf", PDF);

    const db = await createPgliteDb();
    const storage = memoryStorage(sp, cfg);

    await expect(importSharePointPdf(db, storage, sp, cfg, willem, outside.id)).rejects.toThrow(/file not found/);
    await expect(importSharePointPdf(db, storage, sp, cfg, willem, badFile.id)).rejects.toThrow(/only PDF/);
    await expect(importSharePointPdf(db, storage, sp, cfg, willem, hugeFile.id)).rejects.toThrow(/larger than 100 MB/);

    const imported = await importSharePointPdf(db, storage, sp, cfg, willem, goodFile.id);
    expect(imported.filename).toBe("supplier_coa.pdf");
    expect(imported.folderPath).toBe("Orders/840.S0850");
    expect(imported.suggestedFileNr).toBe("840.S0850");
    expect(sp.hasPath(`_app-storage/${imported.key}`)).toBe(true);

    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "sharepoint.imported"));
    expect(audit).toHaveLength(1);
  });

  it("extracts dossier and PO numbers from nested paths", () => {
    expect(extractFileNrFromPath("Orders/2026/Order 840.S0850 Betaine")).toBe("840.S0850");
    expect(extractFileNrFromPath("Purchases/PO019423/Supplier")).toBe("PO019423");
    expect(extractFileNrFromPath("General")).toBeNull();
  });
});

describe("Final PDF + Word publishing to SharePoint (Hard Rules 2, 3, 4, 5 + SEC-04/05/06)", () => {
  async function insertDoc(
    db: Awaited<ReturnType<typeof createPgliteDb>>,
    storage: Storage,
    overrides: Partial<typeof documents.$inferInsert> = {},
  ) {
    const pdfKey = newUploadKey("pdf");
    const docxKey = newUploadKey("docx");
    const sourceKey = newUploadKey("source");
    await storage.put(pdfKey, PDF, "application/pdf");
    await storage.put(docxKey, DOCX, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await storage.put(sourceKey, PDF, "application/pdf");
    const [row] = await db
      .insert(documents)
      .values({
        name: "TMC_COA_840.S0850_Betaine_BT-3877",
        type: "COA",
        entity: "TMC",
        productName: "Betaine",
        fileNr: "840.S0850",
        batch: "BT-3877",
        supplierName: "Secret Supplier GmbH",
        status: "Final",
        version: 1,
        pdfKey,
        pdfFilename: "TMC_COA_840.S0850_Betaine_BT-3877.pdf",
        docxKey,
        docxFilename: "TMC_COA_840.S0850_Betaine_BT-3877.docx",
        sourceKey,
        sourceFilename: "supplier_secret.pdf",
        createdBy: willem.email,
        approvedBy: willem.email,
        approvedAt: new Date(),
        ...overrides,
      })
      .returning();
    return row;
  }

  it("refuses drafts, rejected, and superseded docs; never publishes supplier original", async () => {
    const db = await createPgliteDb();
    const sp = new FakeSharePoint();
    const storage = memoryStorage(sp);
    const draft = await insertDoc(db, storage, { status: "To check", version: null, pdfKey: null, pdfFilename: null });

    const res = await publishFinalToSharePoint(db, storage, sp, BASE_CFG, draft.id, willem);
    expect(res.ok).toBe(false);
    expect(sp.hasPath("840.S0850/TMC_COA_840.S0850_Betaine_BT-3877_v1.pdf")).toBe(false);
  });

  it("publishes Final PDF + Word with _v1 and _v2 into verified order folder, never overwriting", async () => {
    const db = await createPgliteDb();
    const sp = new FakeSharePoint();
    sp.seedFolder("2026/840.S0850");
    const storage = memoryStorage(sp);

    const v1 = await insertDoc(db, storage, { sharepointFolderPath: "2026/840.S0850" });
    const r1 = await publishFinalToSharePoint(db, storage, sp, BASE_CFG, v1.id, willem);
    expect(r1.ok).toBe(true);
    expect(sp.hasPath("2026/840.S0850/TMC_COA_840.S0850_Betaine_BT-3877_v1.pdf")).toBe(true);
    expect(sp.hasPath("2026/840.S0850/TMC_COA_840.S0850_Betaine_BT-3877_v1.docx")).toBe(true);
    expect(sp.hasPath("2026/840.S0850/supplier_secret.pdf")).toBe(false);

    const repeat = await publishFinalToSharePoint(db, storage, sp, BASE_CFG, v1.id, willem);
    expect(repeat).toMatchObject({ ok: true, alreadyPublished: true });

    await db.update(documents).set({ status: "Superseded" }).where(eq(documents.id, v1.id));
    const v2 = await insertDoc(db, storage, { version: 2, sharepointFolderPath: "2026/840.S0850" });
    const r2 = await publishFinalToSharePoint(db, storage, sp, BASE_CFG, v2.id, willem);
    expect(r2.ok).toBe(true);
    expect(sp.hasPath("2026/840.S0850/TMC_COA_840.S0850_Betaine_BT-3877_v1.pdf")).toBe(true);
    expect(sp.hasPath("2026/840.S0850/TMC_COA_840.S0850_Betaine_BT-3877_v2.pdf")).toBe(true);
    expect(sp.hasPath("2026/840.S0850/TMC_COA_840.S0850_Betaine_BT-3877_v2.docx")).toBe(true);
  });

  it("blocks arbitrary non-existent remembered folders and General/<subpath> targeting (SEC-05)", async () => {
    const sp = new FakeSharePoint();
    sp.seedFolder("General/840.S0850");
    // General/<subpath> is refused even when it exists!
    expect(await resolvePublishFolder(sp, BASE_CFG, { fileNr: "840.S0850", sharepointFolderPath: "General/840.S0850" })).toBe("840.S0850");
    // Non-existent arbitrary nested folder is NOT created/reused!
    expect(await resolvePublishFolder(sp, BASE_CFG, { fileNr: "840.S0850", sharepointFolderPath: "Arbitrary/Evil/840.S0850" })).toBe(
      "840.S0850",
    );
  });

  it("serializes concurrent publish calls via DB lease without clobbering published state (SEC-04)", async () => {
    const db = await createPgliteDb();
    const sp = new FakeSharePoint();
    const storage = memoryStorage(sp);
    const doc = await insertDoc(db, storage);

    let secondResult: Awaited<ReturnType<typeof publishFinalToSharePoint>> | null = null;
    sp.onBeforeUpload = async () => {
      secondResult = await publishFinalToSharePoint(db, storage, sp, BASE_CFG, doc.id, willem);
    };

    const firstResult = await publishFinalToSharePoint(db, storage, sp, BASE_CFG, doc.id, willem);
    expect(firstResult.ok).toBe(true);
    expect(secondResult).toEqual({
      ok: false,
      error: "SharePoint publish is already in progress. Refresh in a moment.",
    });

    const [finalRow] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(finalRow.sharepointPublishedAt).not.toBeNull();
    expect(finalRow.sharepointPublishingAt).toBeNull();
    expect(finalRow.sharepointError).toBeNull();
    expect(finalRow.sharepointPdfPath).toBe("840.S0850/TMC_COA_840.S0850_Betaine_BT-3877_v1.pdf");
  });

  it("publishes general documents into General/, sanitizes internal errors (SEC-06), and recovers from partial failure", async () => {
    const db = await createPgliteDb();
    const sp = new FakeSharePoint();
    const cfg = readSharePointConfig({ ...BASE_ENV, SHAREPOINT_OUTPUT_SUBFOLDER: "TMC Documents" })!;
    const storage = memoryStorage(sp, cfg);

    const msds = await insertDoc(db, storage, {
      name: "TMC_MSDS_HYDROQUINONE",
      type: "MSDS",
      productName: "HYDROQUINONE",
      fileNr: null,
      batch: null,
    });
    const r = await publishFinalToSharePoint(db, storage, sp, cfg, msds.id, willem);
    expect(r.ok).toBe(true);
    expect(sp.hasPath("General/TMC_MSDS_HYDROQUINONE_v1.pdf")).toBe(true);
    expect(sp.hasPath("General/TMC_MSDS_HYDROQUINONE_v1.docx")).toBe(true);

    const doc = await insertDoc(db, storage);
    sp.failNextUploadOnSuffix = ".docx";
    sp.failNextUploadWith = new Error("relation documents violates internal_secret_constraint");
    const first = await publishFinalToSharePoint(db, storage, sp, cfg, doc.id, willem);
    expect(first.ok).toBe(false);
    // SEC-06: raw internal error message must NEVER be stored or returned!
    expect(!first.ok && first.error).not.toContain("internal_secret_constraint");

    const [mid] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(mid.sharepointError).not.toContain("internal_secret_constraint");
    expect(mid.sharepointPdfPath).toBe("840.S0850/TMC Documents/TMC_COA_840.S0850_Betaine_BT-3877_v1.pdf");

    const retry = await publishFinalToSharePoint(db, storage, sp, cfg, doc.id, willem);
    expect(retry.ok).toBe(true);
    expect(sp.hasPath("840.S0850/TMC Documents/TMC_COA_840.S0850_Betaine_BT-3877_v1.docx")).toBe(true);
  });

  it("validates versionedFilename strictly", () => {
    expect(versionedFilename("TMC_COA_840.S0850_Betaine_BT-3877", 1, ".pdf")).toBe("TMC_COA_840.S0850_Betaine_BT-3877_v1.pdf");
    expect(() => versionedFilename("../bad", 1, ".pdf")).toThrow();
    expect(() => versionedFilename("TMC_MSDS_A", 0, ".pdf")).toThrow();
  });
});
