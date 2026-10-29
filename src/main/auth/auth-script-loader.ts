import { createHash } from "node:crypto";
import { SeoOpsHttpError } from "../../shared/seo-ops-http.js";
import type { ClientConnection } from "../connection/client-connection.js";
import { mapServerErrorToCode, type AuthPipelineCode } from "./outcomes.js";
import {
  parsePulledRelease,
  type AuthReleaseIdentity,
  type AuthReleasePulled,
  type AuthTagContext,
} from "./auth-script-types.js";

export type AuthLoadOutcome =
  | { kind: "ok"; release: AuthReleasePulled }
  | { kind: "error"; code: AuthPipelineCode; serverError?: string; message: string };

/**
 * Pull exact authorized pinned Auth release and validate identity/digest.
 * Does not download unrelated packages.
 */
export class AuthScriptLoader {
  constructor(private readonly connection: Pick<ClientConnection, "requestWithAuth" | "getConnectionToken" | "isOnline">) {}

  async pullExact(
    accountId: string,
    tag: AuthTagContext,
    expected: AuthReleaseIdentity
  ): Promise<AuthLoadOutcome> {
    if (!this.connection.isOnline()) {
      return { kind: "error", code: "CLIENT_LEASE_INVALID", message: "Client offline." };
    }
    const token = this.connection.getConnectionToken();
    if (!token) {
      return {
        kind: "error",
        code: "CLIENT_LEASE_INVALID",
        serverError: "connection_token_required",
        message: "Thiếu connection lease token.",
      };
    }

    const body: Record<string, unknown> = {
      connection_token: token,
      account_id: accountId,
    };
    if (typeof tag.actionTagId === "number" && tag.actionTagId > 0) {
      body.action_tag_id = tag.actionTagId;
    } else if (expected.action_tag_id > 0) {
      body.action_tag_id = expected.action_tag_id;
    }
    if (typeof tag.actionTagKey === "string" && tag.actionTagKey.trim()) {
      body.action_tag_key = tag.actionTagKey.trim();
    } else if (expected.action_tag_key) {
      body.action_tag_key = expected.action_tag_key;
    }

    try {
      const res = await this.connection.requestWithAuth(
        "/api/v1/social-automation/client/auth/pull",
        "POST",
        body
      );
      const release = parsePulledRelease(res.release);
      if (!release || res.ok !== true) {
        return {
          kind: "error",
          code: "AUTH_DOWNLOAD_FAILED",
          message: "Pull response thiếu manifest/release.",
        };
      }

      const mismatch = validatePinnedIdentity(expected, release);
      if (mismatch) {
        return { kind: "error", code: "AUTH_INTEGRITY_FAILED", message: mismatch };
      }

      if (!release.assets_complete || !release.ready_to_execute) {
        return {
          kind: "error",
          code: "AUTH_DOWNLOAD_FAILED",
          message: "Auth release assets incomplete / not ready_to_execute.",
        };
      }

      // Defense: ensure manifest JSON is well-formed and digest string is 64-hex (already parsed).
      // Full PackageDigest recompute needs dependencies which Client pull does not return —
      // pin identity + resolve/pull digest equality is the Client integrity gate.
      try {
        JSON.stringify(release.manifest);
      } catch {
        return {
          kind: "error",
          code: "AUTH_INTEGRITY_FAILED",
          message: "Manifest không serialize được.",
        };
      }

      return { kind: "ok", release };
    } catch (err) {
      if (err instanceof SeoOpsHttpError) {
        const serverError = err.diagnostic.serverErrorCode;
        return {
          kind: "error",
          code: mapServerErrorToCode(serverError, err.diagnostic.status),
          serverError,
          message: err.diagnostic.serverErrorMessage || err.message,
        };
      }
      return {
        kind: "error",
        code: "AUTH_DOWNLOAD_FAILED",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function validatePinnedIdentity(
  expected: AuthReleaseIdentity,
  actual: AuthReleasePulled
): string | null {
  if (actual.package_key !== expected.package_key) {
    return `package_key mismatch: expected ${expected.package_key}`;
  }
  if (actual.version !== expected.version) {
    return `version mismatch: expected ${expected.version}`;
  }
  if (actual.release_id !== expected.release_id) {
    return `release_id mismatch: expected ${expected.release_id}`;
  }
  if (actual.content_digest !== expected.content_digest) {
    return "content_digest mismatch between resolve and pull";
  }
  if (!actual.is_authentication) {
    return "pulled release is_authentication=false";
  }
  if (actual.status !== "published") {
    return `pulled release status=${actual.status}`;
  }
  return null;
}

/** Test helper — fingerprint manifest without logging secrets. */
export function manifestFingerprint(manifest: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 16);
}
