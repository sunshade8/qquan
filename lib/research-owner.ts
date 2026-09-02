export const RESEARCH_COOKIE_NAME = "qquant_research_device";

export function researchOwnerFrom(request: Request) {
  const match = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${RESEARCH_COOKIE_NAME}=([^;]+)`));
  const existing = match?.[1];
  return existing && /^[a-f0-9-]{36}$/i.test(existing) ? existing : crypto.randomUUID();
}

export function researchOwnerCookie(ownerId: string) {
  return `${RESEARCH_COOKIE_NAME}=${ownerId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`;
}
