import type {
  WindowsNotificationDisplayStatus,
  WindowsNotificationStatus,
} from "./windows-notification.js";

export type { WindowsNotificationDisplayStatus, WindowsNotificationStatus };

export interface DeviceInfo {
  deviceId: string;
  displayName: string;
  platform: string;
  osVersion: string;
  /** Normalized OS family for SEO-OPS device metadata. */
  osFamily: "windows" | "linux" | "macos" | "other";
  /** Human-readable OS label (e.g. Windows 11, Ubuntu 24.04). */
  osLabel: string;
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

export interface AccountDetail extends AccountInfo {
  passwordStatus: "available" | "not_set";
}

export interface AccountBinding {
  accountId: string | null;
  boundAt: string | null;
  accountName?: string;
  email?: string | null;
  siteUrl?: string | null;
}

export interface SessionSignal {
  status: "present" | "absent" | "unsupported" | "error" | "unknown";
  checkedAt: string | null;
  method: "facebook_c_user_cookie" | "wordpress_auth_cookie" | "site_cookie_presence" | null;
  error?: string | null;
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
  lastError?: string | null;
}

export interface BrowserStateSnapshot {
  profiles: BrowserProfile[];
  activeBrowserId: string | null;
  viewState: BrowserViewState;
}

export interface ClientNotification {
  id: string;
  type: "manual_intervention" | "login_required" | "display_message";
  message: string;
  account_id?: string | null;
  account_name: string;
  browser_id?: string | null;
  task_id?: number | null;
  created_at?: string | null;
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
  | { type: "getAccount"; accountId: string }
  | { type: "copyAccountEmail"; accountId: string }
  | { type: "copyAccountPassword"; accountId: string }
  | { type: "bindAccount"; browserId: string; accountId: string; accountName?: string; platform?: string; email?: string | null; siteUrl?: string | null }
  | { type: "unbindAccount"; browserId: string }
  | { type: "checkSessionSignal"; browserId: string }
  | { type: "getNotifications" }
  | { type: "ackNotification"; notificationId: string }
  | { type: "getWindowsNotificationStatus" }
  | { type: "openWindowsNotificationSettings" };

export interface ClientApi {
  invoke: <T = unknown>(command: ClientCommand) => Promise<T>;
  onStateChange: (callback: (state: ConnectionState) => void) => () => void;
  onBrowserStateChange: (callback: (state: BrowserStateSnapshot) => void) => () => void;
  onNotifications: (callback: (notifications: ClientNotification[]) => void) => () => void;
  onWindowsNotificationStatus: (callback: (status: WindowsNotificationStatus) => void) => () => void;
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
    if (!host) {
      return "unknown";
    }
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

export function isDomainMatchingAccount(
  accountPlatform: string,
  accountSiteUrl?: string | null,
  currentUrl?: string | null
): boolean {
  if (!currentUrl || !currentUrl.trim()) {
    return true; // Not navigated yet
  }

  try {
    const currentHost = new URL(currentUrl).hostname.toLowerCase();
    const normPlatform = (accountPlatform || "").toLowerCase().trim();

    if (normPlatform === "facebook" || normPlatform === "fb") {
      return currentHost === "facebook.com" || currentHost.endsWith(".facebook.com");
    }
    if (normPlatform === "threads") {
      return currentHost === "threads.net" || currentHost.endsWith(".threads.net");
    }
    if (normPlatform === "instagram" || normPlatform === "ig") {
      return currentHost === "instagram.com" || currentHost.endsWith(".instagram.com");
    }
    if (normPlatform === "x" || normPlatform === "twitter") {
      return (
        currentHost === "x.com" ||
        currentHost.endsWith(".x.com") ||
        currentHost === "twitter.com" ||
        currentHost.endsWith(".twitter.com")
      );
    }
    if (normPlatform === "tiktok") {
      return currentHost === "tiktok.com" || currentHost.endsWith(".tiktok.com");
    }

    if (accountSiteUrl && accountSiteUrl.trim()) {
      try {
        let cleanSite = accountSiteUrl.trim();
        if (!/^https?:\/\//i.test(cleanSite)) cleanSite = `https://${cleanSite}`;
        const targetHost = new URL(cleanSite).hostname.toLowerCase();
        return currentHost === targetHost || currentHost.endsWith(`.${targetHost}`);
      } catch {
        // Fall through
      }
    }

    return true;
  } catch {
    return true;
  }
}
