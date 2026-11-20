import type { ClientStore } from "../storage/store.js";
import { logClientEvent } from "../main-error-log.js";
import type {
  CampaignSnapshotInput,
  JobJournalEventInput,
  KeepAliveDiagnosticsV2,
  RecoveryPlan,
  ScreenshotMetadataInput,
  ScreenshotMetadataRecord,
  SnapshotUpsertResult,
  JournalIngestResult,
  CampaignAssignment,
} from "./contracts.js";
import { KeepAliveSqliteStore } from "./keepalive-sqlite.js";
import { upsertCampaignSnapshot } from "./snapshot-engine.js";
import { ingestJobEvent } from "./journal-engine.js";
import { prepareRecovery } from "./recovery-engine.js";
import type { KeepAliveSyncService, KeepAliveSyncState } from "./keepalive-sync-service.js";

/** @deprecated Phase 1 alias — prefer KeepAliveDiagnosticsV2 */
export type KeepAliveDiagnostics = KeepAliveDiagnosticsV2;

/**
 * Keep Alive 24/7 Recovery Node — Phase 2 storage + Phase 3B.2 registration/assignments.
 *
 * Initializes SQLite without Browser Profile.
 * Does not claim Campaigns, ACK Job execute, or touch cookies/identity.
 */
export class KeepAliveNodeService {
  private readonly store: KeepAliveSqliteStore;
  private initialized = false;
  private nodeId: string | null = null;
  private lastRecoveryPlan: RecoveryPlan | null = null;
  private syncService: KeepAliveSyncService | null = null;

  constructor(
    private readonly userDataPath: string,
    private readonly settings: ClientStore,
    sqliteStore?: KeepAliveSqliteStore
  ) {
    this.store = sqliteStore ?? new KeepAliveSqliteStore(userDataPath);
  }

  get sqlite(): KeepAliveSqliteStore {
    return this.store;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  getNodeId(): string | null {
    return this.nodeId;
  }

  getLastRecoveryPlan(): RecoveryPlan | null {
    return this.lastRecoveryPlan;
  }

  attachSyncService(sync: KeepAliveSyncService): void {
    this.syncService = sync;
  }

  /** Public ensure for sync service (avoids private access). */
  async ensureInitializedPublic(): Promise<void> {
    await this.ensureReady();
  }

  /**
   * Open local storage + run recovery prepare. Safe with no Browser / no SEO-OPS.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.open();
    const preferred = this.settings.get().keepAliveNodeId;
    this.nodeId = this.store.getOrCreateNodeId(preferred);
    if (preferred !== this.nodeId) {
      await this.settings.set({ keepAliveNodeId: this.nodeId });
    }
    this.initialized = true;

    if (this.isEnabled()) {
      this.lastRecoveryPlan = prepareRecovery(this.store, this.nodeId);
    }

    logClientEvent("KEEPALIVE_NODE_INITIALIZED", {
      enabled: this.isEnabled(),
      dbPath: this.store.dbPath,
      nodeId: this.nodeId,
      schema: 2,
      browserRequired: false,
      recoveryPrepared: this.lastRecoveryPlan != null,
      assignedCampaigns: this.lastRecoveryPlan?.assignedCampaigns ?? 0,
    });
  }

  isEnabled(): boolean {
    return this.settings.get().keepAlive24x7Enabled === true;
  }

  /** Optional Socket.IO Gateway override from local settings (not ticket). */
  getSocketGatewayOverride(): string | null {
    const v = this.settings.get().keepAliveSocketGatewayUrl;
    return v && v.trim() ? v.trim().replace(/\/+$/, "") : null;
  }

  async setEnabled(enabled: boolean): Promise<KeepAliveDiagnosticsV2> {
    await this.ensureReady();
    await this.settings.set({ keepAlive24x7Enabled: enabled });
    logClientEvent("KEEPALIVE_NODE_ENABLED_CHANGED", { enabled, nodeId: this.nodeId });
    if (enabled && this.nodeId) {
      this.lastRecoveryPlan = prepareRecovery(this.store, this.nodeId);
    }
    if (this.syncService) {
      await this.syncService.onEnabledChanged(enabled);
    }
    return this.getDiagnostics();
  }

  async refreshAssignments(): Promise<KeepAliveDiagnosticsV2> {
    await this.ensureReady();
    if (this.syncService) {
      await this.syncService.refreshAssignments("manual");
    }
    return this.getDiagnostics();
  }

  async getDiagnostics(): Promise<KeepAliveDiagnosticsV2> {
    await this.ensureReady();
    const stats = await this.store.getStats(this.nodeId);
    const sync: KeepAliveSyncState | null = this.syncService?.getState() ?? null;
    const localAssigned = stats.assignedCampaignCount;
    return {
      enabled: this.isEnabled(),
      storageReady: this.store.isOpen,
      nodeId: this.nodeId,
      assignedCampaignCount: localAssigned,
      serverAssignmentCount: sync?.serverAssignmentCount ?? null,
      campaignCount: stats.campaignCount,
      jobCount: stats.jobCount,
      pendingSyncCount: stats.pendingSyncCount,
      lastAppliedSequence: sync?.lastSyncedSequence ?? stats.lastAppliedSequence,
      detectedGapCount: sync?.detectedGapCount ?? stats.detectedGapCount,
      lastRecoveryAttemptAt: stats.lastRecoveryAttemptAt,
      lastAssignmentRefreshAt: sync?.lastAssignmentRefreshAt ?? null,
      lastSyncAt: sync?.lastSuccessfulSyncAt ?? stats.lastSyncAt,
      lastHttpError: sync?.lastHttpError ?? null,
      registrationStatus: sync?.registrationStatus ?? (this.isEnabled() ? "idle" : "stopped"),
      localDataAvailable: stats.campaignCount > 0 || stats.jobCount > 0 || localAssigned > 0,
      serverRegistrationConfirmed: sync?.serverRegistrationConfirmed === true,
      campaignAssignmentConfirmed: sync?.campaignAssignmentConfirmed === true,
      snapshotSyncStatus: sync?.snapshotSyncStatus ?? "not_started",
      lastSyncedSequence: sync?.lastSyncedSequence ?? stats.lastAppliedSequence,
      pendingRecovery: sync?.pendingRecovery ?? stats.detectedGapCount > 0,
      lastSuccessfulSyncAt: sync?.lastSuccessfulSyncAt ?? stats.lastSyncAt,
      storageBytes: stats.storageBytes,
      storageHealth: stats.storageHealth,
      dbPath: stats.dbPath,
      phase: "socket-hints",
      browserRequired: false,
      claimRuntimeEnabled: false,
      serverDurableAck: sync?.serverDurableAck === true,
      lastServerAckSequence:
        sync?.lastServerAckSequence ?? this.store.maxServerAckSequence(this.nodeId),
      pendingAckCount: sync?.pendingAckCount ?? stats.pendingSyncCount,
      lastAckSuccessAt: sync?.lastAckSuccessAt ?? null,
      lastAckError: sync?.lastAckError ?? null,
      artifactAckState: sync?.artifactAckState ?? "idle",
      artifactAckPendingCount: sync?.artifactAckPendingCount ?? 0,
      socketStatus: sync?.socketStatus ?? "idle",
      socketConnected: sync?.socketConnected === true,
      lastSocketNotifyAt: sync?.lastSocketNotifyAt ?? null,
      socketReconnectAttempts: sync?.socketReconnectAttempts ?? 0,
      socketRouteGeneration: sync?.socketRouteGeneration ?? null,
      lastSocketError: sync?.lastSocketError ?? null,
    };
  }

  async assignCampaign(input: {
    tenantId: string;
    campaignId: string;
    assignmentGeneration: number;
    rowVersion?: number;
    status?: "assigned" | "revoked";
  }): Promise<CampaignAssignment> {
    await this.ensureReady();
    if (!this.nodeId) throw new Error("Keep Alive node_id is not ready");
    return this.store.upsertAssignment({
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      nodeId: this.nodeId,
      assignmentGeneration: input.assignmentGeneration,
      rowVersion: input.rowVersion,
      status: input.status ?? "assigned",
    });
  }

  async upsertCampaignSnapshot(input: CampaignSnapshotInput): Promise<SnapshotUpsertResult> {
    await this.ensureReady();
    if (!this.nodeId) throw new Error("Keep Alive node_id is not ready");
    return upsertCampaignSnapshot(this.store, this.nodeId, input);
  }

  async ingestJobEvent(input: JobJournalEventInput): Promise<JournalIngestResult> {
    await this.ensureReady();
    if (!this.nodeId) throw new Error("Keep Alive node_id is not ready");
    return ingestJobEvent(this.store, this.nodeId, input);
  }

  async upsertScreenshotMetadata(input: ScreenshotMetadataInput): Promise<ScreenshotMetadataRecord> {
    await this.ensureReady();
    const now = new Date().toISOString();
    const existing = this.store.getScreenshotMetadata(input.id);
    const record: ScreenshotMetadataRecord = {
      id: input.id,
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      jobId: input.jobId,
      attempt: input.attempt,
      storageKey: input.storageKey ?? existing?.storageKey ?? null,
      sha256: input.sha256 ?? existing?.sha256 ?? null,
      uploadStatus: input.uploadStatus ?? existing?.uploadStatus ?? "pending",
      serverAckAt:
        input.serverAckAt !== undefined
          ? input.serverAckAt
          : (existing?.serverAckAt ?? null),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return this.store.upsertScreenshotMetadata(record);
  }

  async runRecovery(): Promise<RecoveryPlan> {
    await this.ensureReady();
    if (!this.nodeId) throw new Error("Keep Alive node_id is not ready");
    this.lastRecoveryPlan = prepareRecovery(this.store, this.nodeId);
    logClientEvent("KEEPALIVE_RECOVERY_PREPARED", {
      recoveryId: this.lastRecoveryPlan.recoveryId,
      assignedCampaigns: this.lastRecoveryPlan.assignedCampaigns,
      requestCount: this.lastRecoveryPlan.requests.length,
      replaySocialActions: false,
    });
    return this.lastRecoveryPlan;
  }

  /** Local diagnostic marker only — does not contact Server. */
  async markLocalSyncComplete(atIso?: string): Promise<void> {
    await this.ensureReady();
    this.store.markLocalSyncComplete(atIso);
  }

  destroy(): void {
    this.syncService?.destroy();
    this.store.close();
    this.initialized = false;
  }

  private async ensureReady(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
