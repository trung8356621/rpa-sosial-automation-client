import React, { useEffect, useState } from "react";
import type { ClientNotification, ConnectionState } from "../../shared/contracts.js";
import { DeviceStatusPanel } from "./device-status-panel.js";
import { ConnectionSettingsPanel } from "./connection-settings-panel.js";
import { BrowserProfilesPanel } from "./browser-profiles-panel.js";
import { BrowserWorkspacePanel } from "./browser-workspace-panel.js";

type Tab = "profiles" | "browser" | "status" | "settings" | "logs";

interface LogEntry {
  time: string;
  level: string;
  message: string;
}

export function AppShell() {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("profiles");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<ClientNotification[]>([]);

  const refreshState = async () => {
    try {
      const next = await window.client.invoke<ConnectionState>({ type: "getConnectionState" });
      setState(next);
    } catch {
      // ignore
    }
  };

  const showNotification = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((curr) => (curr === msg ? null : curr));
    }, 3500);
  };

  useEffect(() => {
    void refreshState();

    const unsubState = window.client.onStateChange((next) => {
      setState(next);
    });

    const unsubLog = window.client.onLog((entry) => {
      setLogs((prev) => [entry, ...prev.slice(0, 99)]);
    });

    return () => {
      unsubState();
      unsubLog();
    };
  }, []);

  useEffect(() => {
    if (!(state?.status === "connected" && state.online)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const rows = await window.client.invoke<ClientNotification[]>({ type: "getNotifications" });
        if (!cancelled) setNotifications(rows);
      } catch { /* retry on next heartbeat interval */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [state?.status, state?.online]);

  const acknowledgeNotification = async (id: string) => {
    const acked = await window.client.invoke<boolean>({ type: "ackNotification", notificationId: id });
    if (acked) {
      setNotifications((rows) => rows.filter((row) => row.id !== id));
      showNotification("Đã xác nhận xử lý; trạng thái Session không tự thay đổi");
    } else {
      showNotification("Không thể gửi xác nhận. Thông báo vẫn được giữ lại.");
    }
  };

  const openNotificationBrowser = async (item: ClientNotification) => {
    if (!item.browser_id) {
      showNotification("Thông báo không có Browser hợp lệ.");
      return;
    }
    try {
      await window.client.invoke({ type: "openBrowser", browserId: item.browser_id });
      setActiveTab("browser");
    } catch (error) {
      showNotification(error instanceof Error ? error.message : "Không thể mở Browser.");
    }
  };

  if (!state) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#64748b" }}>
        Đang khởi động RPA Client...
      </div>
    );
  }

  const isOnline = state.status === "connected" && state.online;
  const isConnecting = state.status === "connecting";

  return (
    <>
      <header className="app-header">
        <div className="header-brand">
          <div className="brand-icon">RC</div>
          <div>
            <div className="brand-title">RPA Client V2</div>
            <div className="brand-subtitle">Execution Agent</div>
          </div>
        </div>

        <div className="header-actions">
          {toast && <div className="toast-pill">{toast}</div>}
          <div
            className={`status-pill ${
              isOnline ? "online" : isConnecting ? "connecting" : state.status === "error" ? "error" : "offline"
            }`}
          >
            <span className="status-dot"></span>
            {isOnline
              ? "Online"
              : isConnecting
                ? "Đang kết nối..."
                : state.status === "error"
                  ? "Lỗi kết nối"
                  : "Offline"}
          </div>
        </div>
      </header>

      <div className="app-body">
        <aside className="nav-sidebar">
          <button
            type="button"
            className={`nav-item ${activeTab === "profiles" ? "active" : ""}`}
            onClick={() => setActiveTab("profiles")}
          >
            🌐 Browser Profiles
          </button>
          <button
            type="button"
            className={`nav-item ${activeTab === "browser" ? "active" : ""}`}
            onClick={() => setActiveTab("browser")}
          >
            💻 Browser
          </button>
          <button
            type="button"
            className={`nav-item ${activeTab === "status" ? "active" : ""}`}
            onClick={() => setActiveTab("status")}
          >
            🖥️ Trạng thái thiết bị
          </button>
          <button
            type="button"
            className={`nav-item ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            ⚙️ Cấu hình kết nối
          </button>
          <button
            type="button"
            className={`nav-item ${activeTab === "logs" ? "active" : ""}`}
            onClick={() => setActiveTab("logs")}
          >
            📋 Nhật ký hoạt động
          </button>
        </aside>

        <main className={`main-content ${activeTab === "browser" ? "browser-active" : ""}`}>
          {notifications.length > 0 && (
            <section className="notification-center" aria-label="Notification center">
              <div className="notification-center-title">Yêu cầu cần xử lý ({notifications.length})</div>
              {notifications.map((item) => (
                <article key={item.id} className="notification-item">
                  <div className="notification-copy">
                    <strong>{item.type === "login_required" ? "Yêu cầu đăng nhập lại" : "Yêu cầu xử lý"} · {item.account_name}</strong>
                    <span>{item.message}</span>
                  </div>
                  <div className="notification-actions">
                    <button type="button" className="btn btn-secondary" disabled={!item.browser_id} onClick={() => void openNotificationBrowser(item)}>Mở Browser</button>
                    <button type="button" className="btn btn-primary" onClick={() => void acknowledgeNotification(item.id)}>Đã xử lý</button>
                  </div>
                </article>
              ))}
            </section>
          )}
          <div style={{ display: activeTab === "profiles" ? "block" : "none" }}>
            <BrowserProfilesPanel
              onNotify={showNotification}
              onOpenBrowser={(_browserId) => setActiveTab("browser")}
            />
          </div>

          <div
            style={{
              display: activeTab === "browser" ? "flex" : "none",
              flexDirection: "column",
              height: "100%",
              width: "100%",
            }}
          >
            <BrowserWorkspacePanel
              isActiveTab={activeTab === "browser"}
              onNavigateToProfiles={() => setActiveTab("profiles")}
              onNotify={showNotification}
            />
          </div>

          {activeTab === "status" && (
            <>
              <DeviceStatusPanel state={state} onUpdate={refreshState} />
              <ConnectionSettingsPanel state={state} onUpdate={refreshState} />
            </>
          )}

          {activeTab === "settings" && (
            <ConnectionSettingsPanel state={state} onUpdate={refreshState} />
          )}

          {activeTab === "logs" && (
            <div className="card">
              <div className="card-title">Nhật ký hoạt động (Client Logs)</div>
              <div className="card-desc">
                Nhật ký vận hành cục bộ. Thông tin bảo mật (API Key) được lọc tự động trước khi ghi.
              </div>
              <div className="log-card" style={{ maxHeight: 520 }}>
                {logs.length === 0 ? (
                  <div style={{ color: "#475569" }}>Chưa có log mới</div>
                ) : (
                  logs.map((l, i) => (
                    <div key={i} className={`log-entry ${l.level}`}>
                      <span style={{ color: "#64748b" }}>[{l.time.slice(11, 19)}]</span> {l.message}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
