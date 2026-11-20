/**
 * Keep Alive Socket.IO realtime hints (Phase 3B.6D).
 *
 * Contract source: phase brief + keepalive.v1 (Desktop does not host LAPTOP
 * docs/KEEPALIVE_SOCKET_TICKET_3B6B.md / GATEWAY_3B6C.md). Socket payloads are
 * notification hints only — durable state stays on HTTP + SQLite.
 *
 * Auth: short-lived ticket via HTTP mint → Socket.IO `auth.ticket`.
 * Never send Client API Key to the Gateway. Never persist tickets.
 */

import { io, type Socket } from "socket.io-client";
import { logClientError, logClientEvent } from "../main-error-log.js";
import {
  KEEPALIVE_PROTOCOL_VERSION,
  KEEPALIVE_SCHEMA_VERSION,
  KEEPALIVE_SOCKET_EVENTS,
  KEEPALIVE_SOCKET_PATH_DEFAULT,
  type KeepAliveSocketEventName,
  type KeepAliveSocketStatus,
} from "./contracts.js";
import type { KeepAliveHttpApi, KeepAliveSocketTicketResponse } from "./keepalive-http-api.js";

const COALESCE_MS = 750;
const RECONNECT_INITIAL_MS = 1_500;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_MAX_ATTEMPTS = 12;

export interface KeepAliveSocketHint {
  event: KeepAliveSocketEventName;
  routeGeneration: number;
  nodeId: string | null;
  tenantId: string | null;
  campaignId: string | null;
  reason: string | null;
  at: string | null;
}

export interface KeepAliveSocketDiagnostics {
  socketStatus: KeepAliveSocketStatus;
  socketConnected: boolean;
  lastSocketNotifyAt: string | null;
  socketReconnectAttempts: number;
  socketRouteGeneration: number | null;
  lastSocketError: string | null;
}

export type KeepAliveSocketHintHandler = (hints: KeepAliveSocketHint[]) => void;

/** Minimal Socket surface for tests (no LIVE Gateway). */
export interface KeepAliveSocketHandle {
  connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  disconnect(): void;
}

export type KeepAliveSocketFactory = (params: {
  gatewayUrl: string;
  socketPath: string;
  ticket: string;
}) => KeepAliveSocketHandle;

/** No-op transport — used when LIVE Gateway is not enabled (tests / default Desktop). */
export function createDisabledSocketFactory(): KeepAliveSocketFactory {
  return () => ({
    connected: false,
    on() {
      /* no-op */
    },
    off() {
      /* no-op */
    },
    disconnect() {
      /* no-op */
    },
  });
}

/**
 * Real Socket.IO client (WebSocket-only).
 * Opt-in via RPA_KEEPALIVE_SOCKET_ENABLE=1 or explicit factory injection.
 * Never send Client API Key — auth.ticket only.
 */
export function createSocketIoFactory(): KeepAliveSocketFactory {
  return (params) => {
    const socket: Socket = io(params.gatewayUrl, {
      path: params.socketPath || KEEPALIVE_SOCKET_PATH_DEFAULT,
      transports: ["websocket"],
      upgrade: false,
      // Manual reconnect with fresh ticket — do not reuse expired auth.
      reconnection: false,
      autoConnect: true,
      auth: { ticket: params.ticket },
      timeout: 15_000,
      forceNew: true,
    });
    return {
      get connected() {
        return socket.connected;
      },
      on(event, listener) {
        socket.on(event, listener);
      },
      off(event, listener) {
        socket.off(event, listener);
      },
      disconnect() {
        socket.removeAllListeners();
        socket.disconnect();
      },
    };
  };
}

export function resolveDefaultSocketFactory(): KeepAliveSocketFactory {
  return process.env.RPA_KEEPALIVE_SOCKET_ENABLE === "1"
    ? createSocketIoFactory()
    : createDisabledSocketFactory();
}

/**
 * One Socket.IO connection per Client process for Keep Alive hints.
 * Coalesces bursts into a single HTTP catch-up trigger.
 */
export class KeepAliveSocketClient {
  private status: KeepAliveSocketStatus = "idle";
  private socket: KeepAliveSocketHandle | null = null;
  private routeGeneration: number | null = null;
  private lastNotifyAt: string | null = null;
  private reconnectAttempts = 0;
  private lastError: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingHints: KeepAliveSocketHint[] = [];
  private started = false;
  private stoppedFatal = false;
  /** In-memory ticket only — cleared on stop; never logged. */
  private liveTicket: string | null = null;

  constructor(
    private readonly api: KeepAliveHttpApi,
    private readonly opts: {
      getNodeId: () => string | null;
      isEnabled: () => boolean;
      isOnline: () => boolean;
      /** Optional gateway override (settings / env). */
      getGatewayOverride?: () => string | null | undefined;
      onHints: KeepAliveSocketHintHandler;
      socketFactory?: KeepAliveSocketFactory;
    }
  ) {}

  getDiagnostics(): KeepAliveSocketDiagnostics {
    return {
      socketStatus: this.status,
      socketConnected: this.socket?.connected === true && this.status === "connected",
      lastSocketNotifyAt: this.lastNotifyAt,
      socketReconnectAttempts: this.reconnectAttempts,
      socketRouteGeneration: this.routeGeneration,
      lastSocketError: this.lastError,
    };
  }

  /** Start socket after HTTP register/assignments succeed (idempotent if already connected). */
  async start(reason = "start"): Promise<void> {
    if (!this.opts.isEnabled()) {
      this.stop("disabled");
      return;
    }
    if (!this.opts.isOnline()) {
      this.status = "disconnected";
      return;
    }
    if (this.stoppedFatal) return;

    this.started = true;
    // Avoid reconnect storm on periodic HTTP sync — only connect when down.
    if (
      this.status === "connected" &&
      this.socket?.connected &&
      reason !== "route_invalidated" &&
      reason !== "reconnect"
    ) {
      return;
    }
    this.clearReconnectTimer();
    await this.connectFreshTicket(reason);
  }

  stop(reason = "stop"): void {
    this.started = false;
    this.clearReconnectTimer();
    this.clearCoalesce();
    this.pendingHints = [];
    this.disconnectSocket();
    this.clearTicketMemory();
    this.status = reason === "disabled" || reason === "stop" ? "stopped" : this.status;
    if (reason === "disabled") this.status = "stopped";
    logClientEvent("KEEPALIVE_SOCKET_STOPPED", { reason, browserRequired: false });
  }

  destroy(): void {
    this.stoppedFatal = true;
    this.stop("destroy");
  }

  /** Test helper: inject a parsed hint as if received from Gateway. */
  ingestTestHint(raw: unknown, event: KeepAliveSocketEventName = "ka.notify"): void {
    this.handleRawEvent(event, raw);
  }

  private async connectFreshTicket(reason: string): Promise<void> {
    const nodeId = this.opts.getNodeId();
    if (!nodeId) {
      this.lastError = "Keep Alive node_id chưa sẵn sàng cho socket ticket.";
      this.status = "error";
      return;
    }

    // LIVE Gateway opt-in — unit tests inject socketFactory; Desktop default stays HTTP-only.
    if (!this.opts.socketFactory && process.env.RPA_KEEPALIVE_SOCKET_ENABLE !== "1") {
      this.status = "stopped";
      logClientEvent("KEEPALIVE_SOCKET_LIVE_DISABLED", {
        reason,
        note: "Set RPA_KEEPALIVE_SOCKET_ENABLE=1 to open Socket.IO Gateway",
      });
      return;
    }

    this.status = "connecting";
    this.disconnectSocket();
    this.clearTicketMemory();

    const minted = await this.api.mintSocketTicket({ nodeId });
    if (!minted.ok) {
      this.lastError = sanitizeSocketError(minted.message);
      if (minted.fatal) {
        this.stoppedFatal = true;
        this.status =
          minted.status === 401 || minted.status === 403 ? "auth_blocked" : "protocol_mismatch";
        logClientError(
          "KEEPALIVE_SOCKET_TICKET_FATAL",
          new Error(`${minted.code} status=${minted.status}: ${minted.message}`)
        );
        return;
      }
      this.status = "error";
      logClientError(
        "KEEPALIVE_SOCKET_TICKET_FAILED",
        new Error(`${minted.code}: ${minted.message}`)
      );
      this.scheduleReconnect();
      return;
    }

    const ticketData = minted.data;
    // Apply optional gateway override without logging ticket.
    const override = this.opts.getGatewayOverride?.()?.trim();
    const gatewayUrl = override && override.length > 0 ? override : ticketData.gatewayUrl;
    this.liveTicket = ticketData.ticket;
    this.routeGeneration = ticketData.routeGeneration;

    const factory = this.opts.socketFactory ?? resolveDefaultSocketFactory();
    let handle: KeepAliveSocketHandle;
    try {
      handle = factory({
        gatewayUrl,
        socketPath: ticketData.socketPath || KEEPALIVE_SOCKET_PATH_DEFAULT,
        ticket: ticketData.ticket,
      });
    } catch (err) {
      this.lastError = sanitizeSocketError(err instanceof Error ? err.message : String(err));
      this.status = "error";
      this.clearTicketMemory();
      this.scheduleReconnect();
      return;
    }

    this.socket = handle;
    this.bindSocket(handle, ticketData, reason);
  }

  private bindSocket(
    handle: KeepAliveSocketHandle,
    ticketData: KeepAliveSocketTicketResponse,
    reason: string
  ): void {
    const onConnect = () => {
      this.status = "connected";
      this.reconnectAttempts = 0;
      this.lastError = null;
      logClientEvent("KEEPALIVE_SOCKET_CONNECTED", {
        reason,
        routeGeneration: ticketData.routeGeneration,
        gatewayHost: safeHost(ticketData.gatewayUrl),
        browserRequired: false,
      });
    };
    const onDisconnect = (...args: unknown[]) => {
      const why = typeof args[0] === "string" ? args[0] : "disconnect";
      if (!this.started || this.stoppedFatal) {
        this.status = "stopped";
        return;
      }
      this.status = "disconnected";
      this.lastError = sanitizeSocketError(why);
      logClientEvent("KEEPALIVE_SOCKET_DISCONNECTED", {
        reason: sanitizeSocketError(why),
        routeGeneration: this.routeGeneration,
      });
      this.clearTicketMemory();
      this.scheduleReconnect();
    };
    const onConnectError = (...args: unknown[]) => {
      const err = args[0];
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "socket connect_error";
      this.lastError = sanitizeSocketError(msg);
      this.status = "error";
      logClientError("KEEPALIVE_SOCKET_CONNECT_ERROR", new Error(this.lastError));
      this.disconnectSocket();
      this.clearTicketMemory();
      // Auth failures from Gateway should not loop forever without re-ticket.
      if (/auth|unauthorized|forbidden|ticket/i.test(msg)) {
        this.scheduleReconnect();
        return;
      }
      this.scheduleReconnect();
    };

    handle.on("connect", onConnect);
    handle.on("disconnect", onDisconnect);
    handle.on("connect_error", onConnectError);

    for (const eventName of KEEPALIVE_SOCKET_EVENTS) {
      handle.on(eventName, (...args: unknown[]) => {
        this.handleRawEvent(eventName, args[0]);
      });
    }

    // Already connected (some mocks).
    if (handle.connected) onConnect();
  }

  private handleRawEvent(event: KeepAliveSocketEventName, raw: unknown): void {
    const parsed = parseSocketHint(raw, event);
    if (!parsed.ok) {
      if (parsed.fatal) {
        this.stoppedFatal = true;
        this.status = "protocol_mismatch";
        this.lastError = parsed.message;
        this.stop("protocol_mismatch");
      }
      return;
    }

    const hint = parsed.hint;
    const current = this.routeGeneration ?? 0;
    if (hint.routeGeneration < current) {
      logClientEvent("KEEPALIVE_SOCKET_STALE_ROUTE_IGNORED", {
        event,
        eventRoute: hint.routeGeneration,
        currentRoute: current,
      });
      return;
    }

    if (event === "ka.route_invalidated" || hint.routeGeneration > current) {
      this.routeGeneration = hint.routeGeneration;
      this.lastNotifyAt = new Date().toISOString();
      this.enqueueHint(hint);
      // Force fresh ticket + reconnect, then HTTP catch-up via coalesced hints.
      if (this.started && !this.stoppedFatal) {
        void this.connectFreshTicket("route_invalidated");
      }
      return;
    }

    this.lastNotifyAt = new Date().toISOString();
    this.enqueueHint(hint);
  }

  private enqueueHint(hint: KeepAliveSocketHint): void {
    this.pendingHints.push(hint);
    // Bound queue — keep latest N unique by event+campaign.
    if (this.pendingHints.length > 32) {
      this.pendingHints = this.pendingHints.slice(-32);
    }
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      const batch = this.pendingHints.splice(0, this.pendingHints.length);
      if (batch.length === 0) return;
      // Deduplicate by event+campaignId for one HTTP catch-up.
      const seen = new Set<string>();
      const deduped: KeepAliveSocketHint[] = [];
      for (const h of batch) {
        const key = `${h.event}::${h.campaignId ?? "*"}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(h);
      }
      logClientEvent("KEEPALIVE_SOCKET_HINTS_COALESCED", {
        count: deduped.length,
        events: deduped.map((h) => h.event),
        routeGeneration: this.routeGeneration,
      });
      try {
        this.opts.onHints(deduped);
      } catch (err) {
        logClientError(
          "KEEPALIVE_SOCKET_HINT_HANDLER_FAILED",
          err instanceof Error ? err : new Error(String(err))
        );
      }
    }, COALESCE_MS);
    this.coalesceTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (!this.started || this.stoppedFatal || !this.opts.isEnabled()) return;
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.lastError = "Socket reconnect exhausted — HTTP fallback vẫn hoạt động.";
      logClientEvent("KEEPALIVE_SOCKET_RECONNECT_EXHAUSTED", {
        attempts: this.reconnectAttempts,
      });
      return;
    }
    const base = Math.min(
      RECONNECT_INITIAL_MS * Math.pow(1.7, this.reconnectAttempts),
      RECONNECT_MAX_MS
    );
    const jitter = Math.floor(Math.random() * Math.min(1000, base * 0.2));
    const delay = base + jitter;
    this.reconnectAttempts += 1;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      void this.connectFreshTicket("reconnect");
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearCoalesce(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
  }

  private disconnectSocket(): void {
    if (!this.socket) return;
    try {
      this.socket.disconnect();
    } catch {
      // best-effort
    }
    this.socket = null;
  }

  private clearTicketMemory(): void {
    this.liveTicket = null;
  }
}

export function parseSocketHint(
  raw: unknown,
  event: KeepAliveSocketEventName
):
  | { ok: true; hint: KeepAliveSocketHint }
  | { ok: false; message: string; fatal: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Socket hint payload phải là object.", fatal: false };
  }
  const row = raw as Record<string, unknown>;
  const protocolVersion =
    typeof row.protocol_version === "string"
      ? row.protocol_version
      : typeof row.protocolVersion === "string"
        ? row.protocolVersion
        : null;
  const schemaVersion =
    typeof row.schema_version === "number"
      ? row.schema_version
      : typeof row.schemaVersion === "number"
        ? row.schemaVersion
        : null;

  if (protocolVersion != null && protocolVersion !== KEEPALIVE_PROTOCOL_VERSION) {
    return {
      ok: false,
      message: `Socket protocol mismatch (${protocolVersion}).`,
      fatal: true,
    };
  }
  if (schemaVersion != null && schemaVersion !== KEEPALIVE_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `Socket schema mismatch (${schemaVersion}).`,
      fatal: true,
    };
  }

  const routeGeneration =
    typeof row.route_generation === "number"
      ? row.route_generation
      : typeof row.routeGeneration === "number"
        ? row.routeGeneration
        : null;
  if (routeGeneration == null || !Number.isFinite(routeGeneration) || routeGeneration < 1) {
    return { ok: false, message: "Socket hint thiếu route_generation.", fatal: false };
  }

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  return {
    ok: true,
    hint: {
      event,
      routeGeneration,
      nodeId: str(row.node_id) ?? str(row.nodeId),
      tenantId: str(row.tenant_id) ?? str(row.tenantId),
      campaignId: str(row.campaign_id) ?? str(row.campaignId),
      reason: str(row.reason) ?? str(row.hint) ?? str(row.message),
      at: str(row.at) ?? str(row.timestamp) ?? str(row.created_at),
    },
  };
}

function sanitizeSocketError(value: string): string {
  return value
    .replace(/Bearer\s+\S+|rpa_[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/ticket["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "ticket=[redacted]")
    .slice(0, 300);
}

function safeHost(gatewayUrl: string): string {
  try {
    return new URL(gatewayUrl).host;
  } catch {
    return "unknown";
  }
}
