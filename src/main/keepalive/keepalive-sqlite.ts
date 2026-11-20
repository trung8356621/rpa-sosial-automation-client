import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  KEEPALIVE_SCHEMA_VERSION,
  type CampaignAssignment,
  type CampaignSnapshotRecord,
  type JobJournalEventRecord,
  type JournalApplyStatus,
  type JournalSyncStatus,
  type ScreenshotMetadataRecord,
  type ScreenshotUploadStatus,
  type StorageHealth,
} from "./contracts.js";

export interface CampaignCursorRow {
  tenantId: string;
  campaignId: string;
  lastAppliedSequence: number;
  lastSeenSequence: number;
  updatedAt: string;
}

export interface JobAppliedStateRow {
  tenantId: string;
  campaignId: string;
  jobId: string;
  attempt: number;
  fencingGeneration: number;
  lastEventType: string;
  lastEventSequence: number;
  updatedAt: string;
}

export interface KeepAliveStorageStats {
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
  dbPath: string;
}

const META_SCHEMA = "schema_version";
const META_NODE = "node_id";
const LAST_SYNC_CHECKPOINT = "last_sync_at";
const LAST_RECOVERY_CHECKPOINT = "last_recovery_attempt";

/**
 * Durable local SQLite for Keep Alive 24/7 (Phase 2 schema).
 * Path: `{userDataPath}/keepalive/keepalive.sqlite` — stable across restart/packaging.
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
    db.exec("PRAGMA synchronous = NORMAL;");
    this.db = db;
    this.migrateToV2();
  }

  close(): void {
    if (!this.db) return;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // best-effort
    }
    this.db.close();
    this.db = null;
  }

  /** Run fn inside a single SQLite transaction. */
  transaction<T>(fn: () => T): T {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ignore
      }
      throw err;
    }
  }

  getOrCreateNodeId(preferred?: string): string {
    const existing = this.getMeta(META_NODE);
    if (existing) return existing;
    const nodeId = preferred && preferred.trim() ? preferred.trim() : cryptoRandomId();
    this.setMeta(META_NODE, nodeId);
    return nodeId;
  }

  getNodeId(): string | null {
    return this.getMeta(META_NODE);
  }

  private migrateToV2(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS keepalive_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_checkpoints (
        checkpoint_key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const version = Number(this.getMeta(META_SCHEMA) || "0");
    if (version >= KEEPALIVE_SCHEMA_VERSION) {
      this.ensureV2Tables();
      return;
    }

    // Phase 1 → Phase 2: replace unversioned POC tables (local-only; no VPS migration).
    this.retirePhase1Tables();
    this.ensureV2Tables();
    this.setMeta(META_SCHEMA, String(KEEPALIVE_SCHEMA_VERSION));
  }

  private retirePhase1Tables(): void {
    const db = this.requireDb();
    const tables = [
      "campaign_snapshots",
      "job_execution_journal",
      "screenshot_metadata",
      "campaign_assignments",
      "campaign_cursors",
      "job_applied_state",
      "recovery_runs",
    ];
    for (const table of tables) {
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (info.length === 0) continue;
      const hasTenant = info.some((c) => c.name === "tenant_id");
      if (!hasTenant && (table === "campaign_snapshots" || table === "job_execution_journal" || table === "screenshot_metadata")) {
        db.exec(`ALTER TABLE ${table} RENAME TO ${table}_v1_retired;`);
      }
    }
  }

  private ensureV2Tables(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS campaign_assignments (
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        assignment_generation INTEGER NOT NULL,
        assigned_at TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (tenant_id, campaign_id, node_id)
      );

      CREATE TABLE IF NOT EXISTS campaign_snapshots (
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        assignment_generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, campaign_id)
      );

      CREATE TABLE IF NOT EXISTS job_execution_journal (
        event_id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        fencing_generation INTEGER NOT NULL,
        event_sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        sync_status TEXT NOT NULL DEFAULT 'pending',
        apply_status TEXT NOT NULL DEFAULT 'buffered',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ka_journal_campaign_seq
        ON job_execution_journal(tenant_id, campaign_id, event_sequence);
      CREATE INDEX IF NOT EXISTS idx_ka_journal_sync
        ON job_execution_journal(sync_status);
      CREATE INDEX IF NOT EXISTS idx_ka_journal_job
        ON job_execution_journal(tenant_id, campaign_id, job_id);

      CREATE TABLE IF NOT EXISTS campaign_cursors (
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        last_applied_sequence INTEGER NOT NULL DEFAULT 0,
        last_seen_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, campaign_id)
      );

      CREATE TABLE IF NOT EXISTS job_applied_state (
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        fencing_generation INTEGER NOT NULL,
        last_event_type TEXT NOT NULL,
        last_event_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, campaign_id, job_id)
      );

      CREATE TABLE IF NOT EXISTS screenshot_metadata (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        storage_key TEXT,
        sha256 TEXT,
        upload_status TEXT NOT NULL DEFAULT 'pending',
        server_ack_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ka_shot_job
        ON screenshot_metadata(tenant_id, campaign_id, job_id, attempt);

      CREATE TABLE IF NOT EXISTS recovery_runs (
        id TEXT PRIMARY KEY NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        plan_json TEXT NOT NULL
      );
    `);
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error("KeepAliveSqliteStore is not open");
    return this.db;
  }

  getMeta(key: string): string | null {
    const row = this.requireDb()
      .prepare(`SELECT value FROM keepalive_meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.requireDb()
      .prepare(
        `INSERT INTO keepalive_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  upsertAssignment(input: {
    tenantId: string;
    campaignId: string;
    nodeId: string;
    assignmentGeneration: number;
    status?: "assigned" | "revoked";
    assignedAt?: string;
  }): CampaignAssignment {
    const assignedAt = input.assignedAt ?? new Date().toISOString();
    const status = input.status ?? "assigned";
    this.requireDb()
      .prepare(
        `INSERT INTO campaign_assignments
          (tenant_id, campaign_id, node_id, assignment_generation, assigned_at, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, campaign_id, node_id) DO UPDATE SET
           assignment_generation = excluded.assignment_generation,
           assigned_at = excluded.assigned_at,
           status = excluded.status`
      )
      .run(
        input.tenantId,
        input.campaignId,
        input.nodeId,
        input.assignmentGeneration,
        assignedAt,
        status
      );
    return {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      nodeId: input.nodeId,
      assignmentGeneration: input.assignmentGeneration,
      assignedAt,
      status,
    };
  }

  getAssignment(tenantId: string, campaignId: string, nodeId: string): CampaignAssignment | null {
    const row = this.requireDb()
      .prepare(
        `SELECT tenant_id AS tenantId, campaign_id AS campaignId, node_id AS nodeId,
                assignment_generation AS assignmentGeneration, assigned_at AS assignedAt, status
         FROM campaign_assignments
         WHERE tenant_id = ? AND campaign_id = ? AND node_id = ?`
      )
      .get(tenantId, campaignId, nodeId) as CampaignAssignment | undefined;
    return row ?? null;
  }

  listAssignments(nodeId: string, status: "assigned" | "revoked" = "assigned"): CampaignAssignment[] {
    return this.requireDb()
      .prepare(
        `SELECT tenant_id AS tenantId, campaign_id AS campaignId, node_id AS nodeId,
                assignment_generation AS assignmentGeneration, assigned_at AS assignedAt, status
         FROM campaign_assignments
         WHERE node_id = ? AND status = ?
         ORDER BY assigned_at ASC`
      )
      .all(nodeId, status) as unknown as CampaignAssignment[];
  }

  insertSnapshot(row: CampaignSnapshotRecord): void {
    this.requireDb()
      .prepare(
        `INSERT INTO campaign_snapshots
          (tenant_id, campaign_id, snapshot_version, sequence, assignment_generation, updated_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, campaign_id) DO UPDATE SET
           snapshot_version = excluded.snapshot_version,
           sequence = excluded.sequence,
           assignment_generation = excluded.assignment_generation,
           updated_at = excluded.updated_at,
           metadata_json = excluded.metadata_json`
      )
      .run(
        row.tenantId,
        row.campaignId,
        row.snapshotVersion,
        row.sequence,
        row.assignmentGeneration,
        row.updatedAt,
        row.metadataJson
      );
  }

  getSnapshot(tenantId: string, campaignId: string): CampaignSnapshotRecord | null {
    const row = this.requireDb()
      .prepare(
        `SELECT tenant_id AS tenantId, campaign_id AS campaignId,
                snapshot_version AS snapshotVersion, sequence,
                assignment_generation AS assignmentGeneration,
                updated_at AS updatedAt, metadata_json AS metadataJson
         FROM campaign_snapshots WHERE tenant_id = ? AND campaign_id = ?`
      )
      .get(tenantId, campaignId) as
      | (Omit<CampaignSnapshotRecord, "metadata"> & { metadataJson: string })
      | undefined;
    if (!row) return null;
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    return { ...row, metadata };
  }

  listSnapshots(): CampaignSnapshotRecord[] {
    const rows = this.requireDb()
      .prepare(
        `SELECT tenant_id AS tenantId, campaign_id AS campaignId,
                snapshot_version AS snapshotVersion, sequence,
                assignment_generation AS assignmentGeneration,
                updated_at AS updatedAt, metadata_json AS metadataJson
         FROM campaign_snapshots`
      )
      .all() as Array<Omit<CampaignSnapshotRecord, "metadata"> & { metadataJson: string }>;
    return rows.map((row) => {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
      return { ...row, metadata };
    });
  }

  getJournalEvent(eventId: string): JobJournalEventRecord | null {
    const row = this.requireDb()
      .prepare(
        `SELECT event_id AS eventId, tenant_id AS tenantId, campaign_id AS campaignId,
                job_id AS jobId, attempt, fencing_generation AS fencingGeneration,
                event_sequence AS eventSequence, event_type AS eventType,
                timestamp, payload_version AS payloadVersion, payload_json AS payloadJson,
                sync_status AS syncStatus, apply_status AS applyStatus, created_at AS createdAt
         FROM job_execution_journal WHERE event_id = ?`
      )
      .get(eventId) as JobJournalEventRecord | undefined;
    return row ?? null;
  }

  insertJournalEvent(row: JobJournalEventRecord): boolean {
    const result = this.requireDb()
      .prepare(
        `INSERT OR IGNORE INTO job_execution_journal
          (event_id, tenant_id, campaign_id, job_id, attempt, fencing_generation,
           event_sequence, event_type, timestamp, payload_version, payload_json,
           sync_status, apply_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.eventId,
        row.tenantId,
        row.campaignId,
        row.jobId,
        row.attempt,
        row.fencingGeneration,
        row.eventSequence,
        row.eventType,
        row.timestamp,
        row.payloadVersion,
        row.payloadJson,
        row.syncStatus,
        row.applyStatus,
        row.createdAt
      );
    return Number(result.changes) > 0;
  }

  updateJournalApplyStatus(eventId: string, applyStatus: JournalApplyStatus): void {
    this.requireDb()
      .prepare(`UPDATE job_execution_journal SET apply_status = ? WHERE event_id = ?`)
      .run(applyStatus, eventId);
  }

  listJournalSequences(tenantId: string, campaignId: string): number[] {
    const rows = this.requireDb()
      .prepare(
        `SELECT event_sequence AS seq FROM job_execution_journal
         WHERE tenant_id = ? AND campaign_id = ?
         ORDER BY event_sequence ASC`
      )
      .all(tenantId, campaignId) as Array<{ seq: number }>;
    return rows.map((r) => Number(r.seq));
  }

  listBufferedEvents(tenantId: string, campaignId: string): JobJournalEventRecord[] {
    return this.requireDb()
      .prepare(
        `SELECT event_id AS eventId, tenant_id AS tenantId, campaign_id AS campaignId,
                job_id AS jobId, attempt, fencing_generation AS fencingGeneration,
                event_sequence AS eventSequence, event_type AS eventType,
                timestamp, payload_version AS payloadVersion, payload_json AS payloadJson,
                sync_status AS syncStatus, apply_status AS applyStatus, created_at AS createdAt
         FROM job_execution_journal
         WHERE tenant_id = ? AND campaign_id = ? AND apply_status = 'buffered'
         ORDER BY event_sequence ASC`
      )
      .all(tenantId, campaignId) as unknown as JobJournalEventRecord[];
  }

  listPendingSyncEvents(tenantId?: string, campaignId?: string): JobJournalEventRecord[] {
    if (tenantId && campaignId) {
      return this.requireDb()
        .prepare(
          `SELECT event_id AS eventId, tenant_id AS tenantId, campaign_id AS campaignId,
                  job_id AS jobId, attempt, fencing_generation AS fencingGeneration,
                  event_sequence AS eventSequence, event_type AS eventType,
                  timestamp, payload_version AS payloadVersion, payload_json AS payloadJson,
                  sync_status AS syncStatus, apply_status AS applyStatus, created_at AS createdAt
           FROM job_execution_journal
           WHERE tenant_id = ? AND campaign_id = ? AND sync_status = 'pending'
           ORDER BY event_sequence ASC`
        )
        .all(tenantId, campaignId) as unknown as JobJournalEventRecord[];
    }
    return this.requireDb()
      .prepare(
        `SELECT event_id AS eventId, tenant_id AS tenantId, campaign_id AS campaignId,
                job_id AS jobId, attempt, fencing_generation AS fencingGeneration,
                event_sequence AS eventSequence, event_type AS eventType,
                timestamp, payload_version AS payloadVersion, payload_json AS payloadJson,
                sync_status AS syncStatus, apply_status AS applyStatus, created_at AS createdAt
         FROM job_execution_journal
         WHERE sync_status = 'pending'
         ORDER BY created_at ASC`
      )
      .all() as unknown as JobJournalEventRecord[];
  }

  getCursor(tenantId: string, campaignId: string): CampaignCursorRow | null {
    const row = this.requireDb()
      .prepare(
        `SELECT tenant_id AS tenantId, campaign_id AS campaignId,
                last_applied_sequence AS lastAppliedSequence,
                last_seen_sequence AS lastSeenSequence, updated_at AS updatedAt
         FROM campaign_cursors WHERE tenant_id = ? AND campaign_id = ?`
      )
      .get(tenantId, campaignId) as CampaignCursorRow | undefined;
    return row ?? null;
  }

  upsertCursor(row: CampaignCursorRow): void {
    this.requireDb()
      .prepare(
        `INSERT INTO campaign_cursors
          (tenant_id, campaign_id, last_applied_sequence, last_seen_sequence, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, campaign_id) DO UPDATE SET
           last_applied_sequence = excluded.last_applied_sequence,
           last_seen_sequence = excluded.last_seen_sequence,
           updated_at = excluded.updated_at`
      )
      .run(row.tenantId, row.campaignId, row.lastAppliedSequence, row.lastSeenSequence, row.updatedAt);
  }

  getJobState(tenantId: string, campaignId: string, jobId: string): JobAppliedStateRow | null {
    const row = this.requireDb()
      .prepare(
        `SELECT tenant_id AS tenantId, campaign_id AS campaignId, job_id AS jobId,
                attempt, fencing_generation AS fencingGeneration,
                last_event_type AS lastEventType, last_event_sequence AS lastEventSequence,
                updated_at AS updatedAt
         FROM job_applied_state
         WHERE tenant_id = ? AND campaign_id = ? AND job_id = ?`
      )
      .get(tenantId, campaignId, jobId) as JobAppliedStateRow | undefined;
    return row ?? null;
  }

  upsertJobState(row: JobAppliedStateRow): void {
    this.requireDb()
      .prepare(
        `INSERT INTO job_applied_state
          (tenant_id, campaign_id, job_id, attempt, fencing_generation,
           last_event_type, last_event_sequence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, campaign_id, job_id) DO UPDATE SET
           attempt = excluded.attempt,
           fencing_generation = excluded.fencing_generation,
           last_event_type = excluded.last_event_type,
           last_event_sequence = excluded.last_event_sequence,
           updated_at = excluded.updated_at`
      )
      .run(
        row.tenantId,
        row.campaignId,
        row.jobId,
        row.attempt,
        row.fencingGeneration,
        row.lastEventType,
        row.lastEventSequence,
        row.updatedAt
      );
  }

  upsertScreenshotMetadata(row: ScreenshotMetadataRecord): ScreenshotMetadataRecord {
    this.requireDb()
      .prepare(
        `INSERT INTO screenshot_metadata
          (id, tenant_id, campaign_id, job_id, attempt, storage_key, sha256,
           upload_status, server_ack_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           campaign_id = excluded.campaign_id,
           job_id = excluded.job_id,
           attempt = excluded.attempt,
           storage_key = excluded.storage_key,
           sha256 = excluded.sha256,
           upload_status = excluded.upload_status,
           server_ack_at = excluded.server_ack_at,
           updated_at = excluded.updated_at`
      )
      .run(
        row.id,
        row.tenantId,
        row.campaignId,
        row.jobId,
        row.attempt,
        row.storageKey,
        row.sha256,
        row.uploadStatus,
        row.serverAckAt,
        row.createdAt,
        row.updatedAt
      );
    return row;
  }

  getScreenshotMetadata(id: string): ScreenshotMetadataRecord | null {
    const row = this.requireDb()
      .prepare(
        `SELECT id, tenant_id AS tenantId, campaign_id AS campaignId, job_id AS jobId,
                attempt, storage_key AS storageKey, sha256,
                upload_status AS uploadStatus, server_ack_at AS serverAckAt,
                created_at AS createdAt, updated_at AS updatedAt
         FROM screenshot_metadata WHERE id = ?`
      )
      .get(id) as ScreenshotMetadataRecord | undefined;
    return row ?? null;
  }

  listPendingScreenshots(tenantId: string, campaignId: string): ScreenshotMetadataRecord[] {
    return this.requireDb()
      .prepare(
        `SELECT id, tenant_id AS tenantId, campaign_id AS campaignId, job_id AS jobId,
                attempt, storage_key AS storageKey, sha256,
                upload_status AS uploadStatus, server_ack_at AS serverAckAt,
                created_at AS createdAt, updated_at AS updatedAt
         FROM screenshot_metadata
         WHERE tenant_id = ? AND campaign_id = ?
           AND (server_ack_at IS NULL OR upload_status IN ('pending', 'uploaded', 'failed'))
         ORDER BY created_at ASC`
      )
      .all(tenantId, campaignId) as unknown as ScreenshotMetadataRecord[];
  }

  setSyncCheckpoint(checkpointKey: string, value: unknown): void {
    const updatedAt = new Date().toISOString();
    const valueJson = typeof value === "string" ? value : JSON.stringify(value ?? null);
    this.requireDb()
      .prepare(
        `INSERT INTO sync_checkpoints (checkpoint_key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(checkpoint_key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(checkpointKey, valueJson, updatedAt);
  }

  getSyncCheckpoint(checkpointKey: string): { checkpointKey: string; valueJson: string; updatedAt: string } | null {
    const row = this.requireDb()
      .prepare(
        `SELECT checkpoint_key AS checkpointKey, value_json AS valueJson, updated_at AS updatedAt
         FROM sync_checkpoints WHERE checkpoint_key = ?`
      )
      .get(checkpointKey) as { checkpointKey: string; valueJson: string; updatedAt: string } | undefined;
    return row ?? null;
  }

  markLocalSyncComplete(atIso?: string): void {
    this.setSyncCheckpoint(LAST_SYNC_CHECKPOINT, { at: atIso ?? new Date().toISOString() });
  }

  markRecoveryAttempt(atIso: string, recoveryId: string): void {
    this.setSyncCheckpoint(LAST_RECOVERY_CHECKPOINT, { at: atIso, recoveryId });
  }

  saveRecoveryRun(id: string, startedAt: string, finishedAt: string, planJson: string): void {
    this.requireDb()
      .prepare(
        `INSERT INTO recovery_runs (id, started_at, finished_at, status, plan_json)
         VALUES (?, ?, ?, 'prepared', ?)
         ON CONFLICT(id) DO UPDATE SET
           finished_at = excluded.finished_at,
           status = excluded.status,
           plan_json = excluded.plan_json`
      )
      .run(id, startedAt, finishedAt, planJson);
  }

  async getStats(nodeId: string | null): Promise<KeepAliveStorageStats> {
    const db = this.requireDb();
    const assignedCampaignCount = nodeId
      ? Number(
          (
            db
              .prepare(
                `SELECT COUNT(*) AS c FROM campaign_assignments WHERE node_id = ? AND status = 'assigned'`
              )
              .get(nodeId) as { c: number }
          ).c
        )
      : 0;
    const campaignCount = Number(
      (db.prepare(`SELECT COUNT(*) AS c FROM campaign_snapshots`).get() as { c: number }).c
    );
    const jobCount = Number(
      (
        db.prepare(`SELECT COUNT(DISTINCT job_id) AS c FROM job_execution_journal`).get() as {
          c: number;
        }
      ).c
    );
    const pendingSyncCount = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS c FROM job_execution_journal WHERE sync_status = 'pending'`)
          .get() as { c: number }
      ).c
    );

    const cursorAgg = db
      .prepare(
        `SELECT MAX(last_applied_sequence) AS maxApplied FROM campaign_cursors`
      )
      .get() as { maxApplied: number | null };
    const lastAppliedSequence =
      cursorAgg.maxApplied == null ? null : Number(cursorAgg.maxApplied);

    // Gap estimate: per-campaign missing integers between 1..last_seen not present in journal.
    let detectedGapCount = 0;
    const cursors = db
      .prepare(
        `SELECT tenant_id AS tenantId, campaign_id AS campaignId,
                last_applied_sequence AS lastAppliedSequence,
                last_seen_sequence AS lastSeenSequence
         FROM campaign_cursors`
      )
      .all() as Array<{
      tenantId: string;
      campaignId: string;
      lastAppliedSequence: number;
      lastSeenSequence: number;
    }>;
    for (const c of cursors) {
      detectedGapCount += countGaps(
        this.listJournalSequences(c.tenantId, c.campaignId),
        Number(c.lastSeenSequence)
      ).length;
    }

    let lastSyncAt: string | null = null;
    const syncCp = this.getSyncCheckpoint(LAST_SYNC_CHECKPOINT);
    if (syncCp) {
      try {
        const parsed = JSON.parse(syncCp.valueJson) as { at?: string };
        lastSyncAt = typeof parsed.at === "string" ? parsed.at : syncCp.updatedAt;
      } catch {
        lastSyncAt = syncCp.updatedAt;
      }
    }

    let lastRecoveryAttemptAt: string | null = null;
    const recoveryCp = this.getSyncCheckpoint(LAST_RECOVERY_CHECKPOINT);
    if (recoveryCp) {
      try {
        const parsed = JSON.parse(recoveryCp.valueJson) as { at?: string };
        lastRecoveryAttemptAt =
          typeof parsed.at === "string" ? parsed.at : recoveryCp.updatedAt;
      } catch {
        lastRecoveryAttemptAt = recoveryCp.updatedAt;
      }
    }

    let storageBytes = 0;
    let storageHealth: StorageHealth = "ok";
    try {
      const st = await stat(this.dbPath);
      storageBytes = st.size;
      for (const suffix of ["-wal", "-shm"]) {
        try {
          storageBytes += (await stat(this.dbPath + suffix)).size;
        } catch {
          // optional
        }
      }
    } catch {
      storageBytes = 0;
      storageHealth = "unavailable";
    }

    if (storageHealth === "ok" && detectedGapCount > 0) {
      storageHealth = "degraded";
    }

    return {
      assignedCampaignCount,
      campaignCount,
      jobCount,
      pendingSyncCount,
      lastAppliedSequence,
      detectedGapCount,
      lastRecoveryAttemptAt,
      lastSyncAt,
      storageBytes,
      storageHealth,
      dbPath: this.dbPath,
    };
  }
}

export function countGaps(sequences: number[], lastSeenSequence: number): Array<{ from: number; to: number }> {
  const set = new Set(sequences.map((n) => Number(n)));
  const gaps: Array<{ from: number; to: number }> = [];
  if (lastSeenSequence < 1) return gaps;
  let gapStart: number | null = null;
  for (let seq = 1; seq <= lastSeenSequence; seq++) {
    if (!set.has(seq)) {
      if (gapStart == null) gapStart = seq;
    } else if (gapStart != null) {
      gaps.push({ from: gapStart, to: seq - 1 });
      gapStart = null;
    }
  }
  if (gapStart != null) {
    gaps.push({ from: gapStart, to: lastSeenSequence });
  }
  return gaps;
}

function cryptoRandomId(): string {
  return `ka-node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Re-export legacy-compatible type aliases used by older imports during transition.
export type { JournalSyncStatus, ScreenshotUploadStatus };
