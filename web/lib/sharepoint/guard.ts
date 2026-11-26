// Shared security & resource guards for SharePoint and server-upload routes (SEC-02, SEC-08):
//   - CSRF same-origin verification
//   - per-user sliding-window rate limiter
//   - global concurrency semaphore for large transfers
//   - bounded, timed stream reader with early magic-byte validation and zero-copy final buffer
import "server-only";

export const DEFAULT_TRANSFER_TIMEOUT_MS = 120_000;
export const MAX_CONCURRENT_TRANSFERS = 3;

/**
 * CSRF defense-in-depth for cookie-authenticated POST routes (SEC-08).
 * Rejects cross-site/same-site requests via Sec-Fetch-Site and verifies Origin matches request host.
 */
export function checkSameOrigin(req: Request): boolean {
  const fetchSite = (req.headers.get("sec-fetch-site") ?? "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = (req.headers.get("origin") ?? "").trim();
  if (!origin) return true; // non-browser callers or tests without Origin; browsers always send Origin on POST
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  const fwdHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = fwdHost || req.headers.get("host")?.trim();
  if (host) {
    const fwdProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    let reqProto: string;
    try {
      reqProto = fwdProto ? `${fwdProto}:` : new URL(req.url).protocol;
    } catch {
      reqProto = "https:";
    }
    return originUrl.host.toLowerCase() === host.toLowerCase() && originUrl.protocol === reqProto;
  }

  try {
    return originUrl.origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

type Window = Map<string, { start: number; count: number }>;
const rateBuckets = new Map<string, Window>();

/** Per-user 1-minute rate limiter. Returns Retry-After seconds when limited, otherwise null. */
export function takeUserRate(bucket: string, userKey: string, maxPerMin: number, now = Date.now()): number | null {
  let w = rateBuckets.get(bucket);
  if (!w) {
    w = new Map();
    rateBuckets.set(bucket, w);
  }
  const key = userKey.trim().toLowerCase();
  const entry = w.get(key);
  if (!entry || now - entry.start >= 60_000) {
    if (w.size >= 1000) w.clear();
    w.set(key, { start: now, count: 1 });
    return null;
  }
  if (entry.count >= maxPerMin) {
    return Math.max(1, Math.ceil((entry.start + 60_000 - now) / 1000));
  }
  entry.count++;
  return null;
}

let activeTransfers = 0;

/** Acquires one large-transfer slot (max MAX_CONCURRENT_TRANSFERS in flight) to prevent OOM (SEC-02). */
export function acquireTransferSlot(max = MAX_CONCURRENT_TRANSFERS): (() => void) | null {
  if (activeTransfers >= max) return null;
  activeTransfers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeTransfers = Math.max(0, activeTransfers - 1);
  };
}

/** Resets in-memory rate windows and transfer slots (used in unit tests). */
export function resetTransferGuards() {
  rateBuckets.clear();
  activeTransfers = 0;
}

export type SafeReadResult =
  | { ok: true; bytes: Uint8Array; detectedType: string | null }
  | { ok: false; reason: "empty" | "too_large" | "invalid_type" | "timeout" };

/**
 * Reads a Web ReadableStream with:
 *   - hard byte cap (`maxBytes`)
 *   - wall-clock timeout (`timeoutMs`) against Slowloris streams
 *   - early magic-byte validation on the first 8 bytes (aborts immediately without buffering 100 MB)
 *   - zero-copy final Uint8Array view over Buffer.concat (eliminates 3x memory amplification, SEC-02)
 */
export async function readStreamSafe(
  stream: ReadableStream<Uint8Array>,
  opts: {
    maxBytes: number;
    timeoutMs?: number;
    validateHead?: (head: Uint8Array) => string | null;
  },
): Promise<SafeReadResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let headChecked = false;
  let detectedType: string | null = null;
  const headBuf = new Uint8Array(8);
  let headLen = 0;

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "timeout" };
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<"__timeout__">((resolve) => {
          timer = setTimeout(() => resolve("__timeout__"), remaining);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });

      if (next === "__timeout__") {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "timeout" };
      }
      if (next.done) break;
      const value = next.value;
      if (!value || value.byteLength === 0) continue;

      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }

      if (opts.validateHead && !headChecked) {
        const take = Math.min(8 - headLen, value.byteLength);
        headBuf.set(value.subarray(0, take), headLen);
        headLen += take;
        if (headLen >= 8) {
          detectedType = opts.validateHead(headBuf);
          headChecked = true;
          if (!detectedType) {
            await reader.cancel().catch(() => {});
            return { ok: false, reason: "invalid_type" };
          }
        }
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return { ok: false, reason: "empty" };
  if (opts.validateHead && !headChecked) {
    detectedType = opts.validateHead(headBuf.subarray(0, headLen));
    if (!detectedType) return { ok: false, reason: "invalid_type" };
  }

  const buf = Buffer.concat(chunks, total);
  return { ok: true, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), detectedType };
}
