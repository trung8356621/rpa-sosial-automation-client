import React, { useEffect, useState } from "react";
import type { ConnectionState } from "../../shared/contracts.js";
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
