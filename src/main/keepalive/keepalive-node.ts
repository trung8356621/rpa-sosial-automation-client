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

/** @deprecated Phase 1 alias — prefer KeepAliveDiagnosticsV2 */
export type KeepAliveDiagnostics = KeepAliveDiagnosticsV2;

/**
 * Keep Alive 24/7 Recovery Node — Phase 2 durable local sync engine.
 *
 * Initializes SQLite without Browser Profile.
 * Does not claim Campaigns, ACK Server, execute Jobs, or touch cookies/identity.
 */
export class KeepAliveNodeService {
  private readonly store: KeepAliveSqliteStore;
  private initialized = false;
  private nodeId: string | null = null;
  private lastRecoveryPlan: RecoveryPlan | null = null;

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

  async setEnabled(enabled: boolean): Promise<KeepAliveDiagnosticsV2> {
    await this.ensureReady();
    await this.settings.set({ keepAlive24x7Enabled: enabled });
    logClientEvent("KEEPALIVE_NODE_ENABLED_CHANGED", { enabled, nodeId: this.nodeId });
    if (enabled && this.nodeId) {
      this.lastRecoveryPlan = prepareRecovery(this.store, this.nodeId);
    }
    return this.getDiagnostics();
  }

  async getDiagnostics(): Promise<KeepAliveDiagnosticsV2> {
    await this.ensureReady();
    const stats = await this.store.getStats(this.nodeId);
    return {
      enabled: this.isEnabled(),
      storageReady: this.store.isOpen,
      nodeId: this.nodeId,
      assignedCampaignCount: stats.assignedCampaignCount,
      campaignCount: stats.campaignCount,
      jobCount: stats.jobCount,
      pendingSyncCount: stats.pendingSyncCount,
      lastAppliedSequence: stats.lastAppliedSequence,
      detectedGapCount: stats.detectedGapCount,
      lastRecoveryAttemptAt: stats.lastRecoveryAttemptAt,
      lastSyncAt: stats.lastSyncAt,
      storageBytes: stats.storageBytes,
      storageHealth: stats.storageHealth,
      dbPath: stats.dbPath,
      phase: "durable-sync-local",
      browserRequired: false,
      claimRuntimeEnabled: false,
    };
  }

  async assignCampaign(input: {
    tenantId: string;
    campaignId: string;
    assignmentGeneration: number;
    status?: "assigned" | "revoked";
  }): Promise<CampaignAssignment> {
    await this.ensureReady();
    if (!this.nodeId) throw new Error("Keep Alive node_id is not ready");
    return this.store.upsertAssignment({
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      nodeId: this.nodeId,
      assignmentGeneration: input.assignmentGeneration,
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
      // Phase 2: never invent server ACK — only persist when caller supplies a real value.
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
    this.store.close();
    this.initialized = false;
  }

  private async ensureReady(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
