import type { BrowserProfile, AccountInfo } from "../../shared/contracts.js";
import type { AccountDetail } from "../../shared/contracts.js";
import type { ClientConnection } from "../connection/client-connection.js";
import type { ProfileManager } from "./profile-manager.js";
import { logClientError, logClientEvent } from "../main-error-log.js";

export interface TargetBrowserPayload {
  browser_id: string;
  name: string;
  platform: string;
  status: "stopped" | "running" | "error";
  runtime: {
    status: "stopped" | "running" | "error";
  };
  account_binding: {
    account_id: string | null;
    bound_at: string | null;
    account_name?: string;
  };
  session_signal: {
    status: "present" | "absent" | "unsupported" | "error" | "unknown";
    checked_at: string | null;
    method: "facebook_c_user_cookie" | "wordpress_auth_cookie" | "site_cookie_presence" | null;
  };
  execution_confirmation: {
    status: "not_run" | "pending_review" | "confirmed" | "failed";
    first_run_at?: string | null;
    last_success_at?: string | null;
    last_run_id?: string | null;
    screenshot_ref?: string | null;
  };
}

export function sanitizeProfilesForSync(profiles: BrowserProfile[]): TargetBrowserPayload[] {
  return profiles.filter((p) => Boolean(p.accountBinding?.accountId) && p.sessionSignal?.status === "present").map((p) => ({
    browser_id: p.browserId,
    name: p.name,
    platform: p.platform || "facebook",
    status: p.status,
    runtime: { status: p.status },
    account_binding: p.accountBinding
      ? {
          account_id: p.accountBinding.accountId,
          bound_at: p.accountBinding.boundAt,
          account_name: p.accountBinding.accountName,
        }
      : { account_id: null, bound_at: null },
    session_signal: p.sessionSignal
      ? {
          status: p.sessionSignal.status,
          checked_at: p.sessionSignal.checkedAt,
          method: p.sessionSignal.method,
        }
      : { status: "unknown", checked_at: null, method: null },
    execution_confirmation: p.executionConfirmation
      ? {
          status: p.executionConfirmation.status,
          first_run_at: p.executionConfirmation.firstRunAt ?? null,
          last_success_at: p.executionConfirmation.lastSuccessAt ?? null,
          last_run_id: p.executionConfirmation.lastRunId ?? null,
          screenshot_ref: p.executionConfirmation.screenshotRef ?? null,
        }
      : {
          status: "not_run",
          first_run_at: null,
          last_success_at: null,
          last_run_id: null,
          screenshot_ref: null,
        },
  }));
}

export class BrowserSyncService {
  private pendingSync = false;
  private syncing = false;
  private wasOnline = false;

  constructor(
    private readonly connection: ClientConnection,
    private readonly profileManager: ProfileManager,
    private readonly onProfilesRefreshed?: () => void,
  ) {
    // Re-sync when connection comes online
    this.connection.onStateChange((state) => {
      const online = state.status === "connected" && state.online;
      if (online && (!this.wasOnline || this.pendingSync)) {
        logClientEvent("Connection available, synchronizing eligible browser sessions");
        void this.syncAll();
      }
      this.wasOnline = online;
    });
  }

  async getAccounts(platform?: string): Promise<AccountInfo[]> {
    if (!this.connection.isOnline()) {
      return [];
    }

    try {
      const qs = platform ? `?platform=${encodeURIComponent(platform)}` : "";
      const res = await this.connection.requestWithAuth(`/api/v1/social-automation/client/accounts${qs}`, "GET");
      if (res && res.ok && Array.isArray(res.accounts)) {
        return (res.accounts as Array<Record<string, unknown>>).map((a) => ({
          accountId: String(a.account_id),
          platform: String(a.platform),
          displayName: String(a.display_name),
          username: a.username ? String(a.username) : null,
          email: a.email ? String(a.email) : null,
          siteUrl: a.site_url ? String(a.site_url) : null,
          hasPassword: Boolean(a.has_password),
          identityLabel: a.identity_label ? String(a.identity_label) : null,
          verified: Boolean(a.verified),
        }));
      }
      return [];
    } catch (err) {
      logClientError("Failed to fetch bindable accounts from SEO-OPS", err);
      return [];
    }
  }

  async getAccount(accountId: string): Promise<AccountDetail> {
    const res = await this.connection.requestWithAuth(
      `/api/v1/social-automation/client/accounts/${encodeURIComponent(accountId)}`,
      "GET"
    );
    const a = res.account as Record<string, unknown>;
    return {
      accountId: String(a.account_id),
      platform: String(a.platform),
      displayName: String(a.display_name),
      username: null,
      email: a.email ? String(a.email) : null,
      siteUrl: a.site_url ? String(a.site_url) : null,
      hasPassword: a.password_status === "available" || a.password_status === "forbidden",
      passwordStatus: String(a.password_status) as AccountDetail["passwordStatus"],
      identityLabel: null,
      verified: false,
    };
  }

  async getAccountPassword(accountId: string): Promise<string> {
    const res = await this.connection.requestWithAuth(
      `/api/v1/social-automation/client/accounts/${encodeURIComponent(accountId)}/password`,
      "GET"
    );
    if (typeof res.password !== "string") throw new Error("Password response is invalid");
    return res.password;
  }

  async getAccountEmail(accountId: string): Promise<string> {
    const account = await this.getAccount(accountId);
    if (!account.email) throw new Error("Account chưa có email");
    return account.email;
  }

  async getNotifications(): Promise<Array<Record<string, unknown>>> {
    if (!this.connection.isOnline()) return [];
    const res = await this.connection.requestWithAuth("/api/v1/social-automation/client/notifications", "GET");
    return Array.isArray(res.notifications) ? res.notifications as Array<Record<string, unknown>> : [];
  }

  async acknowledgeNotification(notificationId: string): Promise<boolean> {
    const res = await this.connection.requestWithAuth(
      `/api/v1/social-automation/client/notifications/${encodeURIComponent(notificationId)}/ack`, "POST", {}
    );
    return Boolean(res.acked);
  }

  async refreshAccountMetadata(): Promise<void> {
    if (!this.connection.isOnline()) return;
    for (const profile of this.profileManager.list()) {
      const accountId = profile.accountBinding?.accountId;
      if (!accountId) continue;
      try {
        await this.profileManager.refreshAccountMetadata(profile.browserId, await this.getAccount(accountId));
      } catch (err) {
        logClientError("Unable to refresh Account metadata", err);
      }
    }
    this.onProfilesRefreshed?.();
  }

  async syncAll(): Promise<boolean> {
    if (this.syncing) {
      this.pendingSync = true;
      return false;
    }

    if (!this.connection.isOnline()) {
      this.pendingSync = true;
      logClientEvent("Client offline: browser sync queued for reconnection");
      return false;
    }

    this.syncing = true;
    try {
      await this.refreshAccountMetadata();
      const profiles = this.profileManager.list();
      const browsers = sanitizeProfilesForSync(profiles);
      const deviceId = this.connection.getDeviceId();

      const response = await this.connection.requestWithAuth(
        "/api/v1/social-automation/client/browser-sync",
        "POST",
        {
          device_id: deviceId,
          browsers,
        }
      );

      if (response && response.ok) {
        this.pendingSync = false;
        logClientEvent("Synced browser sessions to SEO-OPS successfully", {
          syncedCount: (response.browsers as unknown[])?.length ?? browsers.length,
        });
        return true;
      }

      logClientError("SEO-OPS browser sync returned non-ok response", response);
      this.pendingSync = true;
      return false;
    } catch (err) {
      this.pendingSync = true;
      logClientError("Failed to sync browser sessions to SEO-OPS", err);
      return false;
    } finally {
      this.syncing = false;
    }
  }

  async deleteRemote(browserId: string): Promise<boolean> {
    if (!this.connection.isOnline()) {
      logClientEvent("Client offline: skipped remote browser session deletion", { browserId });
      return false;
    }

    try {
      const deviceId = this.connection.getDeviceId();
      const res = await this.connection.requestWithAuth(
        "/api/v1/social-automation/client/browser-delete",
        "POST",
        {
          device_id: deviceId,
          browser_id: browserId,
        }
      );
      return Boolean(res && res.ok);
    } catch (err) {
      logClientError("Failed to delete remote browser session on SEO-OPS", err);
      return false;
    }
  }
}
