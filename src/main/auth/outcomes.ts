/**
 * Structured Auth Script + Checkpoint outcomes.
 * Checkpoint (session signal) remains authoritative for login success.
 */

export type AuthPipelineCode =
  | "NO_TAG_CONTEXT"
  | "NO_AUTH_CONFIGURED"
  | "NO_ACCOUNT_TAG_ENTITLEMENT"
  | "CLIENT_LEASE_INVALID"
  | "AUTH_RELEASE_UNAVAILABLE"
  | "AUTH_DOWNLOAD_FAILED"
  | "AUTH_INTEGRITY_FAILED"
  | "AUTH_EXECUTION_FAILED"
  | "AUTH_TIMEOUT"
  | "CHECKPOINT_FAILED"
  | "CHECKPOINT_PASSED"
  | "UNKNOWN";

export type AuthPhase =
  | "skipped"
  | "resolve"
  | "pull"
  | "execute"
  | "checkpoint";

export interface AuthPipelineResult {
  code: AuthPipelineCode;
  phase: AuthPhase;
  /** Auth script finished without throwing — NOT login success. */
  authExecutionOk: boolean;
  /** Session-signal Checkpoint is the only login authority. */
  checkpointStatus: "present" | "absent" | "unsupported" | "error" | "unknown" | "skipped";
  message: string;
  packageKey?: string;
  releaseId?: number;
  version?: string;
  contentDigest?: string;
  actionTagId?: number;
  actionTagKey?: string;
  /** Server/error code when mapped from HTTP. */
  serverError?: string;
}

export function isAuthorizationFailure(code: AuthPipelineCode): boolean {
  return (
    code === "NO_ACCOUNT_TAG_ENTITLEMENT" ||
    code === "CLIENT_LEASE_INVALID"
  );
}

export function mapServerErrorToCode(serverError: string | undefined, status?: number): AuthPipelineCode {
  const err = (serverError || "").trim();
  if (
    status === 409 ||
    status === 401 ||
    err === "CLIENT_KEY_IN_USE" ||
    err === "connection_token_required" ||
    err === "unauthenticated" ||
    err === "unauthorized"
  ) {
    return "CLIENT_LEASE_INVALID";
  }
  if (err === "account_tag_unauthorized" || err === "installation_forbidden") {
    return "NO_ACCOUNT_TAG_ENTITLEMENT";
  }
  if (err === "auth_pin_missing" || err === "auth_pin_target_missing") {
    return "NO_AUTH_CONFIGURED";
  }
  if (
    err === "auth_release_not_found" ||
    err === "auth_release_not_published" ||
    err === "auth_script_not_found" ||
    err === "auth_script_not_authentication" ||
    err === "auth_script_disabled" ||
    err === "auth_release_package_mismatch" ||
    err === "auth_pin_mismatch" ||
    err === "auth_pin_invalid" ||
    err === "action_tag_not_found" ||
    err === "account_not_found" ||
    err === "auth_schema_unavailable" ||
    err === "account_and_tag_required"
  ) {
    return "AUTH_RELEASE_UNAVAILABLE";
  }
  if (status === 403) return "NO_ACCOUNT_TAG_ENTITLEMENT";
  if (status === 404) return "AUTH_RELEASE_UNAVAILABLE";
  return "UNKNOWN";
}
