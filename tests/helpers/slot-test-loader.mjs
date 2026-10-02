import { resolve as baseResolve } from "./strategy-test-loader.mjs";
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/relay-data")
    return nextResolve(new URL("../../lib/relay-data.ts", import.meta.url).href, context);
  return baseResolve(specifier, context, nextResolve);
}
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
export async function load(url, context, nextLoad) {
  if (url.endsWith("/lib/market-data.ts"))
    return {
      format: "module",
      source: stripTypeScriptTypes(await readFile(new URL(url), "utf8"), {
        mode: "transform",
      }),
      shortCircuit: true,
    };
  return nextLoad(url, context);
}
