import type { NextConfig } from "next";

// Production CSP (review F4, L2, SEC-07): restricts script, object, form, frame, base and network
// destinations so browser-side pages (including the document editor) cannot exfiltrate documents.
// On Azure (Azure Blob Storage or SharePoint), all uploads go to /api/upload-file ('self').
const CSP =
  process.env.NODE_ENV === "production"
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
        "connect-src 'self'",
      ].join("; ")
    : "frame-ancestors 'self'";

// Cache Components is off on purpose: every page here is per-user (login cookie),
// so there is nothing to prerender.
const nextConfig: NextConfig = {
  // Enabled when building web/Dockerfile for Azure Container Apps.
  ...(process.env.NEXT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  // PGlite (laptop database) ships WebAssembly; pg uses optional native bindings.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // SAMEORIGIN: the document page shows its own PDFs in a frame; other sites cannot frame us.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
