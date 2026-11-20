import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CampaignSnapshotRow {
  campaignId: string;
  payloadJson: string;
  updatedAt: string;
}

export interface JobJournalEvent {
  eventId: string;
  jobId: string;
  attemptId?: string | null;
  eventType: string;
  payloadJson?: string;
  syncStatus?: "pending" | "synced";
  createdAt?: string;
}

export interface SyncCheckpointRow {
  checkpointKey: string;
  valueJson: string;
  updatedAt: string;
}

export interface ScreenshotMetadataRow {
  id: string;
  jobId?: string | null;
  filePath?: string | null;
  metaJson?: string;
  createdAt?: string;
}

export interface KeepAliveStorageStats {
  campaignCount: number;
  jobCount: number;
  pendingSyncCount: number;
  lastSyncAt: string | null;
  storageBytes: number;
  dbPath: string;
}

const LAST_SYNC_CHECKPOINT = "last_sync_at";

/**
 * Durable local SQLite for Keep Alive 24/7 Recovery Node (Phase 1).
 * Independent of Browser Profile / Chromium session partitions.
 */
export class KeepAliveSqliteStore {
  readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(userDataPath: string) {
    this.dbPath = path.join(userDataPath, "keepalive", "keepalive.sqlite");
  }

  get isOpen(): boolean {
    return this.db != null;
  }

  async open(): Promise<void> {
    if (this.db) return;
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS campaign_snapshots (
        campaign_id TEXT PRIMARY KEY NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_execution_journal (
        event_id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL,
        attempt_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        sync_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_job_journal_job_id
        ON job_execution_journal(job_id);
      CREATE INDEX IF NOT EXISTS idx_job_journal_sync_status
        ON job_execution_journal(sync_status);

      CREATE TABLE IF NOT EXISTS sync_checkpoints (
        checkpoint_key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS screenshot_metadata (
        id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT,
        file_path TEXT,
        meta_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
    this.db = db;
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("KeepAliveSqliteStore is not open");
    }
    return this.db;
  }

  upsertCampaignSnapshot(campaignId: string, payload: unknown): CampaignSnapshotRow {
    const db = this.requireDb();
    const updatedAt = new Date().toISOString();
    const payloadJson = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
    db.prepare(
      `INSERT INTO campaign_snapshots (campaign_id, payload_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(campaign_id) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`
    ).run(campaignId, payloadJson, updatedAt);
    return { campaignId, payloadJson, updatedAt };
  }

  getCampaignSnapshot(campaignId: string): CampaignSnapshotRow | null {
    const row = this.requireDb()
      .prepare(
        `SELECT campaign_id AS campaignId, payload_json AS payloadJson, updated_at AS updatedAt
         FROM campaign_snapshots WHERE campaign_id = ?`
      )
      .get(campaignId) as CampaignSnapshotRow | undefined;
    return row ?? null;
  }

  /**
   * Append a journal event. Duplicate event_id is ignored (idempotent).
   * @returns true if inserted, false if duplicate.
   */
  appendJournalEvent(event: JobJournalEvent): boolean {
    const db = this.requireDb();
    const createdAt = event.createdAt ?? new Date().toISOString();
    const payloadJson = event.payloadJson ?? "{}";
    const syncStatus = event.syncStatus ?? "pending";
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO job_execution_journal
          (event_id, job_id, attempt_id, event_type, payload_json, sync_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.eventId,
        event.jobId,
        event.attemptId ?? null,
        event.eventType,
        payloadJson,
        syncStatus,
        createdAt
      );
    return Number(result.changes) > 0;
  }

  getJournalEvent(eventId: string): JobJournalEvent | null {
    const row = this.requireDb()
      .prepare(
        `SELECT event_id AS eventId, job_id AS jobId, attempt_id AS attemptId,
                event_type AS eventType, payload_json AS payloadJson,
                sync_status AS syncStatus, created_at AS createdAt
         FROM job_execution_journal WHERE event_id = ?`
      )
      .get(eventId) as JobJournalEvent | undefined;
    return row ?? null;
  }

  setSyncCheckpoint(checkpointKey: string, value: unknown): SyncCheckpointRow {
    const db = this.requireDb();
    const updatedAt = new Date().toISOString();
    const valueJson = typeof value === "string" ? value : JSON.stringify(value ?? null);
    db.prepare(
      `INSERT INTO sync_checkpoints (checkpoint_key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(checkpoint_key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`
    ).run(checkpointKey, valueJson, updatedAt);
    return { checkpointKey, valueJson, updatedAt };
  }

  getSyncCheckpoint(checkpointKey: string): SyncCheckpointRow | null {
    const row = this.requireDb()
      .prepare(
        `SELECT checkpoint_key AS checkpointKey, value_json AS valueJson, updated_at AS updatedAt
         FROM sync_checkpoints WHERE checkpoint_key = ?`
      )
      .get(checkpointKey) as SyncCheckpointRow | undefined;
    return row ?? null;
  }

  /** Local-only marker for diagnostics; does not contact Server. */
  markLocalSyncComplete(atIso?: string): SyncCheckpointRow {
    const at = atIso ?? new Date().toISOString();
    return this.setSyncCheckpoint(LAST_SYNC_CHECKPOINT, { at });
  }

  upsertScreenshotMetadata(row: ScreenshotMetadataRow): ScreenshotMetadataRow {
    const db = this.requireDb();
    const createdAt = row.createdAt ?? new Date().toISOString();
    const metaJson = row.metaJson ?? "{}";
    db.prepare(
      `INSERT INTO screenshot_metadata (id, job_id, file_path, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         job_id = excluded.job_id,
         file_path = excluded.file_path,
         meta_json = excluded.meta_json,
         created_at = excluded.created_at`
    ).run(row.id, row.jobId ?? null, row.filePath ?? null, metaJson, createdAt);
    return {
      id: row.id,
      jobId: row.jobId ?? null,
      filePath: row.filePath ?? null,
      metaJson,
      createdAt,
    };
  }

  getScreenshotMetadata(id: string): ScreenshotMetadataRow | null {
    const row = this.requireDb()
      .prepare(
        `SELECT id, job_id AS jobId, file_path AS filePath, meta_json AS metaJson, created_at AS createdAt
         FROM screenshot_metadata WHERE id = ?`
      )
      .get(id) as ScreenshotMetadataRow | undefined;
    return row ?? null;
  }

  async getStats(): Promise<KeepAliveStorageStats> {
    const db = this.requireDb();
    const campaignCount = Number(
      (db.prepare(`SELECT COUNT(*) AS c FROM campaign_snapshots`).get() as { c: number }).c
    );
    const jobCount = Number(
      (db.prepare(`SELECT COUNT(DISTINCT job_id) AS c FROM job_execution_journal`).get() as { c: number }).c
    );
    const pendingSyncCount = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS c FROM job_execution_journal WHERE sync_status = 'pending'`)
          .get() as { c: number }
      ).c
    );

    let lastSyncAt: string | null = null;
    const checkpoint = this.getSyncCheckpoint(LAST_SYNC_CHECKPOINT);
    if (checkpoint) {
      try {
        const parsed = JSON.parse(checkpoint.valueJson) as { at?: string };
        lastSyncAt = typeof parsed.at === "string" ? parsed.at : checkpoint.updatedAt;
      } catch {
        lastSyncAt = checkpoint.updatedAt;
      }
    }

    let storageBytes = 0;
    try {
      const st = await stat(this.dbPath);
      storageBytes = st.size;
      for (const suffix of ["-wal", "-shm"]) {
        try {
          const extra = await stat(this.dbPath + suffix);
          storageBytes += extra.size;
        } catch {
          // optional sidecar
        }
      }
    } catch {
      storageBytes = 0;
    }

    return {
      campaignCount,
      jobCount,
      pendingSyncCount,
      lastSyncAt,
      storageBytes,
      dbPath: this.dbPath,
    };
  }
}
