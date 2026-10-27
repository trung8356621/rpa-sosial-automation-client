import type { SessionSignal } from "../../shared/contracts.js";

export interface CookieMetadata {
  name: string;
}

export type SessionStrategy = "facebook" | "wordpress" | "unsupported";

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

export function evaluateSessionCookies(strategy: SessionStrategy, cookies: CookieMetadata[], checkedAt: string): SessionSignal {
  if (strategy === "unsupported") {
    return { status: "unsupported", checkedAt, method: null };
  }
  const present = strategy === "facebook"
    ? cookies.some((cookie) => cookie.name === "c_user")
    : cookies.some((cookie) => cookie.name.startsWith("wordpress_logged_in_") || cookie.name.startsWith("wordpress_sec_"));
  return {
    status: present ? "present" : "absent",
    checkedAt,
    method: strategy === "facebook" ? "facebook_c_user_cookie" : "wordpress_auth_cookie",
  };
}
