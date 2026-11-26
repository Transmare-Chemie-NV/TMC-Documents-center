import { describe, expect, it, vi } from "vitest";
import { newUploadKey } from "../files";
import {
  AzureBlobConfigError,
  AzureBlobConflictError,
  AzureBlobError,
  createAzureBlobStorage,
  readAzureBlobConfig,
  validateIdentityEndpoint,
} from "./azure-blob";
import { resolveStorage } from "./index";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const CLIENT_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("Azure Blob Storage configuration & SSRF guards", () => {
  it("returns null when unset and parses account name, URL, container and client ID", () => {
    expect(readAzureBlobConfig({})).toBeNull();

    expect(
      readAzureBlobConfig({
        AZURE_STORAGE_ACCOUNT: "tmcdoccenterstorage",
        AZURE_STORAGE_CONTAINER: "documents",
        AZURE_CLIENT_ID: CLIENT_UUID,
      }),
    ).toEqual({
      account: "tmcdoccenterstorage",
      container: "documents",
      clientId: CLIENT_UUID,
    });

    expect(
      readAzureBlobConfig({
        AZURE_STORAGE_BLOB_URL: "https://tmcdoccenterstorage.blob.core.windows.net",
      }),
    ).toEqual({
      account: "tmcdoccenterstorage",
      container: "documents",
      clientId: null,
    });

    expect(
      readAzureBlobConfig({
        AZURE_STORAGE_ACCOUNT: "tmcdoccenterstorage",
        AZURE_STORAGE_BLOB_URL: "https://tmcdoccenterstorage.blob.core.windows.net/",
      }),
    ).toEqual({
      account: "tmcdoccenterstorage",
      container: "documents",
      clientId: null,
    });
  });

  it("rejects invalid account names, non-root URLs, SAS URLs, mismatched account+URL, invalid containers, and non-UUID client IDs (L2)", () => {
    expect(() => readAzureBlobConfig({ AZURE_STORAGE_ACCOUNT: "BAD_ACCOUNT!" })).toThrow(AzureBlobConfigError);
    expect(() =>
      readAzureBlobConfig({
        AZURE_STORAGE_BLOB_URL: "https://tmcdoccenterstorage.blob.core.windows.net?sv=2023-11-03&sig=abc",
      }),
    ).toThrow(AzureBlobConfigError);
    expect(() =>
      readAzureBlobConfig({
        AZURE_STORAGE_BLOB_URL: "https://tmcdoccenterstorage.blob.core.windows.net/othercontainer",
      }),
    ).toThrow(AzureBlobConfigError);
    expect(() =>
      readAzureBlobConfig({
        AZURE_STORAGE_ACCOUNT: "tmcdoccenterstorage",
        AZURE_STORAGE_BLOB_URL: "https://otheraccount.blob.core.windows.net",
      }),
    ).toThrow(AzureBlobConfigError);
    expect(() =>
      readAzureBlobConfig({
        AZURE_STORAGE_ACCOUNT: "tmcdoccenterstorage",
        AZURE_STORAGE_BLOB_URL: "https://tmcdoccenterstorage.blob.core.windows.net?sv=2023-11-03&sig=abc",
      }),
    ).toThrow(AzureBlobConfigError);
    expect(() =>
      readAzureBlobConfig({
        AZURE_STORAGE_BLOB_URL: "https://evil.example/tmcdoccenterstorage",
      }),
    ).toThrow(AzureBlobConfigError);
    expect(() =>
      readAzureBlobConfig({
        AZURE_STORAGE_ACCOUNT: "tmcdoccenterstorage",
        AZURE_STORAGE_CONTAINER: "bad--name",
      }),
    ).toThrow(AzureBlobConfigError);
    expect(() =>
      readAzureBlobConfig({
        AZURE_STORAGE_ACCOUNT: "tmcdoccenterstorage",
        AZURE_CLIENT_ID: "not-a-uuid",
      }),
    ).toThrow(AzureBlobConfigError);

    expect(new AzureBlobConfigError("x").name).toBe("AzureBlobConfigError");
    expect(new AzureBlobError("x").name).toBe("AzureBlobError");
    expect(new AzureBlobConflictError().name).toBe("AzureBlobConflictError");
  });

  it("blocks external hosts, IMDS, query/hash in IDENTITY_ENDPOINT and allows loopback only (L2)", () => {
    expect(validateIdentityEndpoint("http://localhost:42356/msi/token").hostname).toBe("localhost");
    expect(validateIdentityEndpoint("http://127.0.0.1:42356/msi/token").hostname).toBe("127.0.0.1");
    expect(validateIdentityEndpoint("http://[::1]:42356/msi/token").hostname).toBe("[::1]");

    expect(() => validateIdentityEndpoint("http://169.254.169.254/metadata/identity/oauth2/token")).toThrow(AzureBlobError);
    expect(() => validateIdentityEndpoint("http://127.0.0.1:42356/msi/token?resource=evil")).toThrow(AzureBlobError);
    expect(() => validateIdentityEndpoint("http://127.0.0.1:42356/msi/token#frag")).toThrow(AzureBlobError);
    expect(() => validateIdentityEndpoint("https://evil.example/token")).toThrow(AzureBlobError);
    expect(() => validateIdentityEndpoint("http://user:pass@127.0.0.1/token")).toThrow(AzureBlobError);
    expect(() => validateIdentityEndpoint("file:///etc/passwd")).toThrow(AzureBlobError);
  });
});

describe("createAzureBlobStorage (Managed Identity, zero-copy Buffer PUT, concurrent 401 refresh, short TTL)", () => {
  it("uses ACA IDENTITY_ENDPOINT + X-IDENTITY-HEADER + client_id, sends x-ms-date & Buffer body, caches token, and enforces If-None-Match: *", async () => {
    const calls: { url: string; method: string; headers: Headers }[] = [];
    const stored = new Map<string, { body: Uint8Array; contentType: string }>();

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({ url, method, headers });

      if (url.startsWith("http://localhost:42356/msi/token")) {
        expect(headers.get("x-identity-header")).toBe("sidecar-secret");
        expect(url).toContain("resource=https%3A%2F%2Fstorage.azure.com%2F");
        expect(url).toContain(`client_id=${CLIENT_UUID}`);
        return Response.json({ access_token: "tok-1", expires_in: 3600 });
      }

      expect(headers.get("authorization")).toBe("Bearer tok-1");
      expect(headers.get("x-ms-version")).toBe("2023-11-03");
      expect(headers.get("x-ms-date")).toMatch(/GMT$/);

      if (method === "PUT") {
        // H1: zero-copy Buffer body (not Blob copy)
        expect(Buffer.isBuffer(init?.body)).toBe(true);
        expect(headers.get("x-ms-blob-type")).toBe("BlockBlob");
        expect(headers.get("if-none-match")).toBe("*");
        if (stored.has(url)) return new Response("BlobAlreadyExists", { status: 409 });
        const buf = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        stored.set(url, { body: buf, contentType: headers.get("content-type") ?? "application/octet-stream" });
        return new Response(null, { status: 201 });
      }
      if (method === "HEAD") {
        const entry = stored.get(url);
        if (!entry) return new Response(null, { status: 404 });
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(entry.body.byteLength), "content-type": entry.contentType },
        });
      }
      if (method === "GET") {
        const entry = stored.get(url);
        if (!entry) return new Response(null, { status: 404 });
        const range = headers.get("x-ms-range");
        if (range) {
          const m = /^bytes=0-(\d+)$/.exec(range);
          const end = m ? Number(m[1]) + 1 : entry.body.byteLength;
          return new Response(Buffer.from(entry.body.subarray(0, end)), { status: 206 });
        }
        return new Response(Buffer.from(entry.body), {
          status: 200,
          headers: { "content-length": String(entry.body.byteLength), "content-type": entry.contentType },
        });
      }
      return new Response(null, { status: 405 });
    });

    const storage = createAzureBlobStorage(
      { account: "tmcdoccenterstorage", container: "documents", clientId: CLIENT_UUID },
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        env: { IDENTITY_ENDPOINT: "http://localhost:42356/msi/token", IDENTITY_HEADER: "sidecar-secret" },
      },
    );
    expect(storage.mode).toBe("azure-blob");

    const key = newUploadKey("input");
    await storage.put(key, PDF, "application/pdf");

    // Hard Rule 4: duplicate PUT must fail with AzureBlobConflictError
    await expect(storage.put(key, PDF, "application/pdf")).rejects.toThrow(AzureBlobConflictError);

    // head() reads first 5 bytes via x-ms-range
    const head = await storage.head(key, 5);
    expect(head?.size).toBe(PDF.byteLength);
    expect(Array.from(head!.bytes)).toEqual(Array.from(PDF.subarray(0, 5)));

    // get() streams full blob
    const file = await storage.get(key);
    expect(file?.size).toBe(PDF.byteLength);
    expect(file?.contentType).toBe("application/pdf");
    const downloaded = new Uint8Array(await new Response(file!.stream).arrayBuffer());
    expect(Array.from(downloaded)).toEqual(Array.from(PDF));

    // Missing key returns null
    const missing = newUploadKey("pdf");
    expect(await storage.get(missing)).toBeNull();
    expect(await storage.head(missing, 8)).toBeNull();

    // Token was cached across all blob calls (only 1 token call)
    expect(calls.filter((c) => c.url.includes("/msi/token"))).toHaveLength(1);
  });

  it("coalesces concurrent 401 refreshes so parallel in-flight requests both succeed, and skips retry when token unchanged (M1)", async () => {
    let tokenCount = 0;
    let blobCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      if (url.startsWith("http://169.254.169.254/")) {
        expect(headers.get("metadata")).toBe("true");
        tokenCount++;
        return Response.json({ access_token: `imds-tok-${tokenCount}`, expires_in: 3600 });
      }
      blobCalls++;
      if (headers.get("authorization") === "Bearer imds-tok-1") {
        return new Response("Unauthorized", { status: 401 });
      }
      expect(headers.get("authorization")).toBe("Bearer imds-tok-2");
      return new Response(Buffer.from(PDF), { status: 200, headers: { "content-length": String(PDF.byteLength) } });
    });

    const storage = createAzureBlobStorage(
      { account: "tmcdoccenterstorage", container: "documents", clientId: null },
      { fetchImpl: fetchMock as unknown as typeof fetch, env: {} },
    );

    const [a, b] = await Promise.all([storage.get(newUploadKey("input")), storage.get(newUploadKey("input"))]);
    expect(a?.size).toBe(PDF.byteLength);
    expect(b?.size).toBe(PDF.byteLength);
    // Initial fetch (imds-tok-1) + one coalesced refresh (imds-tok-2) = 2 token calls total
    expect(tokenCount).toBe(2);
    expect(blobCalls).toBe(4);

    // If identity sidecar returns the exact same token on 401, do NOT resend the request
    let sameTokBlobCalls = 0;
    const sameTokFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("http://169.254.169.254/")) {
        return Response.json({ access_token: "stuck-tok", expires_in: 3600 });
      }
      sameTokBlobCalls++;
      return new Response("Unauthorized", { status: 401 });
    });
    const stuckStorage = createAzureBlobStorage(
      { account: "tmcdoccenterstorage", container: "documents", clientId: null },
      { fetchImpl: sameTokFetch as unknown as typeof fetch, env: {} },
    );
    await expect(stuckStorage.get(newUploadKey("input"))).rejects.toThrow("HTTP 401");
    expect(sameTokBlobCalls).toBe(1);
  });

  it("does not cache short-lived (< 60s) Managed Identity tokens for 1 hour (L1)", async () => {
    let tokenCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("http://169.254.169.254/")) {
        tokenCount++;
        return Response.json({ access_token: `short-tok-${tokenCount}`, expires_in: 30 });
      }
      return new Response(Buffer.from(PDF), { status: 200, headers: { "content-length": String(PDF.byteLength) } });
    });

    const storage = createAzureBlobStorage(
      { account: "tmcdoccenterstorage", container: "documents", clientId: null },
      { fetchImpl: fetchMock as unknown as typeof fetch, env: {} },
    );

    await storage.get(newUploadKey("input"));
    await storage.get(newUploadKey("input"));
    expect(tokenCount).toBe(2);
  });

  it("fails closed on invalid keys, empty files, control chars, and missing IDENTITY_HEADER", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    const storage = createAzureBlobStorage(
      { account: "tmcdoccenterstorage", container: "documents", clientId: null },
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        env: { IDENTITY_ENDPOINT: "http://localhost:42356/msi/token" },
      },
    );

    await expect(storage.get("../escape")).rejects.toThrow("invalid storage key");
    await expect(storage.put(newUploadKey("input"), new Uint8Array(0), "application/pdf")).rejects.toThrow(
      "cannot upload an empty file",
    );
    await expect(storage.put(newUploadKey("input"), PDF, "application/pdf\r\nX-Injected: 1")).rejects.toThrow(
      "invalid content-type",
    );
    await expect(storage.get(newUploadKey("input"))).rejects.toThrow("IDENTITY_ENDPOINT is set without IDENTITY_HEADER");
  });
});

describe("resolveStorage backend selector (STORAGE_BACKEND)", () => {
  const SP_ENV = {
    SHAREPOINT_TENANT_ID: "11111111-1111-4111-8111-111111111111",
    SHAREPOINT_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
    SHAREPOINT_CLIENT_SECRET: "secret-value",
    SHAREPOINT_DRIVE_ID: "b!drive-1234567890",
  };
  const AZURE_ENV = {
    AZURE_STORAGE_ACCOUNT: "tmcdoccenterstorage",
    AZURE_STORAGE_CONTAINER: "documents",
  };

  it("honors explicit STORAGE_BACKEND and auto-selects SharePoint -> Azure Blob -> local dev", () => {
    expect(resolveStorage({ ...SP_ENV, ...AZURE_ENV, STORAGE_BACKEND: "azure-blob" }).mode).toBe("azure-blob");
    expect(resolveStorage({ ...SP_ENV, ...AZURE_ENV, STORAGE_BACKEND: "sharepoint" }).mode).toBe("sharepoint");
    expect(resolveStorage({ ...SP_ENV, ...AZURE_ENV }).mode).toBe("sharepoint");
    expect(resolveStorage({ ...AZURE_ENV }).mode).toBe("azure-blob");
    expect(resolveStorage({ NODE_ENV: "development" }).mode).toBe("local");
  });

  it("fails closed in production when unconfigured or misconfigured", () => {
    expect(() => resolveStorage({ NODE_ENV: "production" })).toThrow("No file storage configured");
    expect(() => resolveStorage({ NODE_ENV: "production", STORAGE_BACKEND: "local" })).toThrow("not allowed in production");
    expect(() => resolveStorage({ STORAGE_BACKEND: "azure-blob" })).toThrow("AZURE_STORAGE_ACCOUNT is not configured");
    expect(() => resolveStorage({ STORAGE_BACKEND: "sharepoint" })).toThrow("SharePoint env vars are not configured");
    expect(() => resolveStorage({ STORAGE_BACKEND: "vercel" })).toThrow('Unknown STORAGE_BACKEND "vercel"');
  });
});
