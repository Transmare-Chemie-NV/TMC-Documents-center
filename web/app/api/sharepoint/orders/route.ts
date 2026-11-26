// Authenticated SharePoint order folder browser / search for the Neutralise screen.
// Zero business logic here: delegates to lib/sharepoint/orders.ts, with per-user rate limiting (SEC-08)
// and sanitized configuration error handling (SEC-06).
import { apiUser } from "@/lib/auth";
import {
  browseSharePointOrders,
  getSharePoint,
  SharePointConfigError,
  SharePointError,
  SharePointOrderError,
  takeUserRate,
} from "@/lib/sharepoint";

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const MAX_BROWSE_PER_MINUTE = 60;

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return Response.json({ error: "not logged in" }, { status: 401, headers: NO_STORE });

  const wait = takeUserRate("sp-orders", user.email, MAX_BROWSE_PER_MINUTE);
  if (wait !== null) {
    return Response.json({ error: "too many SharePoint requests; try again shortly" }, {
      status: 429,
      headers: { ...NO_STORE, "retry-after": String(wait) },
    });
  }

  let sp: ReturnType<typeof getSharePoint>;
  try {
    sp = getSharePoint();
  } catch (err) {
    console.error("sharepoint config error:", err instanceof Error ? err.name : typeof err);
    return Response.json({ error: "SharePoint configuration error. Contact the administrator." }, { status: 503, headers: NO_STORE });
  }
  if (!sp) return Response.json({ error: "SharePoint is not configured" }, { status: 404, headers: NO_STORE });

  const url = new URL(request.url);
  const folderId = url.searchParams.get("folderId") ?? undefined;
  const query = url.searchParams.get("q") ?? undefined;

  try {
    const result = await browseSharePointOrders(sp.client, sp.cfg, { folderId, query });
    return Response.json(result, { status: 200, headers: NO_STORE });
  } catch (err) {
    if (err instanceof SharePointOrderError) {
      return Response.json({ error: err.message }, { status: 400, headers: NO_STORE });
    }
    if (err instanceof SharePointConfigError) {
      console.error("sharepoint config error:", err.name);
      return Response.json({ error: "SharePoint configuration error. Contact the administrator." }, { status: 503, headers: NO_STORE });
    }
    if (err instanceof SharePointError) {
      return Response.json({ error: "Could not read SharePoint right now. Try again." }, { status: 502, headers: NO_STORE });
    }
    console.error("sharepoint orders route failed:", err instanceof Error ? err.name : typeof err);
    return Response.json({ error: "Could not read SharePoint right now." }, { status: 502, headers: NO_STORE });
  }
}
