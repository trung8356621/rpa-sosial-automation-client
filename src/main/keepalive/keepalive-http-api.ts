import { SeoOpsHttpError } from "../../shared/seo-ops-http.js";
import type { ClientConnection } from "../connection/client-connection.js";
import {
  KEEPALIVE_PROTOCOL_VERSION,
  KEEPALIVE_SCHEMA_VERSION,
  KEEPALIVE_CAPABILITIES,
} from "./contracts.js";

export const KEEPALIVE_REGISTER_PATH = "/api/v1/social-automation/client/keepalive/register";
export const KEEPALIVE_ASSIGNMENTS_PATH = "/api/v1/social-automation/client/keepalive/assignments";
export const KEEPALIVE_CAMPAIGNS_BASE = "/api/v1/social-automation/client/keepalive/campaigns";
export const KEEPALIVE_EVENTS_ACK_PATH =
  "/api/v1/social-automation/client/keepalive/events/ack";
export const KEEPALIVE_ARTIFACTS_ACK_PATH =
  "/api/v1/social-automation/client/keepalive/artifacts/ack";

/** Default page size for event feed (bounded). */
export const KEEPALIVE_EVENTS_PAGE_LIMIT = 100;
/** Max event_ids per ACK batch (coalesce small batches, bound HTTP size). */
export const KEEPALIVE_ACK_BATCH_LIMIT = 50;

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

export interface KeepAliveSnapshotResponse {
  protocolVersion: string;
  schemaVersion: number;
  nodeId: string;
  tenantId: string;
  campaignId: string;
  assignmentGeneration: number;
  snapshotVersion: number;
  /** Snapshot sequence watermark (persisted with snapshot). */
  sequence: number;
  /**
   * Server-reported head of durable event stream.
   * Hint for gap recovery ONLY — never proof that events were persisted locally.
   */
  eventSequenceHead: number | null;
  rowVersion: number;
  updatedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface KeepAliveWireEvent {
  eventId: string;
  tenantId: string;
  campaignId: string;
  jobId: string;
  attempt: number;
  fencingGeneration: number;
  eventSequence: number;
  eventType: string;
  timestamp: string | null;
  payloadVersion: number;
  payload: Record<string, unknown>;
}

export interface KeepAliveEventsResponse {
  protocolVersion: string;
  schemaVersion: number;
  nodeId: string;
  tenantId: string;
  campaignId: string;
  assignmentGeneration: number;
  events: KeepAliveWireEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Server head hint only — not a local persistence proof. */
  eventSequenceHead: number | null;
}

export interface KeepAliveEventsAckResponse {
  protocolVersion: string;
  schemaVersion: number;
  nodeId: string;
  tenantId: string;
  campaignId: string;
  /** Server-confirmed contiguous ACK watermark. */
  lastContiguousSequence: number;
  ackedEventIds: string[];
  idempotent: boolean;
}

export interface KeepAliveArtifactAckResponse {
  protocolVersion: string;
  schemaVersion: number;
  nodeId: string;
  tenantId: string;
  campaignId: string;
  jobId: string;
  attempt: number;
  storageKey: string;
  acked: boolean;
  idempotent: boolean;
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

  async fetchSnapshot(params: {
    campaignId: string;
    nodeId: string;
    assignmentGeneration: number;
  }): Promise<KeepAliveHttpResult<KeepAliveSnapshotResponse>> {
    if (!this.connection.isOnline()) {
      return offlineResult("Client chưa online — không tải snapshot.");
    }
    const qs = new URLSearchParams({
      node_id: params.nodeId,
      assignment_generation: String(params.assignmentGeneration),
    });
    const path = `${KEEPALIVE_CAMPAIGNS_BASE}/${encodeURIComponent(params.campaignId)}/snapshot?${qs}`;
    try {
      const res = await this.connection.requestWithAuth(path, "GET");
      return parseSnapshotResponse(res, params.nodeId, params.campaignId);
    } catch (err) {
      return mapHttpError(err);
    }
  }

  async fetchEvents(params: {
    campaignId: string;
    nodeId: string;
    assignmentGeneration: number;
    fromSequence?: number;
    toSequence?: number;
    cursor?: string | null;
    limit?: number;
  }): Promise<KeepAliveHttpResult<KeepAliveEventsResponse>> {
    if (!this.connection.isOnline()) {
      return offlineResult("Client chưa online — không tải event feed.");
    }
    const qs = new URLSearchParams({
      node_id: params.nodeId,
      assignment_generation: String(params.assignmentGeneration),
      limit: String(params.limit ?? KEEPALIVE_EVENTS_PAGE_LIMIT),
    });
    if (params.fromSequence != null) qs.set("from_sequence", String(params.fromSequence));
    if (params.toSequence != null) qs.set("to_sequence", String(params.toSequence));
    if (params.cursor) qs.set("cursor", params.cursor);
    const path = `${KEEPALIVE_CAMPAIGNS_BASE}/${encodeURIComponent(params.campaignId)}/events?${qs}`;
    try {
      const res = await this.connection.requestWithAuth(path, "GET");
      return parseEventsResponse(res, params.nodeId, params.campaignId);
    } catch (err) {
      return mapHttpError(err);
    }
  }

  /**
   * Durable event delivery ACK — only after local SQLite ingest committed.
   * Never ACKs across a gap; never Job claim/execute.
   */
  async ackEvents(params: {
    nodeId: string;
    campaignId: string;
    assignmentGeneration: number;
    eventIds: string[];
    lastContiguousSequence: number;
  }): Promise<KeepAliveHttpResult<KeepAliveEventsAckResponse>> {
    if (!this.connection.isOnline()) {
      return offlineResult("Client chưa online — không ACK events.");
    }
    if (params.eventIds.length === 0) {
      return {
        ok: false,
        status: 0,
        code: "empty_ack",
        message: "Bỏ qua empty event ACK.",
        fatal: false,
      };
    }
    try {
      const res = await this.connection.requestWithAuth(KEEPALIVE_EVENTS_ACK_PATH, "POST", {
        node_id: params.nodeId,
        campaign_id: params.campaignId,
        assignment_generation: params.assignmentGeneration,
        event_ids: params.eventIds,
        last_contiguous_sequence: params.lastContiguousSequence,
        protocol_version: KEEPALIVE_PROTOCOL_VERSION,
        schema_version: KEEPALIVE_SCHEMA_VERSION,
      });
      return parseEventsAckResponse(res, params.nodeId, params.campaignId);
    } catch (err) {
      return mapHttpError(err);
    }
  }

  /**
   * Artifact delivery ACK (metadata only — no screenshot binary upload).
   */
  async ackArtifact(params: {
    nodeId: string;
    campaignId: string;
    assignmentGeneration: number;
    jobId: string;
    attempt: number;
    storageKey: string;
    sha256: string;
  }): Promise<KeepAliveHttpResult<KeepAliveArtifactAckResponse>> {
    if (!this.connection.isOnline()) {
      return offlineResult("Client chưa online — không ACK artifact.");
    }
    try {
      const res = await this.connection.requestWithAuth(KEEPALIVE_ARTIFACTS_ACK_PATH, "POST", {
        node_id: params.nodeId,
        campaign_id: params.campaignId,
        assignment_generation: params.assignmentGeneration,
        job_id: params.jobId,
        attempt: params.attempt,
        storage_key: params.storageKey,
        sha256: params.sha256,
        protocol_version: KEEPALIVE_PROTOCOL_VERSION,
        schema_version: KEEPALIVE_SCHEMA_VERSION,
      });
      return parseArtifactAckResponse(res, params.nodeId, params.campaignId);
    } catch (err) {
      return mapHttpError(err);
    }
  }
}

function offlineResult(message: string): KeepAliveHttpResult<never> {
  return {
    ok: false,
    status: 0,
    code: "client_offline",
    message,
    fatal: false,
  };
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

export function parseSnapshotResponse(
  raw: Record<string, unknown>,
  expectedNodeId: string,
  expectedCampaignId: string
): KeepAliveHttpResult<KeepAliveSnapshotResponse> {
  const protocolVersion = str(raw.protocol_version) ?? str(raw.protocolVersion);
  const schemaVersion = num(raw.schema_version) ?? num(raw.schemaVersion);
  const nodeId = str(raw.node_id) ?? str(raw.nodeId) ?? expectedNodeId;
  const tenantId = str(raw.tenant_id) ?? str(raw.tenantId);
  const campaignId =
    str(raw.campaign_id) ?? str(raw.campaignId) ?? expectedCampaignId;
  const assignmentGeneration =
    num(raw.assignment_generation) ?? num(raw.assignmentGeneration);
  const snapshotVersion = num(raw.snapshot_version) ?? num(raw.snapshotVersion);
  const sequence = num(raw.sequence) ?? num(raw.snapshot_sequence) ?? 0;
  const eventSequenceHead =
    num(raw.event_sequence_head) ?? num(raw.eventSequenceHead);
  const rowVersion =
    num(raw.row_version) ?? num(raw.rowVersion) ?? num(raw.version) ?? 0;
  const updatedAt = str(raw.updated_at) ?? str(raw.updatedAt);

  const proto = checkProtocol(protocolVersion, schemaVersion);
  if (!proto.ok) return proto;
  if (nodeId !== expectedNodeId) {
    return {
      ok: false,
      status: 422,
      code: "node_id_mismatch",
      message: "Snapshot node_id không khớp Keep Alive node cục bộ.",
      fatal: true,
    };
  }
  if (!tenantId) {
    return {
      ok: false,
      status: 422,
      code: "tenant_id_missing",
      message: "Snapshot thiếu server-owned tenant_id (installation_id).",
      fatal: true,
    };
  }
  if (campaignId !== expectedCampaignId) {
    return {
      ok: false,
      status: 422,
      code: "campaign_id_mismatch",
      message: "Snapshot campaign_id không khớp request.",
      fatal: true,
    };
  }
  if (assignmentGeneration == null || assignmentGeneration < 1) {
    return {
      ok: false,
      status: 422,
      code: "assignment_generation_missing",
      message: "Snapshot thiếu assignment_generation.",
      fatal: true,
    };
  }
  if (snapshotVersion == null || snapshotVersion < 1) {
    return {
      ok: false,
      status: 422,
      code: "snapshot_version_missing",
      message: "Snapshot thiếu snapshot_version.",
      fatal: true,
    };
  }

  const metaRaw = raw.metadata ?? raw.meta ?? {};
  if (!metaRaw || typeof metaRaw !== "object" || Array.isArray(metaRaw)) {
    return {
      ok: false,
      status: 422,
      code: "metadata_invalid",
      message: "Snapshot metadata phải là object.",
      fatal: true,
    };
  }

  return {
    ok: true,
    data: {
      protocolVersion: protocolVersion!,
      schemaVersion: schemaVersion!,
      nodeId,
      tenantId,
      campaignId,
      assignmentGeneration,
      snapshotVersion,
      sequence,
      eventSequenceHead,
      rowVersion,
      updatedAt,
      metadata: metaRaw as Record<string, unknown>,
    },
  };
}

export function parseEventsResponse(
  raw: Record<string, unknown>,
  expectedNodeId: string,
  expectedCampaignId: string
): KeepAliveHttpResult<KeepAliveEventsResponse> {
  const protocolVersion = str(raw.protocol_version) ?? str(raw.protocolVersion);
  const schemaVersion = num(raw.schema_version) ?? num(raw.schemaVersion);
  const nodeId = str(raw.node_id) ?? str(raw.nodeId) ?? expectedNodeId;
  const tenantId = str(raw.tenant_id) ?? str(raw.tenantId);
  const campaignId =
    str(raw.campaign_id) ?? str(raw.campaignId) ?? expectedCampaignId;
  const assignmentGeneration =
    num(raw.assignment_generation) ?? num(raw.assignmentGeneration) ?? 0;
  const eventSequenceHead =
    num(raw.event_sequence_head) ?? num(raw.eventSequenceHead);
  const nextCursor = str(raw.next_cursor) ?? str(raw.nextCursor);
  const hasMore =
    raw.has_more === true ||
    raw.hasMore === true ||
    (nextCursor != null && nextCursor.length > 0);

  const proto = checkProtocol(protocolVersion, schemaVersion);
  if (!proto.ok) return proto;
  if (nodeId !== expectedNodeId) {
    return {
      ok: false,
      status: 422,
      code: "node_id_mismatch",
      message: "Events feed node_id không khớp Keep Alive node cục bộ.",
      fatal: true,
    };
  }
  if (!tenantId) {
    return {
      ok: false,
      status: 422,
      code: "tenant_id_missing",
      message: "Events feed thiếu server-owned tenant_id.",
      fatal: true,
    };
  }
  if (campaignId !== expectedCampaignId) {
    return {
      ok: false,
      status: 422,
      code: "campaign_id_mismatch",
      message: "Events feed campaign_id không khớp request.",
      fatal: true,
    };
  }

  const listRaw = Array.isArray(raw.events)
    ? raw.events
    : Array.isArray(raw.data)
      ? raw.data
      : [];
  const events: KeepAliveWireEvent[] = [];
  for (const item of listRaw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const eventId = str(row.event_id) ?? str(row.eventId);
    const jobId = str(row.job_id) ?? str(row.jobId);
    const eventSequence = num(row.event_sequence) ?? num(row.eventSequence);
    const attempt = num(row.attempt) ?? num(row.attempt_id) ?? 1;
    const fencingGeneration =
      num(row.fencing_generation) ?? num(row.fencingGeneration) ?? 1;
    const eventType = str(row.event_type) ?? str(row.eventType) ?? "";
    const payloadVersion =
      num(row.payload_version) ?? num(row.payloadVersion) ?? 1;
    const explicitTenant = str(row.tenant_id) ?? str(row["tenantId"]);
    const explicitCampaign = str(row.campaign_id) ?? str(row["campaignId"]);
    const rowTenant: string = explicitTenant ?? tenantId;
    const rowCampaign: string = explicitCampaign ?? campaignId;
    if (rowTenant !== tenantId) {
      return {
        ok: false,
        status: 422,
        code: "tenant_mismatch",
        message: "Event row tenant_id lệch envelope tenant_id.",
        fatal: true,
      };
    }
    if (rowCampaign !== campaignId) {
      return {
        ok: false,
        status: 422,
        code: "campaign_id_mismatch",
        message: "Event row campaign_id lệch envelope.",
        fatal: true,
      };
    }
    if (!eventId || !jobId || eventSequence == null || eventSequence < 1 || !eventType) {
      continue;
    }
    const payloadRaw = row.payload ?? row.data ?? {};
    const payload =
      payloadRaw && typeof payloadRaw === "object" && !Array.isArray(payloadRaw)
        ? (payloadRaw as Record<string, unknown>)
        : {};
    events.push({
      eventId,
      tenantId,
      campaignId,
      jobId,
      attempt,
      fencingGeneration,
      eventSequence,
      eventType,
      timestamp: str(row.timestamp) ?? str(row.created_at),
      payloadVersion,
      payload,
    });
  }

  return {
    ok: true,
    data: {
      protocolVersion: protocolVersion!,
      schemaVersion: schemaVersion!,
      nodeId,
      tenantId,
      campaignId,
      assignmentGeneration,
      events,
      nextCursor,
      hasMore,
      eventSequenceHead,
    },
  };
}

export function parseEventsAckResponse(
  raw: Record<string, unknown>,
  expectedNodeId: string,
  expectedCampaignId: string
): KeepAliveHttpResult<KeepAliveEventsAckResponse> {
  const protocolVersion = str(raw.protocol_version) ?? str(raw.protocolVersion);
  const schemaVersion = num(raw.schema_version) ?? num(raw.schemaVersion);
  const nodeId = str(raw.node_id) ?? str(raw.nodeId) ?? expectedNodeId;
  const tenantId = str(raw.tenant_id) ?? str(raw.tenantId) ?? "";
  const campaignId =
    str(raw.campaign_id) ?? str(raw.campaignId) ?? expectedCampaignId;
  const lastContiguousSequence =
    num(raw.last_contiguous_sequence) ??
    num(raw.lastContiguousSequence) ??
    num(raw.confirmed_sequence) ??
    num(raw.acked_sequence);
  const proto = checkProtocol(protocolVersion, schemaVersion);
  if (!proto.ok) return proto;
  if (nodeId !== expectedNodeId) {
    return {
      ok: false,
      status: 422,
      code: "node_id_mismatch",
      message: "Event ACK node_id không khớp Keep Alive node cục bộ.",
      fatal: true,
    };
  }
  if (campaignId !== expectedCampaignId) {
    return {
      ok: false,
      status: 422,
      code: "campaign_id_mismatch",
      message: "Event ACK campaign_id không khớp request.",
      fatal: true,
    };
  }
  const rejected =
    raw.ok === false ||
    str(raw.error) === "ack_beyond_head" ||
    str(raw.error) === "ack_non_contiguous" ||
    str(raw.code) === "ack_beyond_head" ||
    str(raw.code) === "ack_non_contiguous";
  if (rejected) {
    const code = str(raw.code) ?? str(raw.error) ?? "ack_rejected";
    return {
      ok: false,
      status: 409,
      code,
      message: str(raw.message) ?? `Event ACK rejected: ${code}`,
      fatal: false,
    };
  }
  if (lastContiguousSequence == null || lastContiguousSequence < 0) {
    return {
      ok: false,
      status: 422,
      code: "ack_sequence_missing",
      message: "Event ACK thiếu last_contiguous_sequence.",
      fatal: false,
    };
  }
  const idsRaw = Array.isArray(raw.acked_event_ids)
    ? raw.acked_event_ids
    : Array.isArray(raw.event_ids)
      ? raw.event_ids
      : [];
  const ackedEventIds = idsRaw
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
  const idempotent =
    raw.idempotent === true || raw.already_acked === true || raw.duplicate === true;
  return {
    ok: true,
    data: {
      protocolVersion: protocolVersion!,
      schemaVersion: schemaVersion!,
      nodeId,
      tenantId,
      campaignId,
      lastContiguousSequence,
      ackedEventIds,
      idempotent,
    },
  };
}

export function parseArtifactAckResponse(
  raw: Record<string, unknown>,
  expectedNodeId: string,
  expectedCampaignId: string
): KeepAliveHttpResult<KeepAliveArtifactAckResponse> {
  const protocolVersion = str(raw.protocol_version) ?? str(raw.protocolVersion);
  const schemaVersion = num(raw.schema_version) ?? num(raw.schemaVersion);
  const nodeId = str(raw.node_id) ?? str(raw.nodeId) ?? expectedNodeId;
  const tenantId = str(raw.tenant_id) ?? str(raw.tenantId) ?? "";
  const campaignId =
    str(raw.campaign_id) ?? str(raw.campaignId) ?? expectedCampaignId;
  const jobId = str(raw.job_id) ?? str(raw.jobId) ?? "";
  const attempt = num(raw.attempt) ?? 1;
  const storageKey =
    str(raw.storage_key) ?? str(raw.storageKey) ?? str(raw.storage_path) ?? "";
  const proto = checkProtocol(protocolVersion, schemaVersion);
  if (!proto.ok) return proto;
  if (nodeId !== expectedNodeId) {
    return {
      ok: false,
      status: 422,
      code: "node_id_mismatch",
      message: "Artifact ACK node_id không khớp Keep Alive node cục bộ.",
      fatal: true,
    };
  }
  if (campaignId !== expectedCampaignId) {
    return {
      ok: false,
      status: 422,
      code: "campaign_id_mismatch",
      message: "Artifact ACK campaign_id không khớp request.",
      fatal: true,
    };
  }
  const code = str(raw.code) ?? str(raw.error);
  if (
    raw.ok === false ||
    code === "artifact_not_ready" ||
    code === "artifact_unsupported" ||
    code === "checksum_mismatch" ||
    code === "storage_key_mismatch"
  ) {
    return {
      ok: false,
      status: code === "artifact_not_ready" ? 409 : 422,
      code: code ?? "artifact_ack_rejected",
      message: str(raw.message) ?? `Artifact ACK rejected: ${code}`,
      fatal: false,
    };
  }
  const acked =
    raw.acked === true ||
    raw.ok === true ||
    raw.already_acked === true ||
    raw.idempotent === true;
  if (!acked) {
    return {
      ok: false,
      status: 422,
      code: "artifact_ack_rejected",
      message: str(raw.message) ?? "Artifact ACK không xác nhận.",
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
      campaignId,
      jobId,
      attempt,
      storageKey,
      acked: true,
      idempotent: raw.idempotent === true || raw.already_acked === true || raw.duplicate === true,
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
    const ackCursor =
      code === "ack_beyond_head" || code === "ack_non_contiguous";
    const artifactNotReady = code === "artifact_not_ready";
    const staleGen =
      (!ackCursor && !artifactNotReady && status === 409) ||
      code === "assignment_generation_stale" ||
      code === "stale_assignment_generation";
    const fatal =
      status === 401 ||
      status === 403 ||
      code === "protocol_mismatch" ||
      code === "schema_mismatch" ||
      code === "keepalive_protocol_unsupported";
    let mappedCode = code;
    if (staleGen) mappedCode = "assignment_generation_stale";
    else if (ackCursor) mappedCode = code;
    else if (artifactNotReady) mappedCode = "artifact_not_ready";
    return {
      ok: false,
      status,
      code: mappedCode,
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
