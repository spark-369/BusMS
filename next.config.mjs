/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle at `.next/standalone` that includes
  // only the files actually needed at runtime. This is what makes the Docker
  // image small (no full node_modules copy) and is why the Dockerfile can run
  // `node server.js` instead of `next start`.
  output: "standalone",
  // Prisma and bcryptjs must be resolved at runtime (not bundled) so the
  // correct native query-engine binary is used on Vercel's serverless runtime.
  // ioredis/bullmq are Node-only (raw sockets, Lua scripts, worker threads) and
  // must likewise stay external — bundling them breaks the Redis client.
  experimental: {
    serverComponentsExternalPackages: [
      "@prisma/client",
      "bcryptjs",
      "ioredis",
      "bullmq",
    ],

    // Disable the client-side Router Cache. Without this, client-side
    // navigation between dashboard tabs could serve a cached segment and show
    // stale data until a full page refresh. Setting both to 0 forces every
    // navigation to re-fetch, so each tab always loads fresh data.
    staleTimes: {
      dynamic: 0,
      static: 0,
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.tile.openstreetmap.org",
      },
    ],
  },
  // Avoid bundling Node-only built-ins into the browser bundle.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };
    }
    return config;
  },
};

export default nextConfig;
