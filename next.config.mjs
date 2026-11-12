/** @type {import('next').NextConfig} */

const isProduction = process.env.NODE_ENV === "production";

/**
 * WebSocket/HTTP origins the browser is allowed to open connections to.
 *
 * Real-time media is handled by a LiveKit server whose address is configured
 * per deployment, so the Content-Security-Policy derives the exact origins from
 * the environment instead of opening `connect-src` to the whole internet.
 */
function realtimeOrigins() {
  const sources = [process.env.LIVEKIT_URL, process.env.LIVEKIT_HOST].filter(Boolean);
  const origins = new Set();

  for (const source of sources) {
    try {
      const url = new URL(source);
      origins.add(`${url.protocol}//${url.host}`);
      origins.add(`${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`);
    } catch {
      // Ignore malformed configuration; the request will simply be blocked.
    }
  }

  return [...origins];
}

const connectSrc = ["'self'", ...realtimeOrigins()];
// Some hosts (Render, for one) only expose environment variables to the running
// container, not to the image build. When the LiveKit origin is therefore absent
// here, allow secure realtime transports rather than emitting a policy that
// blocks every socket to the media server. Set LIVEKIT_URL at build time to keep
// connect-src pinned to the exact origin.
if (connectSrc.length === 1) {
  connectSrc.push("https:", "wss:");
}
if (!isProduction) {
  // Next.js routes its dev-mode hot reload over a WebSocket on the app origin.
  connectSrc.push("ws:", "wss:");
}

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js hydrates with inline bootstrap scripts; dev mode also needs eval.
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  `connect-src ${connectSrc.join(" ")}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  {
    key: "Permissions-Policy",
    // The GD room needs the camera and microphone; nothing else is requested.
    value: "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Do not advertise the framework in responses.
  poweredByHeader: false,
  // gzip responses (report JSON and pages benefit most).
  compress: true,
  // pdfkit ships native font files that must be loaded from node_modules at runtime.
  serverExternalPackages: ["pdfkit"],
  eslint: {
    // Linting is run separately (npm run typecheck) so a lint warning never blocks a deploy.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
