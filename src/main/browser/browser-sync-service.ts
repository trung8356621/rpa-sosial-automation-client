import type { BrowserProfile } from "../../shared/contracts.js";
import type { ClientConnection } from "../connection/client-connection.js";
import type { ProfileManager } from "./profile-manager.js";
import { logClientError, logClientEvent } from "../main-error-log.js";

export interface CleanBrowserPayload {
  browser_id: string;
  name: string;
  platform: string;
  status: "stopped" | "running" | "error";
}

export function sanitizeProfilesForSync(profiles: BrowserProfile[]): CleanBrowserPayload[] {
  return profiles.map((p) => ({
    browser_id: p.browserId,
    name: p.name,
    platform: p.platform || "facebook",
    status: p.status,
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
