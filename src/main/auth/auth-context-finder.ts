import { SeoOpsHttpError } from "../../shared/seo-ops-http.js";
import type { ClientConnection } from "../connection/client-connection.js";
import { logClientEvent } from "../main-error-log.js";
import { mapServerErrorToCode, type AuthPipelineCode } from "./outcomes.js";
import {
  parseExecutionContext,
  type AuthResolutionSource,
  type AuthTagContext,
} from "./auth-script-types.js";

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
  | { kind: "not_required"; message: string }
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

  async findForAccount(
    accountId: string,
    opts?: { siteUrl?: string | null; platform?: string | null }
  ): Promise<AuthContextFindOutcome> {
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
      const body: Record<string, unknown> = {
        connection_token: token,
        account_id: accountId,
      };
      if (opts?.siteUrl?.trim()) body.site_url = opts.siteUrl.trim();
      if (opts?.platform?.trim()) body.platform = opts.platform.trim();
      const res = await this.connection.requestWithAuth(
        "/api/v1/social-automation/client/auth/context",
        "POST",
        body
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

  const match = String(res.match ?? "").trim().toLowerCase() as AuthContextMatch | "not_required";
  const count = Number(res.count);
  const safeCount = Number.isFinite(count) && count >= 0 ? Math.floor(count) : -1;

  if (res.auth_required === false || match === "not_required") {
    logClientEvent("AUTH_SKIPPED", {
      reason: "auth_not_required",
      accountId,
    });
    return {
      kind: "not_required",
      message: "Authentication not required.",
    };
  }

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
      resolutionSource: tag.resolutionSource ?? null,
      cmsType: tag.cmsType ?? null,
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

function extractResolutionSource(res: Record<string, unknown>): AuthResolutionSource | undefined {
  if (res.cms_global === true || res.is_global_fallback === true) return "cms_global";
  const raw = String(
    res.resolution_source ?? res.auth_scope ?? res.scope ?? ""
  )
    .trim()
    .toLowerCase();
  if (raw === "account_pin" || raw === "account_hard_pin" || raw === "hard_pin") {
    return "account_pin";
  }
  if (raw === "site_specific" || raw === "site") return "site_specific";
  if (raw === "cms_global" || raw === "global" || raw === "global_fallback") return "cms_global";
  return undefined;
}

function extractUniqueTag(res: Record<string, unknown>): AuthTagContext | null {
  const id = Number(res.action_tag_id);
  const key = typeof res.action_tag_key === "string" ? res.action_tag_key.trim() : "";
  const tagObj =
    res.action_tag && typeof res.action_tag === "object"
      ? (res.action_tag as Record<string, unknown>)
      : null;
  const firstCandidate =
    Array.isArray(res.candidates) && res.candidates.length === 1 && typeof res.candidates[0] === "object"
      ? (res.candidates[0] as Record<string, unknown>)
      : null;
  const nestedId = tagObj
    ? Number(tagObj.action_tag_id ?? tagObj.id)
    : firstCandidate
      ? Number(firstCandidate.action_tag_id ?? firstCandidate.id)
      : 0;
  const nestedKey = tagObj
    ? String(tagObj.action_tag_key ?? tagObj.tag_key ?? "").trim()
    : firstCandidate
      ? String(firstCandidate.action_tag_key ?? firstCandidate.tag_key ?? "").trim()
      : "";

  const actionTagId = Number.isFinite(id) && id > 0 ? id : nestedId > 0 ? nestedId : undefined;
  const actionTagKey = key || nestedKey || undefined;
  if (!actionTagId && !actionTagKey) return null;
  const resolutionSource = extractResolutionSource(res);
  const cmsType =
    typeof (res.cms_type ?? res.cmsType) === "string"
      ? String(res.cms_type ?? res.cmsType).trim() || undefined
      : undefined;
  const siteId =
    typeof (res.site_id ?? res.siteId) === "string"
      ? String(res.site_id ?? res.siteId).trim() || undefined
      : undefined;
  const executionContext = parseExecutionContext(res.execution_context, res.resolved_url);
  return { actionTagId, actionTagKey, resolutionSource, cmsType, siteId, executionContext };
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
