import { logClientEvent, logClientError } from "../main-error-log.js";
import {
  JOB_EVENT_TYPES,
  type JobEventType,
  type JobJournalEventInput,
  type KeepAliveSnapshotSyncStatus,
} from "./contracts.js";
import { countGaps, type KeepAliveSqliteStore } from "./keepalive-sqlite.js";
import {
  KEEPALIVE_EVENTS_PAGE_LIMIT,
  type KeepAliveHttpApi,
  type KeepAliveHttpResult,
  type KeepAliveSnapshotResponse,
  type KeepAliveWireEvent,
} from "./keepalive-http-api.js";
import { upsertCampaignSnapshot } from "./snapshot-engine.js";
import { ingestJobEventBatch } from "./journal-engine.js";

const MAX_EVENT_PAGES = 50;

export interface CampaignDataSyncOutcome {
  campaignId: string;
  snapshotOk: boolean;
  eventsIngested: number;
  eventsSkippedTransient: number;
  pages: number;
  lastAppliedSequence: number;
  eventSequenceHead: number | null;
  gapCount: number;
  pendingRecovery: boolean;
  error: string | null;
  staleGeneration: boolean;
  authFatal: boolean;
}

export interface MultiCampaignSyncSummary {
  outcomes: CampaignDataSyncOutcome[];
  snapshotSyncStatus: KeepAliveSnapshotSyncStatus;
  lastSyncedSequence: number | null;
  detectedGapCount: number;
  pendingRecovery: boolean;
  lastSuccessfulSyncAt: string | null;
  lastHttpError: string | null;
  needsAssignmentRefresh: boolean;
}

/**
 * Fetch + persist snapshot and durable event feed for one assigned Campaign.
 * Never claims/executes Jobs. Does not advance cursor past missing sequences.
 * event_sequence_head is a gap hint only — never treated as local persistence proof.
 */
export async function syncAssignedCampaignData(
  api: KeepAliveHttpApi,
  store: KeepAliveSqliteStore,
  params: {
    nodeId: string;
    tenantId: string;
    campaignId: string;
    assignmentGeneration: number;
  }
): Promise<CampaignDataSyncOutcome> {
  const base: CampaignDataSyncOutcome = {
    campaignId: params.campaignId,
    snapshotOk: false,
    eventsIngested: 0,
    eventsSkippedTransient: 0,
    pages: 0,
    lastAppliedSequence: store.getCursor(params.tenantId, params.campaignId)?.lastAppliedSequence ?? 0,
    eventSequenceHead: null,
    gapCount: 0,
    pendingRecovery: false,
    error: null,
    staleGeneration: false,
    authFatal: false,
  };

  const assignment = store.getAssignment(params.tenantId, params.campaignId, params.nodeId);
  if (!assignment || assignment.status !== "assigned") {
    return {
      ...base,
      error: "Campaign chưa được assign — bỏ qua snapshot/events.",
    };
  }

  const snap = await api.fetchSnapshot({
    campaignId: params.campaignId,
    nodeId: params.nodeId,
    assignmentGeneration: params.assignmentGeneration,
  });
  if (!snap.ok) {
    return mapFetchFailure(base, snap);
  }
  if (snap.data.tenantId !== params.tenantId) {
    return {
      ...base,
      error: "Snapshot tenant_id lệch assignment tenant.",
      authFatal: true,
    };
  }

  const persisted = upsertCampaignSnapshot(store, params.nodeId, {
    tenantId: snap.data.tenantId,
    campaignId: snap.data.campaignId,
    snapshotVersion: snap.data.snapshotVersion,
    sequence: snap.data.sequence,
    assignmentGeneration: snap.data.assignmentGeneration,
    updatedAt: snap.data.updatedAt ?? undefined,
    metadata: snap.data.metadata,
  });
  if (!persisted.ok) {
    return {
      ...base,
      error: `Snapshot reject: ${persisted.reason} — ${persisted.message}`,
      staleGeneration: persisted.reason === "stale",
    };
  }
  base.snapshotOk = true;
  base.eventSequenceHead = snap.data.eventSequenceHead;

  // Record head as last_seen hint only when higher — does NOT advance last_applied.
  maybeNoteEventHead(store, params.tenantId, params.campaignId, snap.data.eventSequenceHead);

  const feed = await pullAndIngestEvents(api, store, {
    ...params,
    assignmentGeneration: snap.data.assignmentGeneration,
  });
  Object.assign(base, feed);

  const cursor = store.getCursor(params.tenantId, params.campaignId);
  base.lastAppliedSequence = cursor?.lastAppliedSequence ?? 0;
  const sequences = store.listJournalSequences(params.tenantId, params.campaignId);
  const lastSeen = Math.max(
    cursor?.lastSeenSequence ?? 0,
    base.eventSequenceHead ?? 0,
    sequences.length ? Math.max(...sequences) : 0
  );
  // Gap vs what we have locally — include head only as upper bound hint for missing ranges.
  base.gapCount = countGaps(sequences, lastSeen).length;
  base.pendingRecovery = base.gapCount > 0;
  if (base.eventSequenceHead != null && base.lastAppliedSequence < base.eventSequenceHead) {
    // Head ahead of applied may be lazy projection OR unread pages — mark recovery, do not fake sync.
    if (base.gapCount === 0 && base.eventSequenceHead > base.lastAppliedSequence) {
      base.pendingRecovery = true;
      // Document: server may advertise event_sequence_head before events are queryable (lazy projection).
      logClientEvent("KEEPALIVE_EVENT_HEAD_AHEAD_OF_LOCAL", {
        campaignId: params.campaignId,
        lastApplied: base.lastAppliedSequence,
        eventSequenceHead: base.eventSequenceHead,
        note: "head_is_hint_only_not_persistence_proof",
      });
    }
  }

  // Gap fill pass: request explicit missing ranges (bounded).
  if (base.gapCount > 0) {
    const gaps = countGaps(sequences, lastSeen);
    for (const gap of gaps.slice(0, 5)) {
      const fill = await pullAndIngestEvents(api, store, {
        ...params,
        assignmentGeneration: snap.data.assignmentGeneration,
        fromSequence: gap.from,
        toSequence: gap.to,
      });
      base.eventsIngested += fill.eventsIngested;
      base.pages += fill.pages;
      if (fill.error) {
        base.error = fill.error;
        base.staleGeneration = fill.staleGeneration;
        base.authFatal = fill.authFatal;
        break;
      }
    }
    const after = store.getCursor(params.tenantId, params.campaignId);
    base.lastAppliedSequence = after?.lastAppliedSequence ?? base.lastAppliedSequence;
    const seq2 = store.listJournalSequences(params.tenantId, params.campaignId);
    const seen2 = Math.max(after?.lastSeenSequence ?? 0, base.eventSequenceHead ?? 0);
    base.gapCount = countGaps(seq2, seen2).length;
    base.pendingRecovery = base.gapCount > 0 || (base.eventSequenceHead != null && base.lastAppliedSequence < base.eventSequenceHead);
  }

  return base;
}

export async function syncAllAssignedCampaignData(
  api: KeepAliveHttpApi,
  store: KeepAliveSqliteStore,
  nodeId: string,
  tenantId: string
): Promise<MultiCampaignSyncSummary> {
  const assigned = store.listAssignments(nodeId, "assigned").filter((a) => a.tenantId === tenantId);
  const outcomes: CampaignDataSyncOutcome[] = [];
  let needsAssignmentRefresh = false;
  let lastHttpError: string | null = null;
  let anyOk = false;
  let anyFail = false;

  for (const row of assigned) {
    const out = await syncAssignedCampaignData(api, store, {
      nodeId,
      tenantId,
      campaignId: row.campaignId,
      assignmentGeneration: row.assignmentGeneration,
    });
    outcomes.push(out);
    if (out.staleGeneration) needsAssignmentRefresh = true;
    if (out.error) {
      anyFail = true;
      lastHttpError = out.error;
    }
    if (out.snapshotOk) anyOk = true;
    if (out.authFatal) {
      lastHttpError = out.error;
      break;
    }
  }

  const lastSyncedSequence = outcomes.reduce<number | null>((max, o) => {
    if (!o.snapshotOk && o.eventsIngested === 0) return max;
    const v = o.lastAppliedSequence;
    if (max == null) return v;
    return Math.max(max, v);
  }, null);

  const detectedGapCount = outcomes.reduce((n, o) => n + o.gapCount, 0);
  const pendingRecovery = outcomes.some((o) => o.pendingRecovery);
  const lastSuccessfulSyncAt =
    anyOk && !outcomes.every((o) => o.error && !o.snapshotOk)
      ? new Date().toISOString()
      : null;

  let snapshotSyncStatus: KeepAliveSnapshotSyncStatus = "idle";
  if (assigned.length === 0) snapshotSyncStatus = "idle";
  else if (anyOk && !anyFail && !pendingRecovery) snapshotSyncStatus = "synced";
  else if (anyOk && (anyFail || pendingRecovery)) snapshotSyncStatus = "partial";
  else if (anyFail) snapshotSyncStatus = "error";
  else snapshotSyncStatus = "idle";

  return {
    outcomes,
    snapshotSyncStatus,
    lastSyncedSequence,
    detectedGapCount,
    pendingRecovery,
    lastSuccessfulSyncAt,
    lastHttpError,
    needsAssignmentRefresh,
  };
}

async function pullAndIngestEvents(
  api: KeepAliveHttpApi,
  store: KeepAliveSqliteStore,
  params: {
    nodeId: string;
    tenantId: string;
    campaignId: string;
    assignmentGeneration: number;
    fromSequence?: number;
    toSequence?: number;
  }
): Promise<Pick<
  CampaignDataSyncOutcome,
  | "eventsIngested"
  | "eventsSkippedTransient"
  | "pages"
  | "eventSequenceHead"
  | "error"
  | "staleGeneration"
  | "authFatal"
  | "lastAppliedSequence"
>> {
  let cursor: string | null = null;
  let pages = 0;
  let eventsIngested = 0;
  let eventsSkippedTransient = 0;
  let eventSequenceHead: number | null = null;
  const fromSequence =
    params.fromSequence ??
    (store.getCursor(params.tenantId, params.campaignId)?.lastAppliedSequence ?? 0) + 1;

  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const res = await api.fetchEvents({
      campaignId: params.campaignId,
      nodeId: params.nodeId,
      assignmentGeneration: params.assignmentGeneration,
      fromSequence: cursor ? undefined : fromSequence,
      toSequence: params.toSequence,
      cursor,
      limit: KEEPALIVE_EVENTS_PAGE_LIMIT,
    });
    if (!res.ok) {
      return {
        ...mapFetchFailure(
          {
            campaignId: params.campaignId,
            snapshotOk: false,
            eventsIngested,
            eventsSkippedTransient,
            pages,
            lastAppliedSequence:
              store.getCursor(params.tenantId, params.campaignId)?.lastAppliedSequence ?? 0,
            eventSequenceHead,
            gapCount: 0,
            pendingRecovery: false,
            error: null,
            staleGeneration: false,
            authFatal: false,
          },
          res
        ),
        eventsIngested,
        eventsSkippedTransient,
        pages,
        eventSequenceHead,
        lastAppliedSequence:
          store.getCursor(params.tenantId, params.campaignId)?.lastAppliedSequence ?? 0,
      };
    }

    if (res.data.tenantId !== params.tenantId) {
      return {
        eventsIngested,
        eventsSkippedTransient,
        pages,
        eventSequenceHead,
        error: "Events feed tenant_id lệch assignment tenant.",
        staleGeneration: false,
        authFatal: true,
        lastAppliedSequence:
          store.getCursor(params.tenantId, params.campaignId)?.lastAppliedSequence ?? 0,
      };
    }

    pages += 1;
    eventSequenceHead = res.data.eventSequenceHead ?? eventSequenceHead;
    maybeNoteEventHead(store, params.tenantId, params.campaignId, res.data.eventSequenceHead);

    const durable: JobJournalEventInput[] = [];
    for (const ev of res.data.events) {
      if (!isDurableEventType(ev.eventType)) {
        eventsSkippedTransient += 1;
        logClientEvent("KEEPALIVE_SKIP_TRANSIENT_EVENT", {
          eventId: ev.eventId,
          eventType: ev.eventType,
          eventSequence: ev.eventSequence,
          note: "transient_not_in_durable_sequence_contract",
        });
        continue;
      }
      durable.push(wireToInput(ev));
    }

    if (durable.length > 0) {
      // Single SQLite transaction per page — cursor only commits if txn succeeds.
      const results = ingestJobEventBatch(store, params.nodeId, durable);
      eventsIngested += results.filter((r) => r.ok && r.status === "applied").length;
    }

    if (!res.data.hasMore || !res.data.nextCursor) break;
    // Duplicate page guard
    if (cursor && res.data.nextCursor === cursor) break;
    cursor = res.data.nextCursor;
    if (res.data.events.length === 0 && !res.data.hasMore) break;
  }

  return {
    eventsIngested,
    eventsSkippedTransient,
    pages,
    eventSequenceHead,
    error: null,
    staleGeneration: false,
    authFatal: false,
    lastAppliedSequence:
      store.getCursor(params.tenantId, params.campaignId)?.lastAppliedSequence ?? 0,
  };
}

function wireToInput(ev: KeepAliveWireEvent): JobJournalEventInput {
  return {
    eventId: ev.eventId,
    tenantId: ev.tenantId,
    campaignId: ev.campaignId,
    jobId: ev.jobId,
    attempt: ev.attempt,
    fencingGeneration: ev.fencingGeneration,
    eventSequence: ev.eventSequence,
    eventType: ev.eventType as JobEventType,
    timestamp: ev.timestamp ?? undefined,
    payloadVersion: ev.payloadVersion,
    payload: ev.payload,
  };
}

function isDurableEventType(type: string): type is JobEventType {
  return (JOB_EVENT_TYPES as readonly string[]).includes(type);
}

function maybeNoteEventHead(
  store: KeepAliveSqliteStore,
  tenantId: string,
  campaignId: string,
  head: number | null
): void {
  if (head == null || head < 1) return;
  const cursor = store.getCursor(tenantId, campaignId);
  const lastApplied = cursor?.lastAppliedSequence ?? 0;
  const lastSeen = cursor?.lastSeenSequence ?? 0;
  if (head <= lastSeen) return;
  // Raise last_seen only — never last_applied. Head is not persistence proof.
  store.upsertCursor({
    tenantId,
    campaignId,
    lastAppliedSequence: lastApplied,
    lastSeenSequence: head,
    updatedAt: new Date().toISOString(),
  });
}

function mapFetchFailure(
  base: CampaignDataSyncOutcome,
  res: KeepAliveHttpResult<KeepAliveSnapshotResponse> | KeepAliveHttpResult<never>
): CampaignDataSyncOutcome {
  if (res.ok) return base;
  logClientError(
    "KEEPALIVE_CAMPAIGN_DATA_FETCH_FAILED",
    new Error(`${res.code} status=${res.status}: ${res.message}`)
  );
  return {
    ...base,
    error: res.message,
    staleGeneration: res.code === "assignment_generation_stale",
    authFatal: res.fatal && (res.status === 401 || res.status === 403),
  };
}
