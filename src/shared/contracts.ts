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

export interface AccountInfo {
  accountId: string;
  platform: string;
  displayName: string;
  username: string | null;
  identityLabel: string | null;
  verified: boolean;
}

export interface AccountBinding {
  accountId: string | null;
  boundAt: string | null;
  accountName?: string;
}

export interface SessionSignal {
  status: "present" | "absent" | "unknown";
  checkedAt: string | null;
  method: "facebook_c_user_cookie" | null;
}

export interface ExecutionConfirmation {
  status: "not_run" | "pending_review" | "confirmed" | "failed";
  firstRunAt: string | null;
  lastSuccessAt: string | null;
  lastRunId: string | null;
  screenshotRef: string | null;
}

export interface BrowserProfile {
  browserId: string;
  name: string;
  platform: string;
  partition: string;
  status: "stopped" | "running" | "error";
  accountBinding?: AccountBinding;
  sessionSignal?: SessionSignal;
  executionConfirmation?: ExecutionConfirmation;
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
  | { type: "setBrowserViewVisible"; visible: boolean }
  | { type: "getAccounts"; platform?: string }
  | { type: "bindAccount"; browserId: string; accountId: string; accountName?: string }
  | { type: "unbindAccount"; browserId: string }
  | { type: "checkSessionSignal"; browserId: string };

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
