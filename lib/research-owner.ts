export const RESEARCH_COOKIE_NAME = "qquant_research_device";

export function researchOwnerFrom(request: Request) {
  const match = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${RESEARCH_COOKIE_NAME}=([^;]+)`));
  const existing = match?.[1];
  return existing && /^[a-f0-9-]{36}$/i.test(existing) ? existing : crypto.randomUUID();
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
