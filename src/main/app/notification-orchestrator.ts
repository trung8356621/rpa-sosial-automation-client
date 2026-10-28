import { Notification } from "electron";
import type { ClientNotification } from "../../shared/contracts.js";
import type { ClientConnection } from "../connection/client-connection.js";
import type { BrowserSyncService } from "../browser/browser-sync-service.js";
import { logClientError, logClientEvent } from "../main-error-log.js";

const POLL_INTERVAL_MS = 30_000;

function mapNotificationRow(row: Record<string, unknown>): ClientNotification | null {
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) return null;
  const type = row.type === "login_required" || row.type === "display_message" || row.type === "manual_intervention"
    ? row.type
    : "display_message";
  return {
    id,
    type,
    message: typeof row.message === "string" ? row.message.slice(0, 2000) : "",
    account_id: typeof row.account_id === "string" ? row.account_id : null,
    account_name: typeof row.account_name === "string" ? row.account_name : "Account",
    browser_id: typeof row.browser_id === "string" ? row.browser_id : null,
    task_id: typeof row.task_id === "number" ? row.task_id : null,
    created_at: typeof row.created_at === "string" ? row.created_at : null,
  };
}

function toastTitle(items: ClientNotification[]): string {
  if (items.length === 1) {
    const item = items[0];
    if (item.type === "login_required") return "Yêu cầu đăng nhập lại";
    if (item.type === "manual_intervention") return "Yêu cầu xử lý thủ công";
    return "Thông báo từ SEO-OPS";
  }
  return `${items.length} yêu cầu cần xử lý`;
}

function toastBody(items: ClientNotification[]): string {
  if (items.length === 1) {
    const item = items[0];
    const msg = item.message.replace(/\s+/g, " ").trim().slice(0, 160);
    return `${item.account_name}${msg ? `: ${msg}` : ""}`;
  }
  const names = items.slice(0, 3).map((item) => item.account_name);
  return names.join(", ") + (items.length > 3 ? "…" : "");
}

export class NotificationOrchestrator {
  /** UUIDs already shown via Windows toast (dedupe only). */
  private readonly toastedIds = new Set<string>();
  /** UUIDs the user marked Seen locally — never re-surface even if server lag. */
  private readonly dismissedIds = new Set<string>();
  /** ACK still owed to SEO-OPS after local dismiss. */
  private readonly pendingAckIds = new Set<string>();
  private readonly pending = new Map<string, ClientNotification>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private flushingAcks = false;
  private wasOnline = false;

  constructor(
    private readonly connection: ClientConnection,
    private readonly syncService: BrowserSyncService,
    private readonly showMainWindow: () => void,
    private readonly broadcast: (notifications: ClientNotification[]) => void,
  ) {
    this.connection.onStateChange((state) => {
      const online = state.status === "connected" && state.online;
      if (online && !this.wasOnline) {
        void this.poll("connect");
        void this.flushPendingAcks();
        this.startPeriodic();
      } else if (!online) {
        this.stopPeriodic();
      }
      this.wasOnline = online;
    });
  }

  startPeriodic(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll("interval");
    }, POLL_INTERVAL_MS);
  }

  stopPeriodic(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getPending(): ClientNotification[] {
    return [...this.pending.values()];
  }

  /**
   * Mark Seen: hide immediately, ACK in background (retry on reconnect).
   * Does not touch session signal / login confirmation / account state.
   */
  markSeen(notificationId: string): ClientNotification[] {
    this.dismissedIds.add(notificationId);
    this.pendingAckIds.add(notificationId);
    this.pending.delete(notificationId);
    const snapshot = this.getPending();
    this.broadcast(snapshot);
    void this.flushPendingAcks();
    return snapshot;
  }

  async flushPendingAcks(): Promise<void> {
    if (this.flushingAcks || !this.connection.isOnline() || this.pendingAckIds.size === 0) {
      return;
    }
    this.flushingAcks = true;
    try {
      for (const id of [...this.pendingAckIds]) {
        try {
          const ok = await this.syncService.acknowledgeNotification(id);
          this.pendingAckIds.delete(id);
          if (ok) {
            logClientEvent("Notification ACK sent", { notificationId: id });
          } else {
            logClientEvent("Notification ACK dropped (not found)", { notificationId: id });
          }
        } catch (err) {
          logClientError("Notification ACK failed; will retry after reconnect", err);
          // keep id in pendingAckIds
        }
      }
    } finally {
      this.flushingAcks = false;
    }
  }

  async poll(reason: string): Promise<ClientNotification[]> {
    if (!this.connection.isOnline()) {
      return this.getPending();
    }
    if (this.polling) {
      return this.getPending();
    }
    this.polling = true;
    try {
      const rows = await this.syncService.getNotifications();
      const mapped = rows
        .map((row) => mapNotificationRow(row))
        .filter((row): row is ClientNotification => row !== null);

      const nextIds = new Set(mapped.map((row) => row.id));
      for (const id of [...this.pending.keys()]) {
        if (!nextIds.has(id)) this.pending.delete(id);
      }

      const newcomers: ClientNotification[] = [];
      for (const item of mapped) {
        if (this.dismissedIds.has(item.id)) {
          // Still pending on server — keep hidden and ensure ACK is queued.
          this.pendingAckIds.add(item.id);
          continue;
        }
        this.pending.set(item.id, item);
        if (!this.toastedIds.has(item.id)) {
          this.toastedIds.add(item.id);
          newcomers.push(item);
        }
      }

      for (const id of [...this.dismissedIds]) {
        if (!nextIds.has(id) && !this.pendingAckIds.has(id)) {
          this.dismissedIds.delete(id);
        }
      }

      const snapshot = this.getPending();
      this.broadcast(snapshot);

      if (newcomers.length > 0) {
        logClientEvent("Remote notifications received", {
          reason,
          newCount: newcomers.length,
          pendingCount: snapshot.length,
        });
        // Aggregate backlog after restart / first sight; never spam one toast per UUID.
        this.alertUser(newcomers);
      }

      void this.flushPendingAcks();
      return snapshot;
    } catch (err) {
      logClientError("Failed to poll client notifications", err);
      return this.getPending();
    } finally {
      this.polling = false;
    }
  }

  private alertUser(items: ClientNotification[]): void {
    // Always restore/focus the existing window so the in-app notification center is visible.
    try {
      this.showMainWindow();
    } catch (err) {
      logClientError("Failed to show main window for notification", err);
    }

    if (!Notification.isSupported()) {
      return;
    }

    try {
      const notification = new Notification({
        title: toastTitle(items),
        body: toastBody(items),
        silent: false,
      });
      notification.on("click", () => {
        try {
          this.showMainWindow();
        } catch (err) {
          logClientError("Failed to focus window from notification click", err);
        }
      });
      notification.show();
    } catch (err) {
      // Native toast failure must not block bringing the app up (already attempted above).
      logClientError("Native Windows notification failed", err);
    }
  }

  destroy(): void {
    this.stopPeriodic();
  }
}
