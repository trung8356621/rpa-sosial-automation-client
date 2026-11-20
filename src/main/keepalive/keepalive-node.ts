import type { ClientStore } from "../storage/store.js";
import { logClientEvent } from "../main-error-log.js";
import {
  KeepAliveSqliteStore,
  type JobJournalEvent,
  type ScreenshotMetadataRow,
} from "./keepalive-sqlite.js";

export interface KeepAliveDiagnostics {
  enabled: boolean;
  storageReady: boolean;
  campaignCount: number;
  jobCount: number;
  pendingSyncCount: number;
  lastSyncAt: string | null;
  storageBytes: number;
  dbPath: string | null;
  /** Phase 1: local recovery node only — no claim/ACK/execute. */
  phase: "local-poc";
  browserRequired: false;
}

/**
 * Keep Alive 24/7 Recovery Node — Phase 1 local POC.
 *
 * Initializes durable SQLite and settings without opening a Browser Profile.
 * Does not claim Campaigns, ACK Server, or touch Browser cookies / identity.
 */
export class KeepAliveNodeService {
  private readonly store: KeepAliveSqliteStore;
  private initialized = false;

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

  /**
   * Open local storage. Safe with no Browser Profile and no SEO-OPS connection.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.open();
    this.initialized = true;
    const enabled = this.isEnabled();
    logClientEvent("KEEPALIVE_NODE_INITIALIZED", {
      enabled,
      dbPath: this.store.dbPath,
      browserRequired: false,
    });
  }

  isEnabled(): boolean {
    return this.settings.get().keepAlive24x7Enabled === true;
  }

  async setEnabled(enabled: boolean): Promise<KeepAliveDiagnostics> {
    await this.ensureReady();
    await this.settings.set({ keepAlive24x7Enabled: enabled });
    logClientEvent("KEEPALIVE_NODE_ENABLED_CHANGED", { enabled });
    return this.getDiagnostics();
  }

  async getDiagnostics(): Promise<KeepAliveDiagnostics> {
    await this.ensureReady();
    const stats = await this.store.getStats();
    return {
      enabled: this.isEnabled(),
      storageReady: this.store.isOpen,
      campaignCount: stats.campaignCount,
      jobCount: stats.jobCount,
      pendingSyncCount: stats.pendingSyncCount,
      lastSyncAt: stats.lastSyncAt,
      storageBytes: stats.storageBytes,
      dbPath: stats.dbPath,
      phase: "local-poc",
      browserRequired: false,
    };
  }

  async upsertCampaignSnapshot(campaignId: string, payload: unknown) {
    await this.ensureReady();
    return this.store.upsertCampaignSnapshot(campaignId, payload);
  }

  async appendJournalEvent(event: JobJournalEvent): Promise<boolean> {
    await this.ensureReady();
    return this.store.appendJournalEvent(event);
  }

  async setSyncCheckpoint(checkpointKey: string, value: unknown) {
    await this.ensureReady();
    return this.store.setSyncCheckpoint(checkpointKey, value);
  }

  async markLocalSyncComplete(atIso?: string) {
    await this.ensureReady();
    return this.store.markLocalSyncComplete(atIso);
  }

  async upsertScreenshotMetadata(row: ScreenshotMetadataRow) {
    await this.ensureReady();
    return this.store.upsertScreenshotMetadata(row);
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
