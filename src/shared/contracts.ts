export interface DeviceInfo {
  deviceId: string;
  displayName: string;
  platform: string;
  osVersion: string;
  clientVersion: string;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface InstallationContext {
  installationId: string;
}

export interface ClientApiKeyContext {
  id: number;
  name: string;
  keyPrefix: string;
  installationId: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ConnectionState {
  status: ConnectionStatus;
  endpoint: string;
  hasKey: boolean;
  keyPrefix?: string;
  installation?: InstallationContext;
  device?: DeviceInfo;
  agentUuid?: string;
  online: boolean;
  lastHeartbeatAt?: string;
  lastError?: string;
  nextHeartbeatInSeconds?: number;
}

export type ClientCommand =
  | { type: "getConnectionState" }
  | { type: "setEndpoint"; endpoint: string }
  | { type: "connect"; apiKey: string; endpoint?: string }
  | { type: "disconnect" }
  | { type: "setDisplayName"; displayName: string }
  | { type: "triggerHeartbeat" };

export interface ClientApi {
  invoke: <T = unknown>(command: ClientCommand) => Promise<T>;
  onStateChange: (callback: (state: ConnectionState) => void) => () => void;
  onLog: (callback: (entry: { time: string; level: string; message: string }) => void) => () => void;
}

declare global {
  interface Window {
    client: ClientApi;
  }
}
