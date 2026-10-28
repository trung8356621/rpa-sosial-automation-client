import { readSeoOpsJson, formatClientHttpError } from "../../shared/seo-ops-http.js";
import type {
  ConnectionState,
  ConnectionStatus,
  DeviceInfo,
  InstallationContext,
} from "../../shared/contracts.js";
import type { ClientStore } from "../storage/store.js";
import type { ClientCredentialStore } from "../storage/credential-store.js";
import type { DeviceManager } from "../device/device-manager.js";
import { logClientError, logClientEvent } from "../main-error-log.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

export class ClientConnection {
  private status: ConnectionStatus = "disconnected";
  private installation?: InstallationContext;
  private agentUuid?: string;
  private online = false;
  private lastHeartbeatAt?: string;
  private lastError?: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private inFlightHeartbeat = false;
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private heartbeatListeners = new Set<(payload: Record<string, unknown>) => void>();

  constructor(
    private readonly store: ClientStore,
    private readonly credentials: ClientCredentialStore,
    private readonly deviceManager: DeviceManager
  ) {}

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  onHeartbeatResponse(listener: (payload: Record<string, unknown>) => void): () => void {
    this.heartbeatListeners.add(listener);
    return () => this.heartbeatListeners.delete(listener);
  }

  private notify() {
    const s = this.getState();
    for (const listener of this.stateListeners) {
      try {
        listener(s);
      } catch {
        // ignore listener error
      }
    }
  }

  getState(): ConnectionState {
    const deviceInfo = this.deviceManager.getDeviceInfo();
    return {
      status: this.status,
      endpoint: this.store.get().endpoint,
      hasKey: this.credentials.hasKey(),
      keyPrefix: this.credentials.getKeyPrefix(),
      installation: this.installation,
      device: deviceInfo,
      agentUuid: this.agentUuid,
      online: this.online,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
      nextHeartbeatInSeconds: this.heartbeatTimer ? Math.round(this.backoffMs === INITIAL_BACKOFF_MS ? HEARTBEAT_INTERVAL_MS / 1000 : this.backoffMs / 1000) : undefined,
    };
  }

  async setEndpoint(endpoint: string): Promise<ConnectionState> {
    const trimmed = endpoint.trim().replace(/\/+$/, "");
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      throw new Error("Endpoint phải bắt đầu bằng http:// hoặc https://");
    }
    await this.store.set({ endpoint: trimmed });
    logClientEvent("Endpoint updated", { endpoint: trimmed });
    this.notify();
    return this.getState();
  }

  async connect(apiKey: string, endpointOverride?: string): Promise<ConnectionState> {
    this.stopHeartbeat();
    this.status = "connecting";
    this.lastError = undefined;
    this.notify();

    if (endpointOverride) {
      await this.setEndpoint(endpointOverride);
    }

    const endpoint = this.store.get().endpoint;
    const cleanKey = apiKey.trim();
    if (!cleanKey) {
      this.status = "error";
      this.lastError = "API Key không được để trống";
      this.notify();
      throw new Error(this.lastError);
    }

    try {
      logClientEvent("Validating client API key against endpoint", { endpoint });
      const validateRes = await this.request(endpoint, "/api/v1/social-automation/client/validate", "GET", cleanKey);
      
      const installationId = String(
        (validateRes.installation as Record<string, unknown>)?.installation_id ??
        (validateRes.client_api_key as Record<string, unknown>)?.installation_id ??
        ""
      );
      this.installation = { installationId };

      // Save encrypted key
      await this.credentials.setKey(cleanKey);

      // Register device
      await this.registerDevice(endpoint, cleanKey);

      this.status = "connected";
      this.online = true;
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.lastError = undefined;
      logClientEvent("Client successfully connected and registered", { installationId, deviceId: this.deviceManager.getDeviceInfo().deviceId });

      this.startHeartbeat();
      this.notify();
      return this.getState();
    } catch (err) {
      this.status = "error";
      this.online = false;
      this.lastError = formatClientHttpError(err);
      logClientError("Connection failed", err);
      this.notify();
      throw new Error(this.lastError);
    }
  }

  async reconnectSaved(): Promise<boolean> {
    const key = this.credentials.getKey();
    if (!key) {
      this.status = "disconnected";
      this.online = false;
      this.notify();
      return false;
    }
    try {
      await this.connect(key);
      return true;
    } catch (err) {
      logClientError("Auto-reconnect with saved key failed", err);
      return false;
    }
  }

  async disconnect(): Promise<ConnectionState> {
    this.stopHeartbeat();
    await this.credentials.clearKey();
    this.status = "disconnected";
    this.online = false;
    this.installation = undefined;
    this.lastError = undefined;
    logClientEvent("Client disconnected and credentials cleared");
    this.notify();
    return this.getState();
  }

  async triggerHeartbeatNow(): Promise<boolean> {
    if (this.status !== "connected") return false;
    return this.sendHeartbeat();
  }

  private async registerDevice(endpoint: string, apiKey: string): Promise<void> {
    const dev = this.deviceManager.getDeviceInfo();
    const payload = {
      device_id: dev.deviceId,
      display_name: dev.displayName,
      platform: dev.platform,
      os_version: dev.osVersion,
      os_family: dev.osFamily,
      os_label: dev.osLabel,
      app_version: dev.clientVersion,
      runtime_version: `electron-${process.versions.electron}`,
    };

    logClientEvent("Registering device on SEO-OPS", { deviceId: dev.deviceId });
    const res = await this.request(endpoint, "/api/v1/social-automation/client/register", "POST", apiKey, payload);
    const agent = res.agent as Record<string, unknown> | undefined;
    if (agent?.agent_uuid) {
      this.agentUuid = String(agent.agent_uuid);
      await this.store.set({ agentUuid: this.agentUuid });
    }
    this.lastHeartbeatAt = new Date().toISOString();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setTimeout(() => void this.heartbeatTick(), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async heartbeatTick(): Promise<void> {
    if (this.status !== "connected") return;
    const ok = await this.sendHeartbeat();
    if (ok) {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.heartbeatTimer = setTimeout(() => void this.heartbeatTick(), HEARTBEAT_INTERVAL_MS);
    } else {
      // Backoff
      this.backoffMs = Math.min(this.backoffMs * 1.5, MAX_BACKOFF_MS);
      logClientEvent(`Heartbeat failed, backing off for ${Math.round(this.backoffMs / 1000)}s`);
      this.heartbeatTimer = setTimeout(() => void this.heartbeatTick(), this.backoffMs);
    }
    this.notify();
  }

  private async sendHeartbeat(): Promise<boolean> {
    if (this.inFlightHeartbeat) return false;
    this.inFlightHeartbeat = true;
    const apiKey = this.credentials.getKey();
    const endpoint = this.store.get().endpoint;
    const dev = this.deviceManager.getDeviceInfo();

    if (!apiKey) {
      this.status = "disconnected";
      this.online = false;
      this.inFlightHeartbeat = false;
      this.stopHeartbeat();
      this.notify();
      return false;
    }

    try {
      const payload = {
        device_id: dev.deviceId,
        agent_uuid: this.agentUuid,
        availability: "available",
        app_version: dev.clientVersion,
        os_family: dev.osFamily,
        os_label: dev.osLabel,
        platform: dev.platform,
        os_version: dev.osVersion,
      };

      const res = await this.request(endpoint, "/api/v1/social-automation/client/heartbeat", "POST", apiKey, payload);
      this.online = true;
      this.lastHeartbeatAt = new Date().toISOString();
      this.lastError = undefined;
      for (const listener of this.heartbeatListeners) {
        try {
          listener(res);
        } catch {
          // ignore listener error
        }
      }
      return true;
    } catch (err) {
      const formatted = formatClientHttpError(err);
      this.lastError = formatted;
      logClientError("Heartbeat request failed", err);

      // Check if unauthorized/revoked
      const msg = (err as Error)?.message || "";
      if (msg.includes("category=authentication") || msg.includes("status=401")) {
        this.status = "error";
        this.online = false;
        this.stopHeartbeat();
      }
      return false;
    } finally {
      this.inFlightHeartbeat = false;
    }
  }

  getDeviceId(): string {
    return this.deviceManager.getDeviceId();
  }

  getEndpoint(): string {
    return this.store.get().endpoint;
  }

  getApiKey(): string | null {
    return this.credentials.getKey();
  }

  isOnline(): boolean {
    return this.status === "connected" && this.online;
  }

  async requestWithAuth(
    subpath: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): Promise<Record<string, unknown>> {
    const key = this.credentials.getKey();
    if (!key) {
      throw new Error("No API key available for request");
    }
    const endpoint = this.store.get().endpoint;
    const url = `${endpoint}${subpath}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "X-Device-Id": this.deviceManager.getDeviceId(),
      ...extraHeaders,
    };
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const isDevUrl = endpoint.includes(".test") || endpoint.includes("localhost") || endpoint.includes("127.0.0.1");
    if (isDevUrl && process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    return await readSeoOpsJson(res, method, url);
  }

  private async request(
    endpoint: string,
    subpath: string,
    method: "GET" | "POST",
    apiKey: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const url = `${endpoint}${subpath}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    // In Electron/Node 22, global fetch is available.
    // Allow self-signed certificates in dev for .test domains or localhost
    const isDevUrl = endpoint.includes(".test") || endpoint.includes("localhost") || endpoint.includes("127.0.0.1");

    // Using dispatcher or node https agent if needed, or NODE_TLS_REJECT_UNAUTHORIZED
    if (isDevUrl && process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    return await readSeoOpsJson(res, method, url);
  }
}
