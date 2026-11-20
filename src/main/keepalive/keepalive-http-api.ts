import { SeoOpsHttpError } from "../../shared/seo-ops-http.js";
import type { ClientConnection } from "../connection/client-connection.js";
import {
  KEEPALIVE_PROTOCOL_VERSION,
  KEEPALIVE_SCHEMA_VERSION,
  KEEPALIVE_CAPABILITIES,
} from "./contracts.js";

export const KEEPALIVE_REGISTER_PATH = "/api/v1/social-automation/client/keepalive/register";
export const KEEPALIVE_ASSIGNMENTS_PATH = "/api/v1/social-automation/client/keepalive/assignments";

export type KeepAliveHttpResult<T> =
  | { ok: true; data: T; idempotent?: boolean }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      fatal: boolean;
    };

export interface KeepAliveRegisterResponse {
  protocolVersion: string;
  schemaVersion: number;
  nodeId: string;
  tenantId: string | null;
  registered: boolean;
}

export interface KeepAliveServerAssignment {
  campaignId: string;
  assignmentGeneration: number;
  rowVersion: number;
  status: "assigned" | "revoked";
}

export interface KeepAliveAssignmentsResponse {
  protocolVersion: string;
  schemaVersion: number;
  nodeId: string;
  tenantId: string;
  assignments: KeepAliveServerAssignment[];
}

/**
 * Typed Keep Alive HTTP client (keepalive.v1).
 * Auth: existing Client API Key via ClientConnection — no separate auth.
 * Does not claim/ack/execute Campaign Jobs.
 */
export class KeepAliveHttpApi {
  constructor(
    private readonly connection: Pick<
      ClientConnection,
      "requestWithAuth" | "isOnline" | "getState"
    >
  ) {}

  async register(params: {
    nodeId: string;
    agentUuid: string;
  }): Promise<KeepAliveHttpResult<KeepAliveRegisterResponse>> {
    if (!this.connection.isOnline()) {
      return {
        ok: false,
        status: 0,
        code: "client_offline",
        message: "Client chưa online — không đăng ký Keep Alive.",
        fatal: false,
      };
    }
    if (!params.agentUuid?.trim()) {
      return {
        ok: false,
        status: 0,
        code: "agent_uuid_missing",
        message: "Thiếu agent_uuid từ Client registration.",
        fatal: false,
      };
    }

    try {
      const res = await this.connection.requestWithAuth(KEEPALIVE_REGISTER_PATH, "POST", {
        node_id: params.nodeId,
        agent_uuid: params.agentUuid,
        protocol_version: KEEPALIVE_PROTOCOL_VERSION,
        schema_version: KEEPALIVE_SCHEMA_VERSION,
        capabilities: [...KEEPALIVE_CAPABILITIES],
        // tenant_id omitted — server-owned
      });
      const parsed = parseRegisterResponse(res, params.nodeId);
      if (!parsed.ok) return parsed;
      return {
        ok: true,
        data: parsed.data,
        idempotent: Boolean(res.idempotent) || Boolean(res.already_registered),
      };
    } catch (err) {
      return mapHttpError(err);
    }
  }

  async fetchAssignments(params: {
    nodeId: string;
  }): Promise<KeepAliveHttpResult<KeepAliveAssignmentsResponse>> {
    if (!this.connection.isOnline()) {
      return {
        ok: false,
        status: 0,
        code: "client_offline",
        message: "Client chưa online — không tải assignments.",
        fatal: false,
      };
    }
    const qs = `?node_id=${encodeURIComponent(params.nodeId)}`;
    try {
      const res = await this.connection.requestWithAuth(
        `${KEEPALIVE_ASSIGNMENTS_PATH}${qs}`,
        "GET"
      );
      return parseAssignmentsResponse(res, params.nodeId);
    } catch (err) {
      return mapHttpError(err);
    }
  }
}

export function parseRegisterResponse(
  raw: Record<string, unknown>,
  expectedNodeId: string
): KeepAliveHttpResult<KeepAliveRegisterResponse> {
  const protocolVersion = str(raw.protocol_version) ?? str(raw.protocolVersion);
  const schemaVersion = num(raw.schema_version) ?? num(raw.schemaVersion);
  const nodeId = str(raw.node_id) ?? str(raw.nodeId) ?? expectedNodeId;
  const tenantId = str(raw.tenant_id) ?? str(raw.tenantId);

  const proto = checkProtocol(protocolVersion, schemaVersion);
  if (!proto.ok) return proto;

  if (nodeId !== expectedNodeId) {
    return {
      ok: false,
      status: 422,
      code: "node_id_mismatch",
      message: "Register response node_id không khớp Keep Alive node cục bộ.",
      fatal: true,
    };
  }

  const registered =
    raw.registered === true ||
    raw.ok === true ||
    raw.status === "registered" ||
    raw.already_registered === true;

  if (!registered && raw.ok === false) {
    return {
      ok: false,
      status: 422,
      code: "register_rejected",
      message: str(raw.message) ?? "Keep Alive register bị từ chối.",
      fatal: false,
    };
  }

  return {
    ok: true,
    data: {
      protocolVersion: protocolVersion!,
      schemaVersion: schemaVersion!,
      nodeId,
      tenantId,
      registered: true,
    },
  };
}

export function parseAssignmentsResponse(
  raw: Record<string, unknown>,
  expectedNodeId: string
): KeepAliveHttpResult<KeepAliveAssignmentsResponse> {
  const protocolVersion = str(raw.protocol_version) ?? str(raw.protocolVersion);
  const schemaVersion = num(raw.schema_version) ?? num(raw.schemaVersion);
  const nodeId = str(raw.node_id) ?? str(raw.nodeId) ?? expectedNodeId;
  const tenantId = str(raw.tenant_id) ?? str(raw.tenantId);

  const proto = checkProtocol(protocolVersion, schemaVersion);
  if (!proto.ok) return proto;

  if (nodeId !== expectedNodeId) {
    return {
      ok: false,
      status: 422,
      code: "node_id_mismatch",
      message: "Assignments response node_id không khớp Keep Alive node cục bộ.",
      fatal: true,
    };
  }
  if (!tenantId) {
    return {
      ok: false,
      status: 422,
      code: "tenant_id_missing",
      message: "Assignments response thiếu server-owned tenant_id.",
      fatal: true,
    };
  }

  const listRaw = Array.isArray(raw.assignments)
    ? raw.assignments
    : Array.isArray(raw.data)
      ? raw.data
      : [];
  const assignments: KeepAliveServerAssignment[] = [];
  for (const item of listRaw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const campaignId = str(row.campaign_id) ?? str(row.campaignId);
    const assignmentGeneration =
      num(row.assignment_generation) ?? num(row.assignmentGeneration);
    const rowVersion = num(row.row_version) ?? num(row.rowVersion) ?? 0;
    if (!campaignId || assignmentGeneration == null || assignmentGeneration < 1) {
      continue;
    }
    const rowTenant = str(row.tenant_id) ?? str(row.tenantId);
    if (rowTenant && rowTenant !== tenantId) {
      return {
        ok: false,
        status: 422,
        code: "tenant_mismatch",
        message: "Assignment row tenant_id lệch envelope tenant_id.",
        fatal: true,
      };
    }
    const statusRaw = str(row.status) ?? "assigned";
    const status = statusRaw === "revoked" ? "revoked" : "assigned";
    assignments.push({
      campaignId,
      assignmentGeneration,
      rowVersion,
      status,
    });
  }

  return {
    ok: true,
    data: {
      protocolVersion: protocolVersion!,
      schemaVersion: schemaVersion!,
      nodeId,
      tenantId,
      assignments,
    },
  };
}

function checkProtocol(
  protocolVersion: string | null,
  schemaVersion: number | null
): KeepAliveHttpResult<never> | { ok: true } {
  if (protocolVersion !== KEEPALIVE_PROTOCOL_VERSION) {
    return {
      ok: false,
      status: 422,
      code: "protocol_mismatch",
      message: `Protocol không tương thích (expected ${KEEPALIVE_PROTOCOL_VERSION}).`,
      fatal: true,
    };
  }
  if (schemaVersion !== KEEPALIVE_SCHEMA_VERSION) {
    return {
      ok: false,
      status: 422,
      code: "schema_mismatch",
      message: `Schema không tương thích (expected ${KEEPALIVE_SCHEMA_VERSION}).`,
      fatal: true,
    };
  }
  return { ok: true };
}

function mapHttpError(err: unknown): KeepAliveHttpResult<never> {
  if (err instanceof SeoOpsHttpError) {
    const status = err.diagnostic.status;
    const code = err.diagnostic.serverErrorCode || err.diagnostic.category;
    const fatal =
      status === 401 ||
      status === 403 ||
      code === "protocol_mismatch" ||
      code === "schema_mismatch" ||
      code === "keepalive_protocol_unsupported";
    return {
      ok: false,
      status,
      code,
      message: sanitize(
        err.diagnostic.serverErrorMessage || err.message || `HTTP ${status}`
      ),
      fatal,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const network = /fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(msg);
  return {
    ok: false,
    status: 0,
    code: network ? "server_unavailable" : "request_failed",
    message: sanitize(network ? "Server tạm thời không khả dụng." : msg),
    fatal: false,
  };
}

function sanitize(value: string): string {
  return value
    .replace(/Bearer\s+\S+|rpa_[A-Za-z0-9_-]+/gi, "[redacted]")
    .slice(0, 300);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}
