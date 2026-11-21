export type AuthNavigationValidation =
  | { ok: true; url: string; origin: string; pathname: string }
  | { ok: false; reason: string };

/**
 * Validate that a server-resolved Auth URL (e.g. execution_context.resolved_url)
 * is HTTP(S), matches the authorized Site origin, and matches expected Auth Path if given.
 */
export function validateAuthNavigationTarget(params: {
  targetUrl: string;
  authorizedSiteUrl?: string | null;
  expectedAuthPath?: string | null;
}): AuthNavigationValidation {
  const raw = params.targetUrl.trim();
  if (!raw) {
    return { ok: false, reason: "Auth target URL rỗng." };
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return { ok: false, reason: `Auth target URL không hợp lệ: ${raw}` };
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, reason: `Chỉ chấp nhận HTTP/HTTPS cho Auth navigation (${target.protocol}).` };
  }

  if (params.authorizedSiteUrl?.trim()) {
    let site: URL;
    try {
      const normalizedSite = /^https?:\/\//i.test(params.authorizedSiteUrl.trim())
        ? params.authorizedSiteUrl.trim()
        : `https://${params.authorizedSiteUrl.trim()}`;
      site = new URL(normalizedSite);
    } catch {
      return { ok: false, reason: "Site URL của Account không hợp lệ." };
    }
    if (target.origin !== site.origin) {
      return {
        ok: false,
        reason: `Auth target origin (${target.origin}) không khớp Site origin được cấp phép (${site.origin}).`,
      };
    }
  }

  if (params.expectedAuthPath?.trim()) {
    const expectedPath = params.expectedAuthPath.trim().startsWith("/")
      ? params.expectedAuthPath.trim()
      : `/${params.expectedAuthPath.trim()}`;
    if (target.pathname !== expectedPath) {
      return {
        ok: false,
        reason: `Auth target path (${target.pathname}) không khớp Auth Path (${expectedPath}).`,
      };
    }
  }

  return {
    ok: true,
    url: target.href,
    origin: target.origin,
    pathname: target.pathname,
  };
}

export function isAtAuthTarget(currentUrl: string | undefined | null, target: { origin: string; pathname: string }): boolean {
  if (!currentUrl) return false;
  try {
    const cur = new URL(currentUrl);
    return cur.origin === target.origin && cur.pathname === target.pathname;
  } catch {
    return false;
  }
}
