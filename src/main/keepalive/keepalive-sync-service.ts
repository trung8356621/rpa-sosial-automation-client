import type { ClientConnection } from "../connection/client-connection.js";
import { logClientError, logClientEvent } from "../main-error-log.js";
import type {
  ArtifactAckState,
  KeepAliveRegistrationStatus,
  KeepAliveSnapshotSyncStatus,
  KeepAliveSocketStatus,
} from "./contracts.js";
import { flushDurableAcks } from "./ack-engine.js";
import { applyServerAssignments, revokeAllActiveAssignments } from "./assignment-apply.js";
import { syncAllAssignedCampaignData } from "./campaign-data-sync.js";
import { KeepAliveHttpApi } from "./keepalive-http-api.js";
import type { KeepAliveNodeService } from "./keepalive-node.js";
import {
  KeepAliveSocketClient,
  type KeepAliveSocketFactory,
  type KeepAliveSocketHint,
} from "./keepalive-socket-client.js";

/** HTTP catch-up remains durable path; Socket.IO only reduces latency of the same sync. */
const PERIODIC_REFRESH_MS = 5 * 60_000;
const RETRY_INITIAL_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const RETRY_MAX_ATTEMPTS = 5;

export interface KeepAliveSyncState {
  registrationStatus: KeepAliveRegistrationStatus;
  serverAssignmentCount: number | null;
  lastAssignmentRefreshAt: string | null;
  lastHttpError: string | null;
  serverRegistrationConfirmed: boolean;
  campaignAssignmentConfirmed: boolean;
  serverTenantId: string | null;
  snapshotSyncStatus: KeepAliveSnapshotSyncStatus;
  lastSyncedSequence: number | null;
  pendingRecovery: boolean;
  lastSuccessfulSyncAt: string | null;
  detectedGapCount: number;
  /** True only after at least one server-confirmed delivery ACK. */
  serverDurableAck: boolean;
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

/**
 * Keep Alive HTTP registration + assignment sync.
 * Reuses ClientConnection auth/lifecycle. No Job claim/execute. No Browser required.
 */
export class KeepAliveSyncService {
  private readonly api: KeepAliveHttpApi;
  private registrationStatus: KeepAliveRegistrationStatus = "idle";
  private serverAssignmentCount: number | null = null;
  private lastAssignmentRefreshAt: string | null = null;
  private lastHttpError: string | null = null;
  private serverTenantId: string | null = null;
  private registeredConnectionKey: string | null = null;
  private inFlight: Promise<void> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private wasOnline = false;
  private stoppedFatal = false;
  private snapshotSyncStatus: KeepAliveSnapshotSyncStatus = "not_started";
  private lastSyncedSequence: number | null = null;
  private pendingRecovery = false;
  private lastSuccessfulSyncAt: string | null = null;
  private detectedGapCount = 0;
  private serverDurableAck = false;
  private lastServerAckSequence: number | null = null;
  private pendingAckCount = 0;
  private lastAckSuccessAt: string | null = null;
  private lastAckError: string | null = null;
  private artifactAckState: ArtifactAckState = "idle";
  private artifactAckPendingCount = 0;
  private readonly socket: KeepAliveSocketClient;

  constructor(
    private readonly connection: ClientConnection,
    private readonly node: KeepAliveNodeService,
    api?: KeepAliveHttpApi,
    socketFactory?: KeepAliveSocketFactory
  ) {
    this.api = api ?? new KeepAliveHttpApi(connection);
    this.socket = new KeepAliveSocketClient(this.api, {
      getNodeId: () => this.node.getNodeId(),
      isEnabled: () => this.node.isEnabled(),
      isOnline: () => this.connection.isOnline(),
      getGatewayOverride: () => {
        const env = process.env.RPA_KEEPALIVE_SOCKET_GATEWAY?.trim();
        if (env) return env.replace(/\/+$/, "");
        return this.node.getSocketGatewayOverride();
      },
      onHints: (hints) => this.onSocketHints(hints),
      socketFactory,
    });
    this.connection.onStateChange((state) => {
      const online = state.status === "connected" && state.online;
      if (online && !this.wasOnline) {
        this.stoppedFatal = false;
        this.registeredConnectionKey = null;
        void this.sync("reconnect");
        this.startPeriodic();
      } else if (!online) {
        this.stopPeriodic();
        this.clearRetry();
        this.socket.stop("offline");
        if (this.registrationStatus === "registered") {
          this.registrationStatus = "offline";
        }
      }
      this.wasOnline = online;
    });
  }

  getState(): KeepAliveSyncState {
    return {
      registrationStatus: this.registrationStatus,
      serverAssignmentCount: this.serverAssignmentCount,
      lastAssignmentRefreshAt: this.lastAssignmentRefreshAt,
      lastHttpError: this.lastHttpError,
      serverRegistrationConfirmed: this.registrationStatus === "registered",
      campaignAssignmentConfirmed:
        this.registrationStatus === "registered" && this.lastAssignmentRefreshAt != null,
      serverTenantId: this.serverTenantId,
      snapshotSyncStatus: this.snapshotSyncStatus,
      lastSyncedSequence: this.lastSyncedSequence,
      pendingRecovery: this.pendingRecovery,
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      detectedGapCount: this.detectedGapCount,
      serverDurableAck: this.serverDurableAck,
      lastServerAckSequence: this.lastServerAckSequence,
      pendingAckCount: this.pendingAckCount,
      lastAckSuccessAt: this.lastAckSuccessAt,
      lastAckError: this.lastAckError,
      artifactAckState: this.artifactAckState,
      artifactAckPendingCount: this.artifactAckPendingCount,
      ...this.socket.getDiagnostics(),
    };
  }

  /** Call when Keep Alive enabled flag flips. */
  async onEnabledChanged(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.stopPeriodic();
      this.clearRetry();
      this.socket.stop("disabled");
      this.registeredConnectionKey = null;
      this.registrationStatus = "stopped";
      this.serverAssignmentCount = null;
      this.lastHttpError = null;
      this.snapshotSyncStatus = "idle";
      this.lastSyncedSequence = null;
      this.pendingRecovery = false;
      this.lastAckError = null;
      this.artifactAckState = "idle";
      const nodeId = this.node.getNodeId();
      if (nodeId) {
        const revoked = revokeAllActiveAssignments(this.node.sqlite, nodeId);
        logClientEvent("KEEPALIVE_DISABLED_OBSERVATION_REVOKED", { revoked, nodeId });
      }
      return;
    }
    this.stoppedFatal = false;
    this.registeredConnectionKey = null;
    await this.sync("enable");
    this.startPeriodic();
  }

  /** Explicit manual refresh (UI). Deduped with in-flight sync. */
  async refreshAssignments(reason = "manual"): Promise<KeepAliveSyncState> {
    await this.sync(reason);
    return this.getState();
  }

  /** Test helper — inject socket hint without LIVE Gateway. */
  ingestSocketHintForTests(
    raw: unknown,
    event: KeepAliveSocketHint["event"] = "ka.notify"
  ): void {
    this.socket.ingestTestHint(raw, event);
  }

  destroy(): void {
    this.stopPeriodic();
    this.clearRetry();
    this.socket.destroy();
  }

  private onSocketHints(hints: KeepAliveSocketHint[]): void {
    if (!this.node.isEnabled() || this.stoppedFatal) return;
    const wantsAssignments = hints.some(
      (h) => h.event === "ka.assignment_changed" || h.event === "ka.route_invalidated"
    );
    const wantsRecover = hints.some((h) => h.event === "ka.recover_hint");
    const reason = wantsAssignments
      ? "socket_assignment"
      : wantsRecover
        ? "socket_recover"
        : "socket_notify";
    // Deduped with inFlight — never per-event HTTP storm.
    void this.sync(reason);
  }

  private startPeriodic(): void {
    if (this.periodicTimer) return;
    if (!this.node.isEnabled()) return;
    this.periodicTimer = setInterval(() => {
      void this.sync("periodic");
    }, PERIODIC_REFRESH_MS);
    this.periodicTimer.unref?.();
  }

  private stopPeriodic(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(): void {
    if (this.stoppedFatal || !this.node.isEnabled()) return;
    if (this.retryAttempt >= RETRY_MAX_ATTEMPTS) {
      logClientEvent("KEEPALIVE_SYNC_RETRY_EXHAUSTED", {
        attempts: this.retryAttempt,
        lastHttpError: this.lastHttpError,
      });
      return;
    }
    const delay = Math.min(
      RETRY_INITIAL_MS * Math.pow(1.8, this.retryAttempt),
      RETRY_MAX_MS
    );
    this.retryAttempt += 1;
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      void this.sync("retry");
    }, delay);
    this.retryTimer.unref?.();
  }

  private connectionKey(): string {
    const s = this.connection.getState();
    return `${s.endpoint}::${s.agentUuid ?? ""}::${s.clientApiKeyId ?? ""}`;
  }

  private async sync(reason: string): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runSync(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runSync(reason: string): Promise<void> {
    if (!this.node.isEnabled()) {
      this.registrationStatus = "stopped";
      return;
    }
    if (this.stoppedFatal) return;

    await this.node.ensureInitializedPublic();
    const nodeId = this.node.getNodeId();
    if (!nodeId) {
      this.lastHttpError = "Keep Alive node_id chưa sẵn sàng.";
      this.registrationStatus = "error";
      return;
    }

    if (!this.connection.isOnline()) {
      this.registrationStatus = "offline";
      return;
    }

    const agentUuid = this.connection.getState().agentUuid;
    if (!agentUuid) {
      // Authenticated session without agent_uuid yet — wait for normal register.
      this.registrationStatus = "offline";
      this.lastHttpError = "Chờ agent_uuid từ Client registration.";
      return;
    }

    const connKey = this.connectionKey();
    const alreadyRegistered = this.registeredConnectionKey === connKey;

    if (!alreadyRegistered) {
      const reg = await this.api.register({ nodeId, agentUuid });
      if (!reg.ok) {
        this.lastHttpError = reg.message;
        if (reg.fatal) {
          this.stoppedFatal = true;
          this.registrationStatus =
            reg.status === 401 || reg.status === 403 ? "auth_blocked" : "protocol_mismatch";
          this.stopPeriodic();
          this.socket.stop("auth_blocked");
          logClientError(
            "KEEPALIVE_REGISTER_FATAL",
            new Error(`${reg.code} status=${reg.status} reason=${reason}: ${reg.message}`)
          );
          return;
        }
        this.registrationStatus = "error";
        logClientError(
          "KEEPALIVE_REGISTER_FAILED",
          new Error(`${reg.code} status=${reg.status} reason=${reason}: ${reg.message}`)
        );
        this.scheduleRetry();
        return;
      }

      this.registeredConnectionKey = connKey;
      this.registrationStatus = "registered";
      this.serverTenantId = reg.data.tenantId;
      this.lastHttpError = null;
      this.retryAttempt = 0;
      logClientEvent("KEEPALIVE_REGISTERED", {
        reason,
        nodeId,
        tenantId: reg.data.tenantId,
        idempotent: reg.idempotent === true,
        browserRequired: false,
      });
    } else {
      this.registrationStatus = "registered";
    }

    const assign = await this.api.fetchAssignments({ nodeId });
    if (!assign.ok) {
      this.lastHttpError = assign.message;
      if (assign.fatal) {
        this.stoppedFatal = true;
        this.registrationStatus =
          assign.status === 401 || assign.status === 403 ? "auth_blocked" : "protocol_mismatch";
        this.stopPeriodic();
        this.socket.stop("auth_blocked");
        // Do not wipe local history; revoke observation on auth/protocol hard fail.
        revokeAllActiveAssignments(this.node.sqlite, nodeId);
        logClientError(
          "KEEPALIVE_ASSIGNMENTS_FATAL",
          new Error(`${assign.code} status=${assign.status} reason=${reason}: ${assign.message}`)
        );
        return;
      }
      logClientError(
        "KEEPALIVE_ASSIGNMENTS_FAILED",
        new Error(`${assign.code} status=${assign.status} reason=${reason}: ${assign.message}`)
      );
      this.scheduleRetry();
      return;
    }

    const outcome = applyServerAssignments(this.node.sqlite, {
      nodeId,
      tenantId: assign.data.tenantId,
      assignments: assign.data.assignments,
    });
    this.serverTenantId = assign.data.tenantId;
    this.serverAssignmentCount = assign.data.assignments.filter((a) => a.status === "assigned").length;
    this.lastAssignmentRefreshAt = new Date().toISOString();
    this.lastHttpError = null;
    this.retryAttempt = 0;

    logClientEvent("KEEPALIVE_ASSIGNMENTS_APPLIED", {
      reason,
      nodeId,
      tenantId: assign.data.tenantId,
      serverCount: this.serverAssignmentCount,
      applied: outcome.applied,
      revoked: outcome.revoked,
      rejectedStale: outcome.rejectedStale,
      rejectedCrossTenant: outcome.rejectedCrossTenant,
    });

    this.snapshotSyncStatus = "syncing";
    const dataSummary = await syncAllAssignedCampaignData(
      this.api,
      this.node.sqlite,
      nodeId,
      assign.data.tenantId
    );
    this.snapshotSyncStatus = dataSummary.snapshotSyncStatus;
    this.lastSyncedSequence = dataSummary.lastSyncedSequence;
    this.pendingRecovery = dataSummary.pendingRecovery;
    this.detectedGapCount = dataSummary.detectedGapCount;
    if (dataSummary.lastSuccessfulSyncAt) {
      this.lastSuccessfulSyncAt = dataSummary.lastSuccessfulSyncAt;
      this.node.sqlite.markLocalSyncComplete(dataSummary.lastSuccessfulSyncAt);
    }
    if (dataSummary.lastHttpError) {
      this.lastHttpError = dataSummary.lastHttpError;
    }

    logClientEvent("KEEPALIVE_CAMPAIGN_DATA_SYNCED", {
      reason,
      nodeId,
      tenantId: assign.data.tenantId,
      campaigns: dataSummary.outcomes.length,
      snapshotSyncStatus: dataSummary.snapshotSyncStatus,
      lastSyncedSequence: dataSummary.lastSyncedSequence,
      pendingRecovery: dataSummary.pendingRecovery,
      detectedGapCount: dataSummary.detectedGapCount,
      claimRuntimeEnabled: false,
    });

    // Durable delivery ACK after SQLite ingest — same sync loop, no extra poller.
    if (!dataSummary.outcomes.some((o) => o.authFatal)) {
      const ackSummary = await flushDurableAcks(this.api, this.node.sqlite, {
        nodeId,
        tenantId: assign.data.tenantId,
      });
      this.pendingAckCount = ackSummary.pendingAckCount;
      this.artifactAckPendingCount = ackSummary.artifactAckPendingCount;
      this.artifactAckState = ackSummary.artifactAckState;
      this.lastServerAckSequence = ackSummary.lastServerAckSequence;
      if (ackSummary.serverDurableAck) this.serverDurableAck = true;
      if (ackSummary.lastAckSuccessAt) this.lastAckSuccessAt = ackSummary.lastAckSuccessAt;
      if (ackSummary.lastAckError) {
        this.lastAckError = ackSummary.lastAckError;
        this.lastHttpError = ackSummary.lastAckError;
      } else {
        this.lastAckError = null;
      }

      logClientEvent("KEEPALIVE_DURABLE_ACK_FLUSHED", {
        reason,
        nodeId,
        eventsCampaigns: ackSummary.outcomes.length,
        pendingAckCount: ackSummary.pendingAckCount,
        lastServerAckSequence: ackSummary.lastServerAckSequence,
        serverDurableAck: this.serverDurableAck,
        artifactAckState: ackSummary.artifactAckState,
      });

      if (ackSummary.authFatal) {
        this.stoppedFatal = true;
        this.registrationStatus = "auth_blocked";
        this.stopPeriodic();
        this.socket.stop("auth_blocked");
        revokeAllActiveAssignments(this.node.sqlite, nodeId);
        return;
      }

      if (
        ackSummary.lastAckError &&
        !ackSummary.needsFeedRefresh &&
        !ackSummary.needsAssignmentRefresh
      ) {
        // Transient ACK failure — bounded backoff on existing sync loop.
        this.scheduleRetry();
      }

      if (
        (ackSummary.needsAssignmentRefresh || dataSummary.needsAssignmentRefresh) &&
        reason !== "stale_generation"
      ) {
        logClientEvent("KEEPALIVE_ASSIGNMENT_GENERATION_STALE_REFRESH", { reason, nodeId });
        queueMicrotask(() => {
          void this.sync("stale_generation");
        });
      } else if (ackSummary.needsFeedRefresh && reason !== "ack_reconcile") {
        // Reconcile cursors via one feed refresh — do not advance confirmed ACK.
        queueMicrotask(() => {
          void this.sync("ack_reconcile");
        });
      }
    } else if (dataSummary.needsAssignmentRefresh && reason !== "stale_generation") {
      logClientEvent("KEEPALIVE_ASSIGNMENT_GENERATION_STALE_REFRESH", { reason, nodeId });
      queueMicrotask(() => {
        void this.sync("stale_generation");
      });
    }

    // Local recovery plan after sync — no social replay.
    await this.node.runRecovery();

    // Socket.IO hints (optional latency path). HTTP remains durable authority.
    if (!this.stoppedFatal && this.registrationStatus === "registered") {
      void this.socket.start(reason.startsWith("socket_") ? "after_http_catchup" : reason);
    }
  }
}
