import type { SessionSignal } from "../../shared/contracts.js";

export interface CookieMetadata {
  name: string;
  domain?: string;
  path?: string;
  session?: boolean;
  httpOnly?: boolean;
}

export type SessionStrategy = "facebook" | "wordpress" | "unsupported";

export type WordPressDomEvidence = {
  hasAdminBar: boolean;
  hasWpBody: boolean;
  bodyHasWpAdmin: boolean;
};

export function resolveSessionStrategy(url: string, configuredSiteUrl?: string | null): SessionStrategy {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (host === "facebook.com" || host.endsWith(".facebook.com")) return "facebook";

  const path = parsed.pathname.toLowerCase();
  if (path.includes("/wp-admin") || path.includes("/wp-login.php")) return "wordpress";

  if (configuredSiteUrl) {
    try {
      const configured = new URL(configuredSiteUrl);
      if (configured.hostname.toLowerCase() === host && path.startsWith(configured.pathname.replace(/\/$/, "") || "/")) {
        return "wordpress";
      }
    } catch {
      // Invalid configured URL cannot select a strategy.
    }
  }
  return "unsupported";
}

export function isWordPressAuthCookieName(name: string): boolean {
  return name.startsWith("wordpress_logged_in_") || name.startsWith("wordpress_sec_");
}

/** Cookie domain match — Electron may return leading-dot domains. */
export function cookieBelongsToHost(cookieDomain: string | undefined, hostname: string): boolean {
  if (!cookieDomain) return true;
  const host = hostname.toLowerCase().replace(/^\./, "");
  const dom = cookieDomain.toLowerCase().replace(/^\./, "");
  return host === dom || host.endsWith(`.${dom}`);
}

export function isWordPressAdminUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    // Logged-in admin surface — not the login form.
    return path.includes("/wp-admin") && !path.includes("/wp-login.php");
  } catch {
    return false;
  }
}

export function isWordPressLoginUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().includes("/wp-login.php");
  } catch {
    return false;
  }
}

/**
 * Prefer a stable admin entry over a reauth login URL so reopen does not
 * force WordPress to clear an otherwise-valid session.
 */
export function resolveBrowserOpenUrl(params: {
  initialUrl?: string | null;
  lastUrl?: string | null;
  siteUrl?: string | null;
  platform?: string | null;
  fallback: (platform: string, siteUrl?: string | null) => string;
}): string {
  const candidate = params.initialUrl || params.lastUrl || "";
  if (candidate && isWordPressLoginUrl(candidate) && params.siteUrl) {
    try {
      const site = new URL(params.siteUrl);
      const base = site.href.replace(/\/$/, "");
      return `${base}/wp-admin/`;
    } catch {
      // fall through
    }
  }
  if (candidate) return candidate;
  return params.fallback(params.platform || "wordpress", params.siteUrl);
}

export function evaluateSessionCookies(
  strategy: SessionStrategy,
  cookies: CookieMetadata[],
  checkedAt: string
): SessionSignal {
  if (strategy === "unsupported") {
    return { status: "unsupported", checkedAt, method: null };
  }
  const present =
    strategy === "facebook"
      ? cookies.some((cookie) => cookie.name === "c_user")
      : cookies.some((cookie) => isWordPressAuthCookieName(cookie.name));
  return {
    status: present ? "present" : "absent",
    checkedAt,
    method: strategy === "facebook" ? "facebook_c_user_cookie" : "wordpress_auth_cookie",
  };
}

/**
 * WordPress POC checkpoint: auth cookies OR (admin URL + authenticated DOM).
 * Never invents a logged_in client flag — only live browser evidence.
 */
export function evaluateWordPressSession(params: {
  cookies: CookieMetadata[];
  pageUrl: string;
  dom?: WordPressDomEvidence | null;
  checkedAt: string;
}): SessionSignal {
  const cookiePresent = params.cookies.some((c) => isWordPressAuthCookieName(c.name));
  if (cookiePresent) {
    return {
      status: "present",
      checkedAt: params.checkedAt,
      method: "wordpress_auth_cookie",
    };
  }

  const adminUrl = isWordPressAdminUrl(params.pageUrl);
  const domOk = Boolean(
    params.dom && (params.dom.hasAdminBar || params.dom.hasWpBody || params.dom.bodyHasWpAdmin)
  );
  if (adminUrl && domOk) {
    return {
      status: "present",
      checkedAt: params.checkedAt,
      method: "wordpress_admin_dom",
    };
  }

  return {
    status: "absent",
    checkedAt: params.checkedAt,
    method: "wordpress_auth_cookie",
  };
}
