import { SeoOpsHttpError } from "../../shared/seo-ops-http.js";
import type { ClientConnection } from "../connection/client-connection.js";
import { mapServerErrorToCode, type AuthPipelineCode } from "./outcomes.js";
import {
  hasExplicitTagContext,
  parseReleaseIdentity,
  type AuthReleaseIdentity,
  type AuthTagContext,
} from "./auth-script-types.js";

export type AuthResolveOutcome =
  | { kind: "no_tag_context" }
  | { kind: "ok"; release: AuthReleaseIdentity }
  | { kind: "no_auth_configured"; serverError?: string }
  | { kind: "error"; code: AuthPipelineCode; serverError?: string; message: string };

export class AuthScriptResolver {
  constructor(private readonly connection: Pick<ClientConnection, "requestWithAuth" | "getConnectionToken" | "isOnline">) {}

  async resolve(accountId: string, tag: AuthTagContext): Promise<AuthResolveOutcome> {
    if (!hasExplicitTagContext(tag)) {
      return { kind: "no_tag_context" };
    }
    if (!this.connection.isOnline()) {
      return {
        kind: "error",
        code: "CLIENT_LEASE_INVALID",
        message: "Client chưa kết nối hoặc lease không sẵn sàng.",
      };
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
    }
    if (typeof tag.actionTagKey === "string" && tag.actionTagKey.trim()) {
      body.action_tag_key = tag.actionTagKey.trim();
    }

    try {
      const res = await this.connection.requestWithAuth(
        "/api/v1/social-automation/client/auth/resolve",
        "POST",
        body
      );
      const release = parseReleaseIdentity(res.release);
      if (!release || res.ok !== true) {
        return {
          kind: "error",
          code: "AUTH_RELEASE_UNAVAILABLE",
          message: "Resolve response thiếu release identity hợp lệ.",
        };
      }
      if (!release.is_authentication || release.status !== "published") {
        return {
          kind: "error",
          code: "AUTH_RELEASE_UNAVAILABLE",
          message: "Pinned release không phải Auth published.",
        };
      }
      return { kind: "ok", release };
    } catch (err) {
      return this.mapHttpFailure(err);
    }
  }

  private mapHttpFailure(err: unknown): AuthResolveOutcome {
    if (err instanceof SeoOpsHttpError) {
      const serverError = err.diagnostic.serverErrorCode;
      const code = mapServerErrorToCode(serverError, err.diagnostic.status);
      if (code === "NO_AUTH_CONFIGURED" || serverError === "auth_pin_missing") {
        return { kind: "no_auth_configured", serverError: serverError ?? "auth_pin_missing" };
      }
      return {
        kind: "error",
        code,
        serverError,
        message: err.diagnostic.serverErrorMessage || err.message,
      };
    }
    return {
      kind: "error",
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
