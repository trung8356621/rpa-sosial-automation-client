import {
  JOB_EVENT_TYPES,
  KEEPALIVE_EVENT_PAYLOAD_VERSION,
  type JobEventType,
  type JobJournalEventInput,
  type JobJournalEventRecord,
  type JournalIngestResult,
} from "./contracts.js";
import type { KeepAliveSqliteStore } from "./keepalive-sqlite.js";

function isJobEventType(value: string): value is JobEventType {
  return (JOB_EVENT_TYPES as readonly string[]).includes(value);
}

function validateEvent(input: JobJournalEventInput): string | null {
  if (!input.eventId?.trim()) return "event_id is required";
  if (!input.tenantId?.trim() || !input.campaignId?.trim() || !input.jobId?.trim()) {
    return "tenant_id, campaign_id, and job_id are required";
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1) return "attempt must be >= 1";
  if (!Number.isInteger(input.fencingGeneration) || input.fencingGeneration < 1) {
    return "fencing_generation must be >= 1";
  }
  if (!Number.isInteger(input.eventSequence) || input.eventSequence < 1) {
    return "event_sequence must be >= 1";
  }
  if (!isJobEventType(input.eventType)) return `unsupported event_type: ${input.eventType}`;
  return null;
}

function toRecord(
  input: JobJournalEventInput,
  applyStatus: JobJournalEventRecord["applyStatus"]
): JobJournalEventRecord {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    eventId: input.eventId.trim(),
    tenantId: input.tenantId.trim(),
    campaignId: input.campaignId.trim(),
    jobId: input.jobId.trim(),
    attempt: input.attempt,
    fencingGeneration: input.fencingGeneration,
    eventSequence: input.eventSequence,
    eventType: input.eventType,
    timestamp,
    payloadVersion: input.payloadVersion ?? KEEPALIVE_EVENT_PAYLOAD_VERSION,
    payloadJson: JSON.stringify(input.payload ?? {}),
    syncStatus: "pending",
    applyStatus,
    createdAt: timestamp,
  };
}

function isStaleAgainstJobState(
  store: KeepAliveSqliteStore,
  input: JobJournalEventInput
): string | null {
  const state = store.getJobState(input.tenantId, input.campaignId, input.jobId);
  if (!state) return null;
  if (input.fencingGeneration < state.fencingGeneration) {
    return "Older fencing_generation cannot overwrite newer job state";
  }
  if (
    input.fencingGeneration === state.fencingGeneration &&
    input.attempt < state.attempt
  ) {
    return "Older attempt cannot overwrite newer job state";
  }
  return null;
}

function applyEventToState(store: KeepAliveSqliteStore, event: JobJournalEventRecord): void {
  const now = new Date().toISOString();
  store.updateJournalApplyStatus(event.eventId, "applied");

  const cursor = store.getCursor(event.tenantId, event.campaignId);
  const lastApplied = cursor?.lastAppliedSequence ?? 0;
  const lastSeen = Math.max(cursor?.lastSeenSequence ?? 0, event.eventSequence);
  store.upsertCursor({
    tenantId: event.tenantId,
    campaignId: event.campaignId,
    lastAppliedSequence: Math.max(lastApplied, event.eventSequence),
    lastSeenSequence: lastSeen,
    updatedAt: now,
  });

  const existing = store.getJobState(event.tenantId, event.campaignId, event.jobId);
  const shouldWrite =
    !existing ||
    event.fencingGeneration > existing.fencingGeneration ||
    (event.fencingGeneration === existing.fencingGeneration && event.attempt >= existing.attempt);

  if (shouldWrite) {
    store.upsertJobState({
      tenantId: event.tenantId,
      campaignId: event.campaignId,
      jobId: event.jobId,
      attempt: event.attempt,
      fencingGeneration: event.fencingGeneration,
      lastEventType: event.eventType,
      lastEventSequence: event.eventSequence,
      updatedAt: now,
    });
  }
}

function bumpSeen(store: KeepAliveSqliteStore, input: JobJournalEventInput): void {
  const cursor = store.getCursor(input.tenantId, input.campaignId);
  const now = new Date().toISOString();
  store.upsertCursor({
    tenantId: input.tenantId,
    campaignId: input.campaignId,
    lastAppliedSequence: cursor?.lastAppliedSequence ?? 0,
    lastSeenSequence: Math.max(cursor?.lastSeenSequence ?? 0, input.eventSequence),
    updatedAt: now,
  });
}

function drainBuffered(store: KeepAliveSqliteStore, tenantId: string, campaignId: string): void {
  // Contiguous apply after a successful apply — never executes Jobs.
  for (;;) {
    const cursor = store.getCursor(tenantId, campaignId);
    const expected = (cursor?.lastAppliedSequence ?? 0) + 1;
    const buffered = store.listBufferedEvents(tenantId, campaignId);
    const next = buffered.find((e) => e.eventSequence === expected);
    if (!next) break;

    const stale = isStaleAgainstJobState(store, {
      eventId: next.eventId,
      tenantId: next.tenantId,
      campaignId: next.campaignId,
      jobId: next.jobId,
      attempt: next.attempt,
      fencingGeneration: next.fencingGeneration,
      eventSequence: next.eventSequence,
      eventType: next.eventType,
    });
    if (stale) {
      store.updateJournalApplyStatus(next.eventId, "rejected_stale");
      // Skip this sequence hole for drain; recovery will request re-sync if needed.
      store.upsertCursor({
        tenantId,
        campaignId,
        lastAppliedSequence: expected,
        lastSeenSequence: Math.max(cursor?.lastSeenSequence ?? 0, expected),
        updatedAt: new Date().toISOString(),
      });
      continue;
    }
    applyEventToState(store, { ...next, applyStatus: "applied" });
  }
}

/**
 * Durable Job event ingest.
 * Stores events locally; applies in order; never grants Job execution permission.
 */
export function ingestJobEvent(
  store: KeepAliveSqliteStore,
  nodeId: string,
  input: JobJournalEventInput
): JournalIngestResult {
  const invalid = validateEvent(input);
  if (invalid) {
    return { ok: false, status: "rejected_invalid", message: invalid };
  }
  return store.transaction(() => ingestJobEventUnlocked(store, nodeId, input));
}

/**
 * Ingest a page of events in one SQLite transaction.
 * Cursor advances only for successfully applied contiguous sequences inside the txn.
 */
export function ingestJobEventBatch(
  store: KeepAliveSqliteStore,
  nodeId: string,
  inputs: JobJournalEventInput[]
): JournalIngestResult[] {
  return store.transaction(() => {
    const results: JournalIngestResult[] = [];
    for (const input of inputs) {
      const invalid = validateEvent(input);
      if (invalid) {
        results.push({ ok: false, status: "rejected_invalid", message: invalid });
        continue;
      }
      results.push(ingestJobEventUnlocked(store, nodeId, input));
    }
    return results;
  });
}

function ingestJobEventUnlocked(
  store: KeepAliveSqliteStore,
  nodeId: string,
  input: JobJournalEventInput
): JournalIngestResult {
  const existing = store.getJournalEvent(input.eventId);
  if (existing) {
    return { ok: true, status: "duplicate", event: existing };
  }

  const assignment = store.getAssignment(input.tenantId, input.campaignId, nodeId);
  if (!assignment || assignment.status !== "assigned") {
    const rejected = toRecord(input, "rejected_unauthorized");
    store.insertJournalEvent(rejected);
    return {
      ok: false,
      status: "rejected_unauthorized",
      message: "Campaign is not assigned to this Keep Alive node",
      event: rejected,
    };
  }

  const stale = isStaleAgainstJobState(store, input);
  if (stale) {
    const rejected = toRecord(input, "rejected_stale");
    store.insertJournalEvent(rejected);
    bumpSeen(store, input);
    return { ok: false, status: "rejected_stale", message: stale, event: rejected };
  }

  const cursor = store.getCursor(input.tenantId, input.campaignId);
  const expected = (cursor?.lastAppliedSequence ?? 0) + 1;

  if (input.eventSequence < expected) {
    const rejected = toRecord(input, "rejected_stale");
    store.insertJournalEvent(rejected);
    bumpSeen(store, input);
    return {
      ok: false,
      status: "rejected_stale",
      message: "Event sequence is behind last applied sequence",
      event: rejected,
    };
  }

  if (input.eventSequence > expected) {
    const buffered = toRecord(input, "buffered");
    store.insertJournalEvent(buffered);
    bumpSeen(store, input);
    return { ok: true, status: "buffered", event: buffered };
  }

  const applied = toRecord(input, "applied");
  store.insertJournalEvent(applied);
  applyEventToState(store, applied);
  drainBuffered(store, input.tenantId, input.campaignId);
  return { ok: true, status: "applied", event: store.getJournalEvent(input.eventId) ?? applied };
}
