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

export interface BrowserProfile {
  browserId: string;
  name: string;
  platform: string;
  partition: string;
  status: "stopped" | "running" | "error";
  lastUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserViewState {
  activeBrowserId: string | null;
  currentUrl: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
}

export interface BrowserStateSnapshot {
  profiles: BrowserProfile[];
  activeBrowserId: string | null;
  viewState: BrowserViewState;
}

export type ClientCommand =
  | { type: "getConnectionState" }
  | { type: "setEndpoint"; endpoint: string }
  | { type: "connect"; apiKey: string; endpoint?: string }
  | { type: "disconnect" }
  | { type: "setDisplayName"; displayName: string }
  | { type: "triggerHeartbeat" }
  | { type: "getBrowserState" }
  | { type: "createBrowserProfile"; name: string; platform?: string }
  | { type: "renameBrowserProfile"; browserId: string; name: string }
  | { type: "deleteBrowserProfile"; browserId: string }
  | { type: "openBrowser"; browserId: string; initialUrl?: string }
  | { type: "stopBrowser"; browserId?: string }
  | { type: "navigateBrowser"; url: string }
  | { type: "browserGoBack" }
  | { type: "browserGoForward" }
  | { type: "browserReload" }
  | { type: "setBrowserViewBounds"; bounds: { x: number; y: number; width: number; height: number } }
  | { type: "setBrowserViewVisible"; visible: boolean };

export interface ClientApi {
  invoke: <T = unknown>(command: ClientCommand) => Promise<T>;
  onStateChange: (callback: (state: ConnectionState) => void) => () => void;
  onBrowserStateChange: (callback: (state: BrowserStateSnapshot) => void) => () => void;
  onLog: (callback: (entry: { time: string; level: string; message: string }) => void) => () => void;
}

declare global {
  interface Window {
    client: ClientApi;
  }
}
