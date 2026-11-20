import { logClientError, logClientEvent } from "../main-error-log.js";
import type { ArtifactAckState, JobJournalEventRecord } from "./contracts.js";
import {
  KEEPALIVE_ACK_BATCH_LIMIT,
  type KeepAliveHttpApi,
} from "./keepalive-http-api.js";
import type { KeepAliveSqliteStore } from "./keepalive-sqlite.js";

export interface CampaignAckOutcome {
  campaignId: string;
  eventsAcked: number;
  lastServerAckSequence: number;
  artifactsAcked: number;
  artifactState: ArtifactAckState;
  error: string | null;
  needsFeedRefresh: boolean;
  needsAssignmentRefresh: boolean;
  authFatal: boolean;
  revoked: boolean;
}

export interface DurableAckSummary {
  outcomes: CampaignAckOutcome[];
  lastServerAckSequence: number | null;
  pendingAckCount: number;
  artifactAckPendingCount: number;
  artifactAckState: ArtifactAckState;
  lastAckSuccessAt: string | null;
  lastAckError: string | null;
  serverDurableAck: boolean;
  needsFeedRefresh: boolean;
  needsAssignmentRefresh: boolean;
  authFatal: boolean;
}

/**
 * Flush durable Event + Artifact delivery ACKs after SQLite commit.
 * Runs inside the existing sync loop — no independent polling.
 * Never ACKs across gaps; never advances confirmed ACK on cursor mismatch.
 */
export async function flushDurableAcks(
  api: KeepAliveHttpApi,
  store: KeepAliveSqliteStore,
  params: { nodeId: string; tenantId: string }
): Promise<DurableAckSummary> {
  const assigned = store
    .listAssignments(params.nodeId, "assigned")
    .filter((a) => a.tenantId === params.tenantId);

  const outcomes: CampaignAckOutcome[] = [];
  let lastAckSuccessAt: string | null = null;
  let lastAckError: string | null = null;
  let needsFeedRefresh = false;
  let needsAssignmentRefresh = false;
  let authFatal = false;
  let anyServerAck = false;

  for (const row of assigned) {
    const out = await flushCampaignAcks(api, store, {
      nodeId: params.nodeId,
      tenantId: row.tenantId,
      campaignId: row.campaignId,
      assignmentGeneration: row.assignmentGeneration,
    });
    outcomes.push(out);
    if (out.eventsAcked > 0 || out.artifactsAcked > 0) {
      anyServerAck = true;
      lastAckSuccessAt = new Date().toISOString();
    }
    if (out.error) lastAckError = out.error;
    if (out.needsFeedRefresh) needsFeedRefresh = true;
    if (out.needsAssignmentRefresh) needsAssignmentRefresh = true;
    if (out.authFatal || out.revoked) {
      authFatal = out.authFatal;
      break;
    }
  }

  // Also count historical server ACKs from cursors (restart persistence).
  const maxAck = store.maxServerAckSequence(params.nodeId);
  if (maxAck != null && maxAck > 0) anyServerAck = true;

  const pendingAckCount = countPendingEventAcks(store, params.nodeId, params.tenantId);
  const artifactAckPendingCount = countPendingArtifactAcks(
    store,
    params.nodeId,
    params.tenantId
  );
  const artifactAckState = summarizeArtifactState(outcomes, artifactAckPendingCount);

  return {
    outcomes,
    lastServerAckSequence: maxAck,
    pendingAckCount,
    artifactAckPendingCount,
    artifactAckState,
    lastAckSuccessAt,
    lastAckError,
    serverDurableAck: anyServerAck,
    needsFeedRefresh,
    needsAssignmentRefresh,
    authFatal,
  };
}

async function flushCampaignAcks(
  api: KeepAliveHttpApi,
  store: KeepAliveSqliteStore,
  params: {
    nodeId: string;
    tenantId: string;
    campaignId: string;
    assignmentGeneration: number;
  }
): Promise<CampaignAckOutcome> {
  const base: CampaignAckOutcome = {
    campaignId: params.campaignId,
    eventsAcked: 0,
    lastServerAckSequence:
      store.getCursor(params.tenantId, params.campaignId)?.lastServerAckSequence ?? 0,
    artifactsAcked: 0,
    artifactState: "idle",
    error: null,
    needsFeedRefresh: false,
    needsAssignmentRefresh: false,
    authFatal: false,
    revoked: false,
  };

  const assignment = store.getAssignment(params.tenantId, params.campaignId, params.nodeId);
  if (!assignment || assignment.status !== "assigned") {
    return { ...base, revoked: true, error: "Assignment revoked — stop ACK." };
  }

  // Ensure screenshot metadata rows exist for applied screenshot_uploaded events.
  materializeScreenshotArtifacts(store, params.tenantId, params.campaignId);

  const eventOut = await flushEventAcks(api, store, params, assignment.assignmentGeneration);
  Object.assign(base, eventOut);
  if (base.authFatal || base.revoked || base.needsAssignmentRefresh) {
    return base;
  }

  const artOut = await flushArtifactAcks(api, store, params, assignment.assignmentGeneration);
  base.artifactsAcked = artOut.artifactsAcked;
  base.artifactState = artOut.artifactState;
  if (artOut.error && !base.error) base.error = artOut.error;
  if (artOut.authFatal) {
    base.authFatal = true;
    base.error = artOut.error;
  }
  if (artOut.needsAssignmentRefresh) base.needsAssignmentRefresh = true;

  base.lastServerAckSequence =
    store.getCursor(params.tenantId, params.campaignId)?.lastServerAckSequence ??
    base.lastServerAckSequence;

  return base;
}

async function flushEventAcks(
  api: KeepAliveHttpApi,
  store: KeepAliveSqliteStore,
  params: {
    nodeId: string;
    tenantId: string;
    campaignId: string;
  },
  assignmentGeneration: number
): Promise<Partial<CampaignAckOutcome>> {
  const cursor = store.getCursor(params.tenantId, params.campaignId);
  const lastAck = cursor?.lastServerAckSequence ?? 0;
  const lastApplied = cursor?.lastAppliedSequence ?? 0;
  if (lastApplied <= lastAck) {
    return { eventsAcked: 0, lastServerAckSequence: lastAck };
  }

  const candidates = store.listAppliedPendingAckEvents(
    params.tenantId,
    params.campaignId,
    lastAck,
    lastApplied,
    KEEPALIVE_ACK_BATCH_LIMIT
  );
  const batch = selectContiguousBatch(candidates, lastAck);
  if (batch.length === 0) {
    // Gap between lastAck+1 and next pending — never ACK across; request feed refresh.
    if (candidates.length > 0 && candidates[0].eventSequence > lastAck + 1) {
      logClientEvent("KEEPALIVE_ACK_GAP_BLOCKED", {
        campaignId: params.campaignId,
        lastAck,
        nextPending: candidates[0].eventSequence,
      });
      return {
        eventsAcked: 0,
        lastServerAckSequence: lastAck,
        needsFeedRefresh: true,
        error: "Gap before pending ACK — refresh event feed.",
      };
    }
    return { eventsAcked: 0, lastServerAckSequence: lastAck };
  }

  const eventIds = batch.map((e) => e.eventId);
  const lastContiguousSequence = batch[batch.length - 1].eventSequence;

  // Deduplicate retries: same ids+sequence until server confirms; local cursor unchanged on failure.
  const res = await api.ackEvents({
    nodeId: params.nodeId,
    campaignId: params.campaignId,
    assignmentGeneration,
    eventIds,
    lastContiguousSequence,
  });

  if (!res.ok) {
    if (res.code === "ack_beyond_head" || res.code === "ack_non_contiguous") {
      logClientError(
        "KEEPALIVE_ACK_CURSOR_MISMATCH",
        new Error(`${res.code}: ${res.message}`)
      );
      return {
        eventsAcked: 0,
        lastServerAckSequence: lastAck,
        needsFeedRefresh: true,
        error: res.message,
      };
    }
    if (res.code === "assignment_generation_stale") {
      return {
        eventsAcked: 0,
        lastServerAckSequence: lastAck,
        needsAssignmentRefresh: true,
        error: res.message,
      };
    }
    if (res.fatal && (res.status === 401 || res.status === 403)) {
      return {
        eventsAcked: 0,
        lastServerAckSequence: lastAck,
        authFatal: true,
        error: res.message,
      };
    }
    if (res.code === "empty_ack") {
      return { eventsAcked: 0, lastServerAckSequence: lastAck };
    }
    logClientError("KEEPALIVE_EVENT_ACK_FAILED", new Error(`${res.code}: ${res.message}`));
    return {
      eventsAcked: 0,
      lastServerAckSequence: lastAck,
      error: res.message,
    };
  }

  const confirmed = res.data.lastContiguousSequence;
  // Never advance local confirmed ACK past what we sent or beyond local applied.
  if (confirmed < lastAck || confirmed > lastContiguousSequence || confirmed > lastApplied) {
    logClientError(
      "KEEPALIVE_ACK_REJECT_CONFIRM_RANGE",
      new Error(
        `confirmed=${confirmed} lastAck=${lastAck} sent=${lastContiguousSequence} applied=${lastApplied}`
      )
    );
    return {
      eventsAcked: 0,
      lastServerAckSequence: lastAck,
      needsFeedRefresh: true,
      error: "Server ACK sequence out of safe range — not advancing local confirmed ACK.",
    };
  }

  const ackedIds =
    res.data.ackedEventIds.length > 0
      ? res.data.ackedEventIds
      : eventIds.filter((id) => {
          const ev = batch.find((b) => b.eventId === id);
          return ev != null && ev.eventSequence <= confirmed;
        });

  store.transaction(() => {
    store.markJournalEventsServerAcked(ackedIds);
    store.advanceServerAckCursor({
      tenantId: params.tenantId,
      campaignId: params.campaignId,
      lastServerAckSequence: confirmed,
    });
  });

  logClientEvent("KEEPALIVE_EVENT_ACK_OK", {
    campaignId: params.campaignId,
    count: ackedIds.length,
    lastContiguousSequence: confirmed,
    idempotent: res.data.idempotent,
  });

  return {
    eventsAcked: ackedIds.length,
    lastServerAckSequence: confirmed,
  };
}

async function flushArtifactAcks(
  api: KeepAliveHttpApi,
  store: KeepAliveSqliteStore,
  params: {
    nodeId: string;
    tenantId: string;
    campaignId: string;
  },
  assignmentGeneration: number
): Promise<{
  artifactsAcked: number;
  artifactState: ArtifactAckState;
  error: string | null;
  authFatal: boolean;
  needsAssignmentRefresh: boolean;
}> {
  const pending = store.listPendingArtifactAcks(params.tenantId, params.campaignId);
  if (pending.length === 0) {
    return {
      artifactsAcked: 0,
      artifactState: "idle",
      error: null,
      authFatal: false,
      needsAssignmentRefresh: false,
    };
  }

  let artifactsAcked = 0;
  let artifactState: ArtifactAckState = "pending";
  let error: string | null = null;
  let authFatal = false;
  let needsAssignmentRefresh = false;

  for (const shot of pending.slice(0, 10)) {
    if (!shot.storageKey || !shot.sha256) continue;
    const res = await api.ackArtifact({
      nodeId: params.nodeId,
      campaignId: params.campaignId,
      assignmentGeneration,
      jobId: shot.jobId,
      attempt: shot.attempt,
      storageKey: shot.storageKey,
      sha256: shot.sha256,
    });

    if (!res.ok) {
      if (res.code === "artifact_not_ready") {
        artifactState = "not_ready";
        // Retry later — leave server_ack_at null.
        continue;
      }
      if (res.code === "artifact_unsupported") {
        artifactState = "unsupported";
        const now = new Date().toISOString();
        store.upsertScreenshotMetadata({
          ...shot,
          uploadStatus: "unsupported",
          updatedAt: now,
        });
        error = res.message;
        continue;
      }
      if (
        res.status === 422 ||
        res.code === "checksum_mismatch" ||
        res.code === "storage_key_mismatch"
      ) {
        artifactState = "mismatch";
        const now = new Date().toISOString();
        store.upsertScreenshotMetadata({
          ...shot,
          uploadStatus: "failed",
          updatedAt: now,
        });
        error = res.message;
        continue;
      }
      if (res.code === "assignment_generation_stale") {
        needsAssignmentRefresh = true;
        error = res.message;
        break;
      }
      if (res.fatal && (res.status === 401 || res.status === 403)) {
        authFatal = true;
        error = res.message;
        break;
      }
      artifactState = "error";
      error = res.message;
      continue;
    }

    const now = new Date().toISOString();
    store.upsertScreenshotMetadata({
      ...shot,
      uploadStatus: "server_acked",
      serverAckAt: now,
      updatedAt: now,
    });
    artifactsAcked += 1;
    artifactState = "acked";
  }

  return { artifactsAcked, artifactState, error, authFatal, needsAssignmentRefresh };
}

/**
 * Contiguous from lastAck+1 only. Stops at first hole — never ACK across a gap.
 */
export function selectContiguousBatch(
  candidates: JobJournalEventRecord[],
  lastAckSequence: number
): JobJournalEventRecord[] {
  const bySeq = new Map<number, JobJournalEventRecord>();
  for (const ev of candidates) {
    if (!bySeq.has(ev.eventSequence)) bySeq.set(ev.eventSequence, ev);
  }
  const out: JobJournalEventRecord[] = [];
  let expect = lastAckSequence + 1;
  for (;;) {
    const next = bySeq.get(expect);
    if (!next) break;
    out.push(next);
    expect += 1;
  }
  return out;
}

function materializeScreenshotArtifacts(
  store: KeepAliveSqliteStore,
  tenantId: string,
  campaignId: string
): void {
  const appliedShots = store.listAppliedEventsByType(
    tenantId,
    campaignId,
    "screenshot_uploaded"
  );
  for (const ev of appliedShots) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(ev.payloadJson) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const storageKey =
      str(payload.storage_key) ??
      str(payload.storageKey) ??
      str(payload.storage_path) ??
      str(payload.storagePath) ??
      str(payload.artifact_uuid) ??
      str(payload.artifactUuid);
    const sha256 =
      str(payload.sha256) ?? str(payload.checksum) ?? str(payload.content_sha256);
    if (!storageKey || !sha256) continue;
    const existing = store.getScreenshotMetadata(ev.eventId);
    if (existing?.serverAckAt) continue;
    const now = new Date().toISOString();
    store.upsertScreenshotMetadata({
      id: ev.eventId,
      tenantId: ev.tenantId,
      campaignId: ev.campaignId,
      jobId: ev.jobId,
      attempt: ev.attempt,
      storageKey,
      sha256,
      uploadStatus: existing?.uploadStatus ?? "uploaded",
      serverAckAt: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
}

function countPendingEventAcks(
  store: KeepAliveSqliteStore,
  nodeId: string,
  tenantId: string
): number {
  let n = 0;
  for (const a of store.listAssignments(nodeId, "assigned")) {
    if (a.tenantId !== tenantId) continue;
    n += store.listPendingSyncEvents(a.tenantId, a.campaignId).filter(
      (e) => e.applyStatus === "applied"
    ).length;
  }
  return n;
}

function countPendingArtifactAcks(
  store: KeepAliveSqliteStore,
  nodeId: string,
  tenantId: string
): number {
  let n = 0;
  for (const a of store.listAssignments(nodeId, "assigned")) {
    if (a.tenantId !== tenantId) continue;
    n += store.listPendingArtifactAcks(a.tenantId, a.campaignId).length;
  }
  return n;
}

function summarizeArtifactState(
  outcomes: CampaignAckOutcome[],
  pendingCount: number
): ArtifactAckState {
  if (outcomes.some((o) => o.artifactState === "mismatch")) return "mismatch";
  if (outcomes.some((o) => o.artifactState === "unsupported")) return "unsupported";
  if (outcomes.some((o) => o.artifactState === "error")) return "error";
  if (outcomes.some((o) => o.artifactState === "not_ready")) return "not_ready";
  if (outcomes.some((o) => o.artifactState === "acked")) return "acked";
  if (pendingCount > 0) return "pending";
  return "idle";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
