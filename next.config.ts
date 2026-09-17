import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    /**
     * Stimulus uploads are multipart POSTs to /api/media, and the runtime treats any multipart POST as a possible
     * progressive Server Action, so this limit is applied before the route handler ever runs. At its 1 MB default
     * every video was refused with a bare `413 Payload Too Large` that never reached our code.
     *
     * 100 MB is the Cloudflare Workers request body ceiling on the lower plans, so it is the largest figure that is
     * honest in production as well as locally. Normalized 720p stimuli run 30-60 MB.
     */
    serverActions: { bodySizeLimit: "100mb" },
  },
};

export default nextConfig;
