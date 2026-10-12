import { loadEnvFile } from "node:process";
try {
  if (process.env.QQUAN_SKIP_ENV_FILE !== "1") loadEnvFile(".dev.vars");
} catch {
  // Optional local environment file; credentials are never required for SQLite.
}
import { LocalDatabase } from "./local-sqlite.ts";
const database = new LocalDatabase();
export const env = new Proxy({} as Record<string, unknown>, {
  get: (_target, key) => (key === "DB" ? database : process.env[String(key)]),
});
export function waitUntil(work: Promise<unknown>) {
  void work.catch((error) =>
    console.error("Background work failed:", error.message),
  );
}
