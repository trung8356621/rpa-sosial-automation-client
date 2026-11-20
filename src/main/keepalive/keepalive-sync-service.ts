import type { ClientConnection } from "../connection/client-connection.js";
import { logClientError, logClientEvent } from "../main-error-log.js";
import type { KeepAliveRegistrationStatus } from "./contracts.js";
import { applyServerAssignments, revokeAllActiveAssignments } from "./assignment-apply.js";
import { KeepAliveHttpApi } from "./keepalive-http-api.js";
import type { KeepAliveNodeService } from "./keepalive-node.js";

/** Conservative coalesced refresh until Socket.IO exists (not per-heartbeat). */
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

  constructor(
    private readonly connection: ClientConnection,
    private readonly node: KeepAliveNodeService,
    api?: KeepAliveHttpApi
  ) {
    this.api = api ?? new KeepAliveHttpApi(connection);
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
    };
  }

  /** Call when Keep Alive enabled flag flips. */
  async onEnabledChanged(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.stopPeriodic();
      this.clearRetry();
      this.registeredConnectionKey = null;
      this.registrationStatus = "stopped";
      this.serverAssignmentCount = null;
      this.lastHttpError = null;
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

  destroy(): void {
    this.stopPeriodic();
    this.clearRetry();
  }

  private startPeriodic(): void {
    if (this.periodicTimer) return;
    if (!this.node.isEnabled()) return;
    this.periodicTimer = setInterval(() => {
      void this.sync("periodic");
    }, PERIODIC_REFRESH_MS);
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
      snapshotSync: "not_implemented",
    });

    // Local recovery plan after assignment changes — no social replay.
    await this.node.runRecovery();
  }
}
