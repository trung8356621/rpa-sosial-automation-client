import type { BrowserProfile, AccountInfo } from "../../shared/contracts.js";
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
    status: "present" | "absent" | "unknown";
    checked_at: string | null;
    method: "facebook_c_user_cookie" | "site_cookie_presence" | null;
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
  return profiles.map((p) => ({
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

  constructor(
    private readonly connection: ClientConnection,
    private readonly profileManager: ProfileManager
  ) {
    // Re-sync when connection comes online
    this.connection.onStateChange((state) => {
      if (state.status === "connected" && state.online && this.pendingSync) {
        logClientEvent("Connection restored, flushing pending browser sync");
        void this.syncAll();
      }
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
