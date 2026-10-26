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
  email: string | null;
  siteUrl?: string | null;
  hasPassword?: boolean;
  identityLabel: string | null;
  verified: boolean;
}

export interface AccountBinding {
  accountId: string | null;
  boundAt: string | null;
  accountName?: string;
  email?: string | null;
  siteUrl?: string | null;
}

export interface SessionSignal {
  status: "present" | "absent" | "unknown";
  checkedAt: string | null;
  method: "facebook_c_user_cookie" | "site_cookie_presence" | null;
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
  | { type: "createBrowserProfile"; name: string; platform?: string; account?: AccountInfo }
  | { type: "createBrowserForAccount"; account: AccountInfo }
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
  | { type: "bindAccount"; browserId: string; accountId: string; accountName?: string; email?: string | null; siteUrl?: string | null }
  | { type: "unbindAccount"; browserId: string }
  | { type: "checkSessionSignal"; browserId: string }
  | { type: "copyToClipboard"; text: string };

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

export function detectBrowserTagFromUrl(url: string): string {
  if (!url || typeof url !== "string") {
    return "unknown";
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("facebook.com") || host.includes("fb.com")) {
      return "facebook";
    }
    if (host.includes("threads.net")) {
      return "threads";
    }
    if (host.includes("instagram.com")) {
      return "instagram";
    }
    if (host.includes("x.com") || host.includes("twitter.com")) {
      return "x";
    }
    if (host.includes("tiktok.com")) {
      return "tiktok";
    }
    return host.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}
