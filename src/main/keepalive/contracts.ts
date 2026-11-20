/**
 * Keep Alive 24/7 durable sync contracts (CLIENT local-first).
 * Phase 3B.5B: durable Event/Artifact delivery ACK (not Job claim/execute).
 */

export const KEEPALIVE_SCHEMA_VERSION = 2;
export const KEEPALIVE_PROTOCOL_VERSION = "keepalive.v1";
export const KEEPALIVE_SNAPSHOT_PAYLOAD_VERSION = 1;
export const KEEPALIVE_EVENT_PAYLOAD_VERSION = 1;
export const KEEPALIVE_CAPABILITIES = ["observe", "store", "recover"] as const;

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

/** pending = locally applied, awaiting server delivery ACK; server_acked = server confirmed. */
export type JournalSyncStatus = "pending" | "ack_local" | "server_acked";

export type ScreenshotUploadStatus =
  | "pending"
  | "uploaded"
  | "ack_local"
  | "server_acked"
  | "failed"
  | "unsupported";

export type ArtifactAckState =
  | "idle"
  | "pending"
  | "acked"
  | "not_ready"
  | "unsupported"
  | "mismatch"
  | "error";

/** Socket.IO connection status for Keep Alive realtime hints (not durable sync). */
export type KeepAliveSocketStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "auth_blocked"
  | "protocol_mismatch"
  | "stopped";

/** Realtime notification event names (hints only). */
export const KEEPALIVE_SOCKET_EVENTS = [
  "ka.notify",
  "ka.assignment_changed",
  "ka.route_invalidated",
  "ka.recover_hint",
] as const;

export type KeepAliveSocketEventName = (typeof KEEPALIVE_SOCKET_EVENTS)[number];

export const KEEPALIVE_SOCKET_PATH_DEFAULT = "/keepalive/socket.io/";

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
  /** Server-owned optimistic concurrency token (0 if unknown). */
  rowVersion: number;
  assignedAt: string;
  status: "assigned" | "revoked";
}

export type KeepAliveRegistrationStatus =
  | "idle"
  | "registered"
  | "error"
  | "stopped"
  | "auth_blocked"
  | "protocol_mismatch"
  | "offline";

/**
 * Snapshot + durable event sync status.
 * Never report fake server ACK PASS — "synced" means local persistence only.
 */
export type KeepAliveSnapshotSyncStatus =
  | "idle"
  | "syncing"
  | "synced"
  | "partial"
  | "error"
  | "not_started";

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
  /**
   * When true, entry is a recovery-plan marker.
   * Phase 3B.5B sends durable ACKs after SQLite commit (not via this flag alone).
   */
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
  /** Explicit local assignments (status=assigned). */
  assignedCampaignCount: number;
  /** Server-reported count from last successful assignments fetch. */
  serverAssignmentCount: number | null;
  campaignCount: number;
  jobCount: number;
  pendingSyncCount: number;
  lastAppliedSequence: number | null;
  detectedGapCount: number;
  lastRecoveryAttemptAt: string | null;
  lastAssignmentRefreshAt: string | null;
  lastSyncAt: string | null;
  lastHttpError: string | null;
  registrationStatus: KeepAliveRegistrationStatus;
  localDataAvailable: boolean;
  serverRegistrationConfirmed: boolean;
  campaignAssignmentConfirmed: boolean;
  snapshotSyncStatus: KeepAliveSnapshotSyncStatus;
  /** Max last_applied_sequence across assigned campaigns after sync. */
  lastSyncedSequence: number | null;
  pendingRecovery: boolean;
  lastSuccessfulSyncAt: string | null;
  storageBytes: number;
  storageHealth: StorageHealth;
  dbPath: string | null;
  phase: "socket-hints";
  browserRequired: false;
  claimRuntimeEnabled: false;
  /**
   * True only when Client has confirmed at least one server delivery ACK.
   * Local persistence alone never sets this.
   */
  serverDurableAck: boolean;
  /** Max server-confirmed ACK sequence (separate from lastAppliedSequence). */
  lastServerAckSequence: number | null;
  pendingAckCount: number;
  lastAckSuccessAt: string | null;
  lastAckError: string | null;
  artifactAckState: ArtifactAckState;
  artifactAckPendingCount: number;
  socketStatus: KeepAliveSocketStatus;
  socketConnected: boolean;
  lastSocketNotifyAt: string | null;
  socketReconnectAttempts: number;
  socketRouteGeneration: number | null;
  lastSocketError: string | null;
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
