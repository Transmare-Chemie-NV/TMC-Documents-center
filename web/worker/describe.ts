/** An error and its causes for the worker log ("Failed query" alone hides why the database
 * refused), with database URLs, Bearer tokens, and env secrets hidden so none reach the log. */
export function describe(err: unknown): string {
  const parts: string[] = [];
  for (let e = err, i = 0; e != null && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    parts.push(e instanceof Error ? e.message : String(e));
  }
  let out = parts.join(" <- ");
  const secrets: [string, string][] = [
    ["ANTHROPIC_API_KEY", "<key>"],
    ["SHAREPOINT_CLIENT_SECRET", "<secret>"],
    ["WORKER_WAKE_SECRET", "<secret>"],
    ["AUTH_SECRET", "<secret>"],
    ["IDENTITY_HEADER", "<secret>"],
  ];
  for (const [envName, label] of secrets) {
    const raw = process.env[envName] ?? "";
    for (const secret of new Set([raw.trim(), raw])) {
      if (secret.length >= 8) out = out.split(secret).join(label);
    }
  }
  return out
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "postgresql://[hidden]")
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer <token>");
}
