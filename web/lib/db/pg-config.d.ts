export function pgPoolConfig(
  rawUrl: string,
  env?: Record<string, string | undefined>,
): { connectionString: string; ssl: false | { rejectUnauthorized: true }; connectionTimeoutMillis: number };
