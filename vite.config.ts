import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import hostingConfig from "./.openai/hosting.json";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  if (process.env.QQUAN_RUNTIME !== "cloudflare") {
    // nitro only packages the build output. In dev it takes over the RSC/SSR
    // environment, so vinext's handler fails with "reading 'import'" and every
    // page is served as an empty shell that then fails to hydrate.
    const plugins = [vinext()];
    if (command === "build") {
      const { nitro } = await import("nitro/vite");
      plugins.push(nitro({ vercel: { functions: { maxDuration: 300 } } }));
    }
    return {
      server: { host: "127.0.0.1", port: 3000, strictPort: true },
      resolve: {
        alias: [{ find: "cloudflare:workers", replacement: fileURLToPath(new URL("./lib/runtime/node.ts", import.meta.url)) }],
      },
      plugins,
    };
  }
  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    define: { "process.env.QQUAN_RUNTIME": JSON.stringify("cloudflare") },
    resolve: { alias: [
      { find: "./market-data-rpc.ts", replacement: fileURLToPath(new URL("./lib/hosted-market-data.ts", import.meta.url)) },
      { find: /^.*\/local-data-worker\.ts$/, replacement: fileURLToPath(new URL("./lib/hosted-data-worker.ts", import.meta.url)) },
    ] },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
