export type AuthStatusTone = "info" | "warning" | "error";

export interface AuthStatusDisplay {
  label:
    | "No Site/Account context"
    | "Auth Script resolved"
    | "Authentication not required"
    | "Auth Script missing"
    | "Auth execution blocked";
  tone: AuthStatusTone;
  detail: string;
}

const BLOCKED_CODES = new Set([
  "CLIENT_LEASE_INVALID",
  "NO_ACCOUNT_TAG_ENTITLEMENT",
  "AUTH_CONTEXT_AMBIGUOUS",
  "AUTH_CONTEXT_UNAVAILABLE",
  "AUTH_DOWNLOAD_FAILED",
  "AUTH_INTEGRITY_FAILED",
  "AUTH_EXECUTION_FAILED",
  "AUTH_NAVIGATION_FAILED",
  "AUTH_TIMEOUT",
  "AUTH_RETRY_FORBIDDEN",
  "AUTH_CANCELLED",
  "ORC_RUNTIME_UNAVAILABLE",
  "ASSET_DOWNLOAD_UNAVAILABLE",
  "ASSET_INTEGRITY_FAILED",
  "ASSET_MISSING",
  "VIEWPORT_MISMATCH",
  "HUMAN_REQUIRED",
  "SESSION_UNKNOWN",
  "CHECKPOINT_FAILED",
  "UNKNOWN",
]);

export function formatAuthStatusDisplay(
  code?: string | null,
  resolutionSource?: string | null,
  message?: string | null
): AuthStatusDisplay | null {
  if (!code) return null;
  const scope =
    resolutionSource === "cms_global"
      ? " (CMS Global)"
      : resolutionSource === "site_specific"
        ? " (Site-specific)"
        : resolutionSource === "account_pin"
          ? " (Account Pin)"
          : "";

  if (code === "NO_TAG_CONTEXT") {
    return {
      label: "No Site/Account context",
      tone: "warning",
      detail: message || "No Site/Account context — manual login required.",
    };
  }
  if (code === "AUTH_NOT_REQUIRED" || code === "SESSION_VALID") {
    return {
      label: "Authentication not required",
      tone: "info",
      detail: message || "Session valid / Authentication not required.",
    };
  }
  if (code === "CHECKPOINT_PASSED") {
    return {
      label: "Auth Script resolved",
      tone: "info",
      detail: `${message || "Authenticated"}${scope}`,
    };
  }
  if (code === "NO_AUTH_CONFIGURED" || code === "AUTH_RELEASE_UNAVAILABLE") {
    return {
      label: "Auth Script missing",
      tone: "warning",
      detail: message || "No Auth Script configured for this Site/CMS.",
    };
  }
  if (BLOCKED_CODES.has(code)) {
    return {
      label: "Auth execution blocked",
      tone: "error",
      detail: `${message || code}${scope}`,
    };
  }
  return {
    label: "Auth execution blocked",
    tone: "warning",
    detail: message || code,
  };
}

/**
 * Only critical authentication errors requiring operator intervention
 * should be surfaced as a banner in the Browser workspace.
 */
export function shouldDisplayAuthStatusInBrowserWorkspace(
  display: AuthStatusDisplay | null
): boolean {
  return Boolean(display && display.tone === "error");
}
