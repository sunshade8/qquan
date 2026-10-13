import { env } from "cloudflare:workers";

export const RESEARCH_COOKIE_NAME = "qquant_research_device";
const UUID = /^[a-f0-9-]{36}$/i;

/**
 * Single-owner installs set QQUAN_OWNER_ID so every browser (Safari, Chrome, another
 * host/port) sees the same research, strategies and ledgers. A per-browser cookie
 * otherwise becomes the identity, and switching browsers hides earlier work.
 */
export function configuredResearchOwner() {
  const value = ((env as unknown as Record<string, string | undefined>).QQUAN_OWNER_ID ?? process.env.QQUAN_OWNER_ID)?.trim();
  return value && UUID.test(value) ? value : null;
}

export function researchOwnerFrom(request: Request) {
  const configured = configuredResearchOwner();
  if (configured) return configured;
  const match = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${RESEARCH_COOKIE_NAME}=([^;]+)`));
  const existing = match?.[1];
  return existing && UUID.test(existing) ? existing : crypto.randomUUID();
}

/**
 * Pass the request so a plain-http local app (`http://127.0.0.1:3000`) does not
 * get a `Secure` cookie: browsers that refuse it drop it, every poll then gets
 * a fresh owner, and the screen never sees the job it just started.
 */
export function researchOwnerCookie(ownerId: string, request?: Request) {
  const secure = !request || new URL(request.url).protocol === "https:";
  return `${RESEARCH_COOKIE_NAME}=${ownerId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
