import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb, type Db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { acquireTransferSlot, resetTransferGuards, type DriveItem, type SharePointClient, type SharePointConfig } from "@/lib/sharepoint";
import type { Storage } from "@/lib/storage";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

let currentUser: { email: string; name: string; role: "admin" | "user" } | null = null;
let spState: { cfg: SharePointConfig; client: SharePointClient } | null = null;
let storageMock: Storage;
let db: Db;

vi.mock("@/lib/auth", () => ({ apiUser: async () => currentUser }));
vi.mock("@/lib/db", async (orig) => {
  const actual = await orig<typeof import("@/lib/db")>();
  return { ...actual, getDb: async () => db };
});
vi.mock("@/lib/storage", () => ({ getStorage: () => storageMock }));
vi.mock("@/lib/sharepoint", async (orig) => {
  const actual = await orig<typeof import("@/lib/sharepoint")>();
  return { ...actual, getSharePoint: () => spState };
});

import { POST as importPost } from "./import/route";
import { GET as ordersGet } from "./orders/route";
import { POST as uploadFilePost } from "../upload-file/route";

const CFG: SharePointConfig = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  clientSecret: "secret-value",
  siteId: null,
  driveId: "b!drive-1234567890",
  tenantHost: null,
  storageFolder: "_app-storage",
  ordersRoot: "",
  outputSubfolder: "",
  generalFolder: "General",
};

const ORDER_FILE: DriveItem = {
  id: "file-1",
  name: "coa.pdf",
  size: PDF.length,
  isFolder: false,
  mimeType: "application/pdf",
  webUrl: "https://transmare.sharepoint.com/teams/TMCDOCUMENTCENTER/Shared%20Documents/840.S0850/coa.pdf",
  parentId: "dir-1",
  parentPath: "840.S0850",
  hasTrustedParent: true,
  modifiedAt: "2026-11-26T10:00:00Z",
};

function makeClient(): SharePointClient {
  return {
    getItemById: async (id) => (id === "file-1" ? ORDER_FILE : null),
    getItemByPath: async () => null,
    listChildren: async () => [ORDER_FILE],
    searchItems: async () => [ORDER_FILE],
    downloadById: async (id) =>
      id === "file-1"
        ? {
            stream: new ReadableStream({
              start(c) {
                c.enqueue(PDF);
                c.close();
              },
            }),
            size: PDF.length,
            contentType: "application/pdf",
          }
        : null,
    downloadByPath: async () => null,
    headByPath: async () => null,
    uploadFile: async () => ORDER_FILE,
    ensureFolder: async () => ORDER_FILE,
  };
}

beforeEach(async () => {
  resetTransferGuards();
  db = await createPgliteDb();
  currentUser = { email: "wilman@transmare.com", name: "Willem", role: "admin" };
  spState = { cfg: CFG, client: makeClient() };
  const stored = new Map<string, Uint8Array>();
  storageMock = {
    mode: "sharepoint",
    get: async (k) => {
      const b = stored.get(k);
      if (!b) return null;
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue(b);
            c.close();
          },
        }),
        size: b.byteLength,
        contentType: "application/pdf",
      };
    },
    head: async (k, n) => {
      const b = stored.get(k);
      return b ? { bytes: b.subarray(0, n), size: b.byteLength } : null;
    },
    put: async (k, d) => {
      stored.set(k, new Uint8Array(d));
    },
  };
});

describe("SharePoint & server-upload API routes (auth, CSRF, rate/concurrency limits, abuse cases)", () => {
  it("refuses unauthenticated callers with 401 BEFORE revealing storage mode (SEC-10)", async () => {
    currentUser = null;
    storageMock = { ...storageMock, mode: "local" };
    expect((await ordersGet(new Request("http://localhost/api/sharepoint/orders"))).status).toBe(401);
    expect(
      (
        await importPost(
          new Request("http://localhost/api/sharepoint/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ itemId: "file-1" }),
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await uploadFilePost(
          new Request("http://localhost/api/upload-file", {
            method: "POST",
            headers: { "x-upload-kind": "input", "content-length": String(PDF.length) },
            body: PDF,
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("returns 404 when SharePoint is not configured (for authenticated users)", async () => {
    spState = null;
    storageMock = { ...storageMock, mode: "local" };
    expect((await ordersGet(new Request("http://localhost/api/sharepoint/orders"))).status).toBe(404);
    expect(
      (
        await importPost(
          new Request("http://localhost/api/sharepoint/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(404);
    expect((await uploadFilePost(new Request("http://localhost/api/upload-file", { method: "POST", body: PDF }))).status).toBe(404);
  });

  it("enforces CSRF Origin/Sec-Fetch-Site, Content-Type, and rate limits (SEC-08)", async () => {
    const crossSiteImport = await importPost(
      new Request("http://localhost/api/sharepoint/import", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ itemId: "file-1" }),
      }),
    );
    expect(crossSiteImport.status).toBe(403);

    const wrongType = await importPost(
      new Request("http://localhost/api/sharepoint/import", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ itemId: "file-1" }),
      }),
    );
    expect(wrongType.status).toBe(415);

    const crossSiteUpload = await uploadFilePost(
      new Request("http://localhost/api/upload-file", {
        method: "POST",
        headers: { "x-upload-kind": "input", "sec-fetch-site": "cross-site" },
        body: PDF,
      }),
    );
    expect(crossSiteUpload.status).toBe(403);

    // Rate limit on /api/sharepoint/import (15/min)
    for (let i = 0; i < 15; i++) {
      const r = await importPost(
        new Request("http://localhost/api/sharepoint/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemId: "file-1" }),
        }),
      );
      expect(r.status).toBe(200);
    }
    const limited = await importPost(
      new Request("http://localhost/api/sharepoint/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: "file-1" }),
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("lists order folder, rejects traversal folderId, and imports valid PDF", async () => {
    const ok = await ordersGet(new Request("http://localhost/api/sharepoint/orders"));
    expect(ok.status).toBe(200);
    const list = (await ok.json()) as { items: { name: string }[] };
    expect(list.items[0].name).toBe("coa.pdf");

    const bad = await ordersGet(new Request("http://localhost/api/sharepoint/orders?folderId=..%2Fsecret"));
    expect(bad.status).toBe(400);

    const imp = await importPost(
      new Request("http://localhost/api/sharepoint/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: "file-1" }),
      }),
    );
    expect(imp.status).toBe(200);
    const body = (await imp.json()) as { key: string; suggestedFileNr: string };
    expect(body.key).toMatch(/^uploads\/.+\/input$/);
    expect(body.suggestedFileNr).toBe("840.S0850");
  });

  it("enforces slot, size limit, magic bytes, concurrency cap, and audit logging on /api/upload-file (SEC-02)", async () => {
    const badSlot = await uploadFilePost(
      new Request("http://localhost/api/upload-file", {
        method: "POST",
        headers: { "x-upload-kind": "preview", "content-length": String(PDF.length) },
        body: PDF,
      }),
    );
    expect(badSlot.status).toBe(400);

    const badMagic = await uploadFilePost(
      new Request("http://localhost/api/upload-file", {
        method: "POST",
        headers: { "x-upload-kind": "input", "content-length": String(EXE.length) },
        body: EXE,
      }),
    );
    expect(badMagic.status).toBe(415);

    const tooLarge = await uploadFilePost(
      new Request("http://localhost/api/upload-file", {
        method: "POST",
        headers: { "x-upload-kind": "pdf", "content-length": String(30 * 1024 * 1024) },
        body: PDF,
      }),
    );
    expect(tooLarge.status).toBe(413);

    // Concurrency semaphore full -> 503
    const s1 = acquireTransferSlot()!;
    const s2 = acquireTransferSlot()!;
    const s3 = acquireTransferSlot()!;
    const busy = await uploadFilePost(
      new Request("http://localhost/api/upload-file", {
        method: "POST",
        headers: { "x-upload-kind": "input", "content-length": String(PDF.length) },
        body: PDF,
      }),
    );
    expect(busy.status).toBe(503);
    s1();
    s2();
    s3();

    const good = await uploadFilePost(
      new Request("http://localhost/api/upload-file", {
        method: "POST",
        headers: { "x-upload-kind": "input", "content-length": String(PDF.length) },
        body: PDF,
      }),
    );
    expect(good.status).toBe(200);
    const json = (await good.json()) as { key: string };
    expect(json.key).toMatch(/^uploads\/.+\/input$/);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "upload.created"));
    expect(audits).toHaveLength(1);
  });
});
