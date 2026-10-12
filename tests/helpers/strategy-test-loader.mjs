import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = new URL("../../", import.meta.url);
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "./local-market-data.ts" &&
    (context.parentURL?.endsWith("/lib/slot-research-store.ts") ||
      context.parentURL?.endsWith("/lib/strategy-generation-store.ts"))
  )
    return {
      url: new URL("slot-test-local-data.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  if (
    specifier === "./local-market-data.ts" &&
    context.parentURL?.endsWith("/lib/strategy-discovery-data.ts")
  )
    return {
      url: new URL("strategy-test-local-data.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  if (
    specifier === "./surge-bars.ts" &&
    /lib\/surge-(store|generation)\.ts$/.test(context.parentURL ?? "")
  )
    return {
      url: new URL("surge-test-bars.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  if (specifier === "cloudflare:workers")
    return {
      url: "data:text/javascript,export const env = globalThis.__strategyTestEnv;",
      shortCircuit: true,
    };
  if (specifier === "@/lib/strategy-generation-llm")
    return {
      url: new URL("strategy-test-llm.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  if (specifier === "@/lib/relay-data")
    return {
      url: new URL("strategy-test-data.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  if (specifier.startsWith("@/")) {
    const path = fileURLToPath(new URL(specifier.slice(2), root));
    const file = existsSync(path + ".ts") ? path + ".ts" : path + "/index.ts";
    return nextResolve(pathToFileURL(file).href, context);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // Repo modules such as db/index.ts import siblings without an extension, which Vite resolves and Node does not.
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      specifier.startsWith(".") &&
      context.parentURL?.startsWith(root.href)
    )
      return nextResolve(specifier + ".ts", context);
    throw error;
  }
}
