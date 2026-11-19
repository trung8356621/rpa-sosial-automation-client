import { SeoOpsHttpError } from "../../shared/seo-ops-http.js";
import type { ClientConnection } from "../connection/client-connection.js";
import { logClientEvent } from "../main-error-log.js";
import { mapServerErrorToCode, type AuthPipelineCode } from "./outcomes.js";
import type { AuthTagContext } from "./auth-script-types.js";

/**
 * Client ↔ Addon contract: POST /client/auth/context
 * Discovers eligible Authentication Action Tags for an Account.
 * Never invents {platform}.login or picks Auth Scripts by name.
 */
export type AuthContextMatch = "none" | "unique" | "ambiguous";

export type AuthContextCandidate = {
  actionTagId: number;
  actionTagKey: string;
};

export type AuthContextFindOutcome =
  | { kind: "none"; count: 0; message: string }
  | { kind: "unique"; count: 1; tag: AuthTagContext; message: string }
  | {
      kind: "ambiguous";
      count: number;
      candidates: AuthContextCandidate[];
      message: string;
    }
  | {
      kind: "error";
      code: AuthPipelineCode;
      serverError?: string;
      message: string;
    };

export class AuthContextFinder {
  constructor(
    private readonly connection: Pick<
      ClientConnection,
      "requestWithAuth" | "getConnectionToken" | "isOnline"
    >
  ) {}

  async findForAccount(accountId: string): Promise<AuthContextFindOutcome> {
    if (!accountId.trim()) {
      return {
        kind: "error",
        code: "UNKNOWN",
        message: "Thiếu account_id cho auth/context.",
      };
    }
    if (!this.connection.isOnline()) {
      return {
        kind: "error",
        code: "CLIENT_LEASE_INVALID",
        message: "Client offline — không thể tìm Auth context.",
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

    try {
      const res = await this.connection.requestWithAuth(
        "/api/v1/social-automation/client/auth/context",
        "POST",
        {
          connection_token: token,
          account_id: accountId,
        }
      );
      return parseAuthContextResponse(res, accountId);
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
        code: "UNKNOWN",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function parseAuthContextResponse(
  res: Record<string, unknown>,
  accountId: string
): AuthContextFindOutcome {
  if (res.ok !== true) {
    return {
      kind: "error",
      code: "AUTH_CONTEXT_UNAVAILABLE",
      message: "auth/context response ok≠true.",
    };
  }

  const match = String(res.match ?? "").trim().toLowerCase() as AuthContextMatch;
  const count = Number(res.count);
  const safeCount = Number.isFinite(count) && count >= 0 ? Math.floor(count) : -1;

  if (match === "none" || safeCount === 0) {
    logClientEvent("AUTH_SKIPPED", {
      reason: "no_eligible_auth_tags",
      accountId,
      count: 0,
    });
    return {
      kind: "none",
      count: 0,
      message: "Không có Authentication Action Tag đủ điều kiện — manual login.",
    };
  }

  if (match === "unique" || safeCount === 1) {
    const tag = extractUniqueTag(res);
    if (!tag) {
      return {
        kind: "error",
        code: "AUTH_CONTEXT_UNAVAILABLE",
        message: "auth/context báo unique nhưng thiếu action_tag_id/key.",
      };
    }
    logClientEvent("AUTH_CONTEXT_FOUND", {
      accountId,
      match: "unique",
      actionTagId: tag.actionTagId,
      actionTagKey: tag.actionTagKey,
      count: 1,
    });
    return {
      kind: "unique",
      count: 1,
      tag,
      message: "Tìm thấy đúng 1 Authentication Action Tag đủ điều kiện.",
    };
  }

  if (match === "ambiguous" || safeCount > 1) {
    const candidates = extractCandidates(res);
    logClientEvent("AUTH_CONTEXT_FOUND", {
      accountId,
      match: "ambiguous",
      count: candidates.length || safeCount,
      candidateKeys: candidates.map((c) => c.actionTagKey),
    });
    return {
      kind: "ambiguous",
      count: candidates.length || safeCount,
      candidates,
      message:
        "Nhiều Authentication Action Tag đủ điều kiện — không chọn bừa (ambiguous).",
    };
  }

  return {
    kind: "error",
    code: "AUTH_CONTEXT_UNAVAILABLE",
    message: `auth/context match không hợp lệ: ${String(res.match)}`,
  };
}

function extractUniqueTag(res: Record<string, unknown>): AuthTagContext | null {
  const id = Number(res.action_tag_id);
  const key = typeof res.action_tag_key === "string" ? res.action_tag_key.trim() : "";
  const tagObj =
    res.action_tag && typeof res.action_tag === "object"
      ? (res.action_tag as Record<string, unknown>)
      : null;
  const nestedId = tagObj ? Number(tagObj.action_tag_id ?? tagObj.id) : 0;
  const nestedKey = tagObj
    ? String(tagObj.action_tag_key ?? tagObj.tag_key ?? "").trim()
    : "";

  const actionTagId = Number.isFinite(id) && id > 0 ? id : nestedId > 0 ? nestedId : undefined;
  const actionTagKey = key || nestedKey || undefined;
  if (!actionTagId && !actionTagKey) return null;
  return { actionTagId, actionTagKey };
}

function extractCandidates(res: Record<string, unknown>): AuthContextCandidate[] {
  const raw = Array.isArray(res.candidates) ? res.candidates : [];
  const out: AuthContextCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = Number(row.action_tag_id ?? row.id);
    const key = String(row.action_tag_key ?? row.tag_key ?? "").trim();
    if ((!Number.isFinite(id) || id < 1) && !key) continue;
    out.push({
      actionTagId: Number.isFinite(id) && id > 0 ? id : 0,
      actionTagKey: key,
    });
  }
  return out;
}
