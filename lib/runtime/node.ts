import { waitUntil as vercelWaitUntil } from "@vercel/functions";
import { D1HttpDatabase } from "./d1-http.ts";
const database = new D1HttpDatabase(() => process.env);
export const env = new Proxy({} as Record<string, unknown>, {
  get: (_target, key) => (key === "DB" ? database : process.env[String(key)]),
});
export function waitUntil(work: Promise<unknown>) {
  vercelWaitUntil(work);
}
