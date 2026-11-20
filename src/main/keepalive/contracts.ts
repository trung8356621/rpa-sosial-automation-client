/**
 * Keep Alive 24/7 durable sync contracts (CLIENT local-first, Phase 2).
 * No Server ACK / claim / execute semantics.
 */

export const KEEPALIVE_SCHEMA_VERSION = 2;
export const KEEPALIVE_SNAPSHOT_PAYLOAD_VERSION = 1;
export const KEEPALIVE_EVENT_PAYLOAD_VERSION = 1;

export const JOB_EVENT_TYPES = [
  "job_reserved",
  "job_claimed",
  "job_started",
  "job_completed",
  "job_failed",
  "job_unknown",
  "screenshot_uploaded",
] as const;

export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

export type JournalApplyStatus =
  | "applied"
  | "duplicate"
  | "buffered"
  | "rejected_stale"
  | "rejected_unauthorized"
  | "rejected_invalid";

export type JournalSyncStatus = "pending" | "ack_local";

export type ScreenshotUploadStatus = "pending" | "uploaded" | "ack_local" | "failed";

/** Keys forbidden in Campaign snapshot metadata (secrets / browser identity). */
export const SENSITIVE_SNAPSHOT_KEYS = [
  "cookie",
  "cookies",
  "access_token",
  "refresh_token",
  "password",
  "passwd",
  "secret",
  "secrets",
  "credential",
  "credentials",
  "authorization",
  "auth_token",
  "session_token",
  "api_key",
  "private_key",
  "browser_secret",
  "browser_cookies",
] as const;

export interface CampaignAssignment {
  tenantId: string;
  campaignId: string;
  nodeId: string;
  assignmentGeneration: number;
  assignedAt: string;
  status: "assigned" | "revoked";
}

export interface CampaignSnapshotInput {
  tenantId: string;
  campaignId: string;
  snapshotVersion: number;
  sequence: number;
  assignmentGeneration: number;
  updatedAt?: string;
  /** Non-sensitive Campaign metadata only. */
  metadata: Record<string, unknown>;
}

export interface CampaignSnapshotRecord extends CampaignSnapshotInput {
  updatedAt: string;
  metadataJson: string;
}

export interface JobJournalEventInput {
  eventId: string;
  tenantId: string;
  campaignId: string;
  jobId: string;
  attempt: number;
  fencingGeneration: number;
  eventSequence: number;
  eventType: JobEventType;
  timestamp?: string;
  payloadVersion?: number;
  payload?: Record<string, unknown>;
}

export interface JobJournalEventRecord {
  eventId: string;
  tenantId: string;
  campaignId: string;
  jobId: string;
  attempt: number;
  fencingGeneration: number;
  eventSequence: number;
  eventType: JobEventType;
  timestamp: string;
  payloadVersion: number;
  payloadJson: string;
  syncStatus: JournalSyncStatus;
  applyStatus: JournalApplyStatus;
  createdAt: string;
}

export interface ScreenshotMetadataInput {
  id: string;
  tenantId: string;
  campaignId: string;
  jobId: string;
  attempt: number;
  storageKey?: string | null;
  sha256?: string | null;
  uploadStatus?: ScreenshotUploadStatus;
  serverAckAt?: string | null;
}

export interface ScreenshotMetadataRecord {
  id: string;
  tenantId: string;
  campaignId: string;
  jobId: string;
  attempt: number;
  storageKey: string | null;
  sha256: string | null;
  uploadStatus: ScreenshotUploadStatus;
  serverAckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SequenceGap {
  tenantId: string;
  campaignId: string;
  fromSequence: number;
  toSequence: number;
}

export interface RecoveryRequest {
  type: "fetch_event_sequences" | "fetch_campaign_snapshot" | "ack_pending_sync";
  tenantId: string;
  campaignId: string;
  fromSequence?: number;
  toSequence?: number;
  /** Prepared locally only — Phase 2 does not send these. */
  preparedOnly: true;
}

export interface CampaignRecoveryState {
  tenantId: string;
  campaignId: string;
  lastAppliedSequence: number;
  lastSeenSequence: number;
  gaps: SequenceGap[];
  pendingSyncEventIds: string[];
  pendingScreenshotIds: string[];
}

export interface RecoveryPlan {
  recoveryId: string;
  startedAt: string;
  finishedAt: string;
  status: "prepared";
  assignedCampaigns: number;
  campaigns: CampaignRecoveryState[];
  requests: RecoveryRequest[];
  /** Explicit: no social-action replay. */
  replaySocialActions: false;
}

export type StorageHealth = "ok" | "degraded" | "unavailable";

export interface KeepAliveDiagnosticsV2 {
  enabled: boolean;
  storageReady: boolean;
  nodeId: string | null;
  /** Explicit assignments only — not every Campaign. */
  assignedCampaignCount: number;
  campaignCount: number;
  jobCount: number;
  pendingSyncCount: number;
  lastAppliedSequence: number | null;
  detectedGapCount: number;
  lastRecoveryAttemptAt: string | null;
  lastSyncAt: string | null;
  storageBytes: number;
  storageHealth: StorageHealth;
  dbPath: string | null;
  phase: "durable-sync-local";
  browserRequired: false;
  claimRuntimeEnabled: false;
}

export type SnapshotUpsertResult =
  | { ok: true; snapshot: CampaignSnapshotRecord }
  | {
      ok: false;
      reason: "stale" | "unauthorized" | "tenant_mismatch" | "sensitive_payload" | "invalid";
      message: string;
    };

export type JournalIngestResult =
  | { ok: true; status: "applied" | "duplicate" | "buffered"; event: JobJournalEventRecord }
  | {
      ok: false;
      status: "rejected_stale" | "rejected_unauthorized" | "rejected_invalid";
      message: string;
      event?: JobJournalEventRecord;
    };
