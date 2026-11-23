import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CampaignJobResultRequest } from "./contracts.js";
import type { FailureScreenshotArtifact } from "./failure-screenshot.js";

export type AttemptLifecycleState =
  | "executing"
  | "terminal_pending_delivery"
  | "terminal_acknowledged";

export type PersistedAttemptRecord = {
  jobId: string;
  attemptId: string;
  state: AttemptLifecycleState;
  status: string;
  code: string;
  message: string;
  at: string;
  startedAt: string;
  finishedAt?: string;
  acknowledgedAt?: string;
  pendingPayload?: CampaignJobResultRequest;
  localScreenshotArtifact?: FailureScreenshotArtifact | null;
  localScreenshotArtifacts?: FailureScreenshotArtifact[];
  deliveryAttempts: number;
  nextRetryAt?: number;
  lastDeliveryStatus?: number;
  lastDeliveryErrors?: string[];
  lastDeliveryMessage?: string;
  deliveryStopped?: boolean;
};

const MAX_RECORDS = 500;

/**
 * Durable local attempt fence: separates execution from result delivery.
 * Once an attempt executes or reaches a terminal outcome, it must never re-execute
 * merely because result delivery failed or Electron restarted.
 */
export class JobAttemptIdempotencyStore {
  private readonly records = new Map<string, PersistedAttemptRecord>();

  constructor(private readonly storagePath?: string) {
    if (this.storagePath) {
      this.loadFromDisk();
    }
  }

  key(jobId: string, attemptId: string): string {
    return `${jobId}::${attemptId}`;
  }

  hasTerminal(jobId: string, attemptId: string): boolean {
    const rec = this.records.get(this.key(jobId, attemptId));
    if (!rec) return false;
    return (
      rec.state === "terminal_acknowledged" ||
      rec.state === "terminal_pending_delivery" ||
      rec.state === "executing"
    );
  }

  get(jobId: string, attemptId: string): PersistedAttemptRecord | null {
    return this.records.get(this.key(jobId, attemptId)) ?? null;
  }

  markExecuting(jobId: string, attemptId: string): PersistedAttemptRecord {
    const now = new Date().toISOString();
    const rec: PersistedAttemptRecord = {
      jobId,
      attemptId,
      state: "executing",
      status: "unknown",
      code: "EXECUTING",
      message: "Attempt execution in progress.",
      at: now,
      startedAt: now,
      deliveryAttempts: 0,
    };
    this.records.set(this.key(jobId, attemptId), rec);
    this.persist();
    return rec;
  }

  markTerminalPending(
    jobId: string,
    attemptId: string,
    params: {
      status: string;
      code: string;
      message: string;
      payload: CampaignJobResultRequest;
      localScreenshotArtifact?: FailureScreenshotArtifact | null;
      localScreenshotArtifacts?: FailureScreenshotArtifact[];
    }
  ): PersistedAttemptRecord {
    const now = new Date().toISOString();
    const prev = this.records.get(this.key(jobId, attemptId));
    const rec: PersistedAttemptRecord = {
      jobId,
      attemptId,
      state: "terminal_pending_delivery",
      status: params.status,
      code: params.code,
      message: params.message,
      at: now,
      startedAt: prev?.startedAt ?? now,
      finishedAt: now,
      pendingPayload: params.payload,
      localScreenshotArtifact:
        params.localScreenshotArtifact !== undefined
          ? params.localScreenshotArtifact
          : (prev?.localScreenshotArtifact ?? null),
      ...(params.localScreenshotArtifacts !== undefined
        ? { localScreenshotArtifacts: params.localScreenshotArtifacts }
        : prev?.localScreenshotArtifacts !== undefined
          ? { localScreenshotArtifacts: prev.localScreenshotArtifacts }
          : {}),
      deliveryAttempts: prev?.deliveryAttempts ?? 0,
      deliveryStopped: false,
    };
    this.records.set(this.key(jobId, attemptId), rec);
    this.persist();
    return rec;
  }

  markTerminalAcknowledged(
    jobId: string,
    attemptId: string,
    meta?: { lastDeliveryStatus?: number }
  ): PersistedAttemptRecord | null {
    const k = this.key(jobId, attemptId);
    const prev = this.records.get(k);
    const now = new Date().toISOString();
    const rec: PersistedAttemptRecord = prev
      ? {
          ...prev,
          state: "terminal_acknowledged",
          at: now,
          acknowledgedAt: now,
          nextRetryAt: undefined,
          lastDeliveryStatus: meta?.lastDeliveryStatus ?? 200,
          lastDeliveryErrors: undefined,
          lastDeliveryMessage: undefined,
          deliveryStopped: false,
        }
      : {
          jobId,
          attemptId,
          state: "terminal_acknowledged",
          status: "unknown",
          code: "OK",
          message: "",
          at: now,
          startedAt: now,
          finishedAt: now,
          acknowledgedAt: now,
          deliveryAttempts: 1,
          lastDeliveryStatus: meta?.lastDeliveryStatus ?? 200,
        };
    this.records.set(k, rec);
    this.persist();
    return rec;
  }

  recordDeliveryFailure(
    jobId: string,
    attemptId: string,
    failure: {
      status: number;
      errors: string[];
      message: string;
      permanent: boolean;
      nextRetryAt?: number;
      payloadWithoutArtifacts?: CampaignJobResultRequest;
    }
  ): PersistedAttemptRecord | null {
    const k = this.key(jobId, attemptId);
    const prev = this.records.get(k);
    if (!prev) return null;
    const rec: PersistedAttemptRecord = {
      ...prev,
      state: "terminal_pending_delivery",
      deliveryAttempts: prev.deliveryAttempts + 1,
      lastDeliveryStatus: failure.status,
      lastDeliveryErrors: failure.errors,
      lastDeliveryMessage: failure.message,
      nextRetryAt: failure.permanent ? undefined : failure.nextRetryAt,
      deliveryStopped: failure.permanent,
      ...(failure.payloadWithoutArtifacts ? { pendingPayload: failure.payloadWithoutArtifacts } : {}),
    };
    this.records.set(k, rec);
    this.persist();
    return rec;
  }

  /** Backward-compatible helper used by existing tests. */
  markTerminal(jobId: string, attemptId: string, status: string): void {
    const k = this.key(jobId, attemptId);
    const prev = this.records.get(k);
    const now = new Date().toISOString();
    this.records.set(k, {
      jobId,
      attemptId,
      state: "terminal_acknowledged",
      status,
      code: prev?.code ?? status,
      message: prev?.message ?? "",
      at: now,
      startedAt: prev?.startedAt ?? now,
      finishedAt: prev?.finishedAt ?? now,
      acknowledgedAt: now,
      deliveryAttempts: prev?.deliveryAttempts ?? 0,
      localScreenshotArtifact: prev?.localScreenshotArtifact ?? null,
    });
    this.persist();
  }

  listPendingDelivery(now = Date.now()): PersistedAttemptRecord[] {
    const out: PersistedAttemptRecord[] = [];
    for (const rec of this.records.values()) {
      if (rec.state !== "terminal_pending_delivery") continue;
      if (rec.deliveryStopped) continue;
      if (rec.nextRetryAt && now < rec.nextRetryAt) continue;
      if (!rec.pendingPayload) continue;
      out.push(rec);
    }
    return out;
  }

  clear(): void {
    this.records.clear();
    this.persist();
  }

  private loadFromDisk(): void {
    if (!this.storagePath || !existsSync(this.storagePath)) return;
    try {
      const raw = readFileSync(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as { records?: PersistedAttemptRecord[] };
      if (!Array.isArray(parsed?.records)) return;
      let mutated = false;
      for (const rec of parsed.records) {
        if (!rec?.jobId || !rec?.attemptId) continue;
        // Any record left in "executing" across an Electron restart must never replay execution.
        if (rec.state === "executing") {
          mutated = true;
          this.records.set(this.key(rec.jobId, rec.attemptId), {
            ...rec,
            state: "terminal_pending_delivery",
            status: "unknown",
            code: "INTERRUPTED_UNKNOWN",
            message: "Client restarted before attempt completed; refusing duplicate execution.",
            finishedAt: new Date().toISOString(),
            deliveryStopped: true,
          });
        } else {
          this.records.set(this.key(rec.jobId, rec.attemptId), rec);
        }
      }
      if (mutated) {
        this.persist();
      }
    } catch {
      // Corrupt file should not crash startup; start with empty map.
    }
  }

  private persist(): void {
    if (!this.storagePath) return;
    try {
      const dir = path.dirname(this.storagePath);
      mkdirSync(dir, { recursive: true });
      const all = Array.from(this.records.values());
      const trimmed = all.length > MAX_RECORDS ? all.slice(all.length - MAX_RECORDS) : all;
      const tmp = `${this.storagePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ records: trimmed }, null, 2), "utf8");
      renameSync(tmp, this.storagePath);
    } catch {
      // Best-effort atomic write; in-memory fence remains active.
    }
  }
}
